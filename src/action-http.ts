/**
 * action-http: the generic outbound settlement webhook. POSTs the settled
 * execution payload to a configured URL. The config arrives per-dispatch via
 * the dispatcher's `ActionContext.config`, so the URL and token are read fresh
 * on every settle (no restart needed to change them).
 */
import type { Action } from './core/actions.ts'

export const HTTP_ACTION_ID = 'http'

export interface HttpActionConfig {
  /** Target URL; blank disables the action. */
  url?: string
  /** Env var holding a bearer token for the outbound POST; blank = none. */
  tokenEnv?: string
}

export interface HttpActionDeps {
  fetchFn?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/** Minimal outbound-URL gate: http(s) only, no embedded credentials. */
function safeUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  return url.toString()
}

export function createHttpAction(deps: HttpActionDeps = {}): Action {
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  return {
    id: HTTP_ACTION_ID,
    when: ['always'],
    async run(ctx) {
      const config = (ctx.config ?? {}) as HttpActionConfig
      const raw = config.url?.trim()
      if (raw === undefined || raw === '') return
      const url = safeUrl(raw)
      if (url === undefined) throw new Error(`action http: unsafe URL ${JSON.stringify(config.url)}`)
      const tokenEnv = config.tokenEnv?.trim()
      const token = tokenEnv === undefined || tokenEnv === '' ? undefined : env[tokenEnv]
      const payload = {
        taskId: ctx.task.id,
        title: ctx.task.title,
        executionId: ctx.execution.id,
        status: ctx.execution.result,
        summary: ctx.execution.summary,
        error: ctx.execution.error,
        sessionId: ctx.sessionId,
        settledAt: now(),
      }
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`action http POST ${url} returned ${response.status}`)
    },
  }
}
