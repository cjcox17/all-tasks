import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ActionRegistry } from './core/actions.ts'
import type { EventRequest, EventSourceRegistry } from './core/events.ts'
import { parseEndpointEditorPatch } from './endpoint-editor.ts'
import type { AllTasksHostService } from './host-service.ts'
import { writeJson } from './http.ts'
import { buildIntegrationsSnapshot, type IntegrationsConfigSource } from './integrations-status.ts'
import { isLoopbackAddress, isLoopbackRequest } from './loopback.ts'
import { parseActionEnvelope, ALL_TASKS_API_PREFIX } from './protocol.ts'
import { parseTitleSuggestionRequest } from './title-suggest.ts'

const ACTION_LIMIT = 64 * 1024
const IMPORT_LIMIT = 2 * 1024 * 1024
const HEARTBEAT_MS = 15_000

/** Header replaced by an authenticated same-host reverse proxy. */
export const ALL_TASKS_PROXY_TOKEN_HEADER = 'x-dsh-all-tasks-proxy-token'

/** Optional authenticated reverse-proxy access layered over the loopback default. */
export interface AllTasksRouteAccess {
  trustedProxyHosts?: readonly string[]
  proxyToken?: string
}

interface ResolvedRouteAccess {
  trustedProxyHosts: ReadonlySet<string>
  proxyToken?: string
}

