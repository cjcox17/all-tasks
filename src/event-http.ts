/**
 * event-http: the generic inbound webhook event source. The universal funnel —
 * any bridge (Signal/Telegram/email shim, n8n, curl) can POST JSON here to
 * create (and optionally run) a task. Auth is a shared token resolved from an
 * environment variable (never stored in config); an absent token relies on the
 * loopback route fence alone as the boundary.
 */
import { timingSafeEqual } from 'node:crypto'
import type { EventMapping, EventRequest, EventSource } from './core/events.ts'

export const HTTP_EVENT_ID = 'http'
export const HTTP_EVENT_PATH = '/api/all-tasks/events/http'
export const HTTP_EVENT_TOKEN_HEADER = 'x-dsh-events-token'
export const HTTP_EVENT_DEDUPE_HEADER = 'x-dsh-event-id'

const PROMPT_LIMIT = 64 * 1024
const TITLE_LIMIT = 256

export interface HttpEventConfig {
  /** Env var holding the shared webhook token; blank = rely on the loopback fence. */
  tokenEnv?: string
  /** Default workspace the created task runs in; blank = recent-workspace fallback. */
  workspaceId?: string
  /** Run the created task immediately (false = land in backlog for review). */
  autoRun?: boolean
}

function tokenMatches(candidate: string | undefined, expected: string | undefined): boolean {
  if (candidate === undefined || expected === undefined || candidate === '' || expected === '') return false
  const actual = Buffer.from(candidate)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body
  if (body === undefined || body === null) return ''
  const text = JSON.stringify(body, null, 2)
  return text.length > PROMPT_LIMIT ? `${text.slice(0, PROMPT_LIMIT)}…` : text
}

function bodyTitle(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    for (const key of ['title', 'name', 'event', 'type']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') {
        const trimmed = value.trim()
        return trimmed.length > TITLE_LIMIT ? `${trimmed.slice(0, TITLE_LIMIT)}…` : trimmed
      }
    }
  }
  return fallback
}

export function createHttpEventSource(config: HttpEventConfig = {}, env: NodeJS.ProcessEnv = process.env): EventSource {
  return {
    id: HTTP_EVENT_ID,
    method: 'POST',
    path: HTTP_EVENT_PATH,
    verify(request) {
      const tokenEnv = config.tokenEnv?.trim()
      if (tokenEnv === undefined || tokenEnv === '') return true
      const token = env[tokenEnv]
      if (token === undefined || token === '') return true
      const bearer = stringHeader(request.headers.authorization)
      const candidate = bearer?.startsWith('Bearer ') ? bearer.slice(7) : stringHeader(request.headers[HTTP_EVENT_TOKEN_HEADER])
      return tokenMatches(candidate, token)
    },
    map(request, body) {
      // Event-created tasks carry the `event` origin so the board can show
      // where they came from. The origin is informational only: it never
      // changes the task's approval state.
      const input = {
        title: bodyTitle(body, 'Webhook event'),
        description: '',
        prompt: bodyText(body),
        source: 'event' as const,
        ...(config.workspaceId === undefined || config.workspaceId.trim() === '' ? {} : { workspaceId: config.workspaceId.trim() }),
      }
      const dedupeKey = stringHeader(request.headers[HTTP_EVENT_DEDUPE_HEADER])
      const mapping: EventMapping = {
        input,
        autoRun: config.autoRun === true,
        ...(dedupeKey === undefined ? {} : { dedupeKey }),
      }
      return mapping
    },
  }
}