function parseAuthority(authority: string): { canonical: string; url: URL } | undefined {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL(`http://${authority}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65_535)) return undefined
    return { canonical: url.hostname.toLowerCase() + (rawPort === undefined ? '' : `:${rawPort}`), url }
  } catch {
    return undefined
  }
}

function resolveAccess(access: AllTasksRouteAccess): ResolvedRouteAccess {
  const trustedProxyHosts = new Set<string>()
  for (const authority of access.trustedProxyHosts ?? []) {
    const parsed = parseAuthority(authority)
    if (parsed === undefined || parsed.canonical !== authority.toLowerCase()) {
      throw new Error(`all-tasks: trustedProxyHosts entry ${JSON.stringify(authority)} is not a canonical host[:port] authority`)
    }
    trustedProxyHosts.add(parsed.canonical)
  }
  if (trustedProxyHosts.size > 0 && (access.proxyToken === undefined || access.proxyToken === '')) {
    throw new Error('all-tasks: authenticated proxy hosts require a non-empty proxy token')
  }
  return { trustedProxyHosts, ...(access.proxyToken === undefined ? {} : { proxyToken: access.proxyToken }) }
}

/**
 * Browser-signal tripwire, NOT an authority check: a bare curl sends neither
 * header and is refused, but a curl with a forged Origin passes this too.
 * The real boundary is the loopback socket + Host + origin-equality checks
 * in isTrustedAllTasksRequest below; do not rely on this marker alone.
 */
function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

function sameAuthority(req: IncomingMessage, host: URL): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return req.headers['sec-fetch-site'] === 'same-origin'
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}

function matchesToken(candidate: string | string[] | undefined, expected: string | undefined): boolean {
  if (typeof candidate !== 'string' || expected === undefined || candidate === '' || expected === '') return false
  const actual = Buffer.from(candidate)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

/**
 * All-tasks route fence. Direct desktop access uses the repository-wide
 * loopback socket + Host guard and additionally requires a browser same-origin
 * marker: a bare local curl without any browser signal cannot exercise the
 * agent control plane (a forged Origin does pass the marker — it is a
 * tripwire, the socket/Host/origin-equality checks carry the authority).
 * Authenticated proxies must be explicitly allowlisted and replace the
 * internal token header after their own authentication step.
 */
export function isTrustedAllTasksRequest(req: IncomingMessage, access: ResolvedRouteAccess): boolean {
  if (!browserSameOriginMarker(req)) return false
  if (isLoopbackRequest(req)) return true
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.canonical !== host.toLowerCase()) return false
  if (!access.trustedProxyHosts.has(parsed.canonical) || !sameAuthority(req, parsed.url)) return false
  return matchesToken(req.headers[ALL_TASKS_PROXY_TOKEN_HEADER], access.proxyToken)
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; value: unknown }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > IMPORT_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return { raw, value: JSON.parse(raw) }
}

export function makeAllTasksRoutes(service: AllTasksHostService, access: AllTasksRouteAccess = {}): WebRoute[] {
  const resolvedAccess = resolveAccess(access)
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (isTrustedAllTasksRequest(req, resolvedAccess)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' }, { 'cache-control': 'no-store' })
    return false
  }
  const state: WebRoute = {
    kind: 'exact',
    path: `${ALL_TASKS_API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      writeJson(res, 200, service.snapshot(), { 'cache-control': 'no-store' })
    },
  }
  const action: WebRoute = {
    kind: 'exact',
    path: `${ALL_TASKS_API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: 'json-required' }, { 'cache-control': 'no-store' })
      }
      try {
        const body = await readBody(req)
        const parsed = parseActionEnvelope(body.value)
        if (parsed === undefined) return writeJson(res, 400, { ok: false, error: 'invalid-action' }, { 'cache-control': 'no-store' })
        if (parsed.action.kind !== 'import' && Buffer.byteLength(body.raw) > ACTION_LIMIT) {
          return writeJson(res, 413, { ok: false, error: 'body-too-large' }, { 'cache-control': 'no-store' })
        }
        writeJson(res, 200, service.apply(parsed.requestId, parsed.action), { 'cache-control': 'no-store' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message }, { 'cache-control': 'no-store' })
      }
    },
  }
  const events: WebRoute = {
    kind: 'exact',
    path: `${ALL_TASKS_API_PREFIX}/events`,
    handler: (req, res): void => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!guard(req, res)) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const push = (): void => {
        const payload = service.eventPayload()
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS)
      const close = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      req.once('close', close)
      res.once('close', close)
      push()
    },
  }
  const endpoints: WebRoute = {
    kind: 'exact',
    path: `${ALL_TASKS_API_PREFIX}/endpoints`,
    handler: async (req, res): Promise<void> => {
      if (req.method === 'GET') {
        if (!guard(req, res)) return
        const state = service.endpoints()
        writeJson(res, 200, {
          endpoints: state.endpoints,
          defaultEndpoints: state.defaultEndpoints,
          // Known provider routes (llm-pi-ai dict keys + the official route)
          // with their model lists and effective timeouts, offered so the
          // editor's provider select limits models/default model and prefills
          // the per-endpoint timeout fields.
          providers: service.endpointProviders(),
        }, { 'cache-control': 'no-store' })
        return
      }
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: 'json-required' }, { 'cache-control': 'no-store' })
      }
      try {
        const body = await readBody(req)
        const state = parseEndpointEditorPatch(body.value)
        const stored = await service.applyEndpoints(state)
        writeJson(res, 200, { endpoints: stored.endpoints, defaultEndpoints: stored.defaultEndpoints }, { 'cache-control': 'no-store' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message }, { 'cache-control': 'no-store' })
      }
    },
  }
  const titleSuggest: WebRoute = {
    kind: 'exact',
    path: `${ALL_TASKS_API_PREFIX}/title-suggest`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: 'json-required' }, { 'cache-control': 'no-store' })
      }
      try {
        const body = await readBody(req)
        if (Buffer.byteLength(body.raw) > ACTION_LIMIT) {
          return writeJson(res, 413, { ok: false, error: 'body-too-large' }, { 'cache-control': 'no-store' })
        }
        const request = parseTitleSuggestionRequest(body.value)
        if (request === undefined) {
          return writeJson(res, 400, { ok: false, error: 'invalid-title-request' }, { 'cache-control': 'no-store' })
        }
        const title = await service.suggestTitle(request)
        if (title === undefined) {
          return writeJson(res, 422, { ok: false, error: 'title-unavailable' }, { 'cache-control': 'no-store' })
        }
        writeJson(res, 200, { title }, { 'cache-control': 'no-store' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message }, { 'cache-control': 'no-store' })
      }
    },
  }
  return [state, action, events, endpoints, titleSuggest]
}

const EVENT_COOLDOWN_MS = 60_000

/**
 * Mount the read-only Events/Actions status route (the two sidebar panels'
 * data source) under the same loopback / authenticated-proxy fence as the
 * browser routes. The snapshot is built per request from the live registries
 * and the resolved config, so a settings edit or a plugin change is reflected
 * without a restart.
 */
export function makeIntegrationsRoutes(
  events: EventSourceRegistry,
  actions: ActionRegistry,
  getConfig: () => IntegrationsConfigSource | undefined,
  access: AllTasksRouteAccess = {},
): WebRoute[] {
  const resolvedAccess = resolveAccess(access)
  const status: WebRoute = {
    kind: 'exact',
    path: `${ALL_TASKS_API_PREFIX}/integrations`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      if (!isTrustedAllTasksRequest(req, resolvedAccess)) {
        return writeJson(res, 403, { ok: false, error: 'forbidden' }, { 'cache-control': 'no-store' })
      }
      writeJson(res, 200, buildIntegrationsSnapshot(events, actions, getConfig), { 'cache-control': 'no-store' })
    },
  }
  return [status]
}

/**
 * Mount one HTTP route per registered event source under the same loopback /
 * authenticated-proxy fence as the browser routes, plus the source's own
 * verification. A verified event is mapped to task creation and — when the
 * source opts in — an immediate run, with a short dedupe/cooldown window so a
 * retried webhook does not create duplicate tasks.
 */
export function makeEventRoutes(
  registry: EventSourceRegistry,
  service: AllTasksHostService,
  access: AllTasksRouteAccess = {},
): WebRoute[] {
  const resolvedAccess = resolveAccess(access)
  const cooldown = new Map<string, number>()
  return registry.all().map(source => ({
    kind: 'exact' as const,
    path: source.path,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== source.method) {
        return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, { 'cache-control': 'no-store' })
      }
      if (!isTrustedAllTasksRequest(req, resolvedAccess)) {
        return writeJson(res, 403, { ok: false, error: 'forbidden' }, { 'cache-control': 'no-store' })
      }
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: 'json-required' }, { 'cache-control': 'no-store' })
      }
      try {
        const body = await readBody(req)
        const requestView: EventRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers }
        if (!await source.verify(requestView, body.raw)) {
          return writeJson(res, 401, { ok: false, error: 'unauthorized' }, { 'cache-control': 'no-store' })
        }
        const direct = source.respond?.(body.value)
        if (direct !== undefined) {
          return writeJson(res, direct.status, direct.body, { 'cache-control': 'no-store' })
        }
        const mapping = await source.map(requestView, body.value)
        if (mapping.dedupeKey !== undefined) {
          const last = cooldown.get(mapping.dedupeKey)
          const nowMs = Date.now()
          if (last !== undefined && nowMs - last < EVENT_COOLDOWN_MS) {
            return writeJson(res, 200, { ok: true, deduped: true }, { 'cache-control': 'no-store' })
          }
          cooldown.set(mapping.dedupeKey, nowMs)
        }
        const taskId = randomUUID()
        service.apply(`event-create-${taskId}`, { kind: 'create', id: taskId, input: mapping.input })
        if (mapping.autoRun) service.apply(`event-run-${taskId}`, { kind: 'run', taskId })
        writeJson(res, 200, { ok: true, taskId, autoRun: mapping.autoRun }, { 'cache-control': 'no-store' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = message === 'body-too-large' ? 413 : 400
        writeJson(res, status, { ok: false, error: message }, { 'cache-control': 'no-store' })
      }
    },
  }))
}
