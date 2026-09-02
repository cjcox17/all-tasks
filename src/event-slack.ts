/**
 * event-slack: the Slack Events API event source. Verifies the
 * X-Slack-Signature (HMAC-SHA256 over `v0:<ts>:<body>`), answers the one-time
 * URL-verification challenge, and maps an event_callback message into a task.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { EventMapping, EventRequest, EventSource, EventSourceResponse } from './core/events.ts'

export const SLACK_EVENT_ID = 'slack'
export const SLACK_EVENT_PATH = '/api/all-tasks/events/slack'

const PROMPT_LIMIT = 64 * 1024
const TITLE_LIMIT = 256
const REPLAY_TOLERANCE_SECONDS = 300

export interface SlackEventConfig {
  /** Env var holding the Slack signing secret. */
  signingSecretEnv?: string
  /** Default workspace for created tasks. */
  workspaceId?: string
  /** Run the created task immediately (false = backlog). */
  autoRun?: boolean
}

function hexEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function createSlackEventSource(config: SlackEventConfig = {}, env: NodeJS.ProcessEnv = process.env): EventSource {
  return {
    id: SLACK_EVENT_ID,
    method: 'POST',
    path: SLACK_EVENT_PATH,
    verify(request, rawBody) {
      const secretEnv = config.signingSecretEnv?.trim()
      if (secretEnv === undefined || secretEnv === '') return true
      const secret = env[secretEnv]
      if (secret === undefined || secret === '') return true
      const signature = stringHeader(request.headers['x-slack-signature'])
      const timestamp = stringHeader(request.headers['x-slack-request-timestamp'])
      if (signature === undefined || !signature.startsWith('v0=') || timestamp === undefined) return false
      const ts = Number(timestamp)
      if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > REPLAY_TOLERANCE_SECONDS) return false
      const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
      return hexEqual(signature.slice(3), expected.slice(3))
    },
    respond(body): EventSourceResponse | undefined {
      const record = asRecord(body)
      if (record.type !== 'url_verification') return undefined
      if (typeof record.challenge !== 'string') return { status: 400, body: { error: 'missing challenge' } }
      return { status: 200, body: { challenge: record.challenge } }
    },
    map(_request, body) {
      const record = asRecord(body)
      const inner = record.type === 'event_callback' ? asRecord(record.event) : record
      const text = typeof inner.text === 'string' ? inner.text : undefined
      const channel = typeof inner.channel === 'string' ? inner.channel : undefined
      const user = typeof inner.user === 'string' ? inner.user : undefined
      const title = `Slack message${channel !== undefined ? ` in ${channel}` : ''}${user !== undefined ? ` from ${user}` : ''}`.slice(0, TITLE_LIMIT)
      const prompt = text ?? JSON.stringify(record, null, 2)
      const bounded = prompt.length > PROMPT_LIMIT ? `${prompt.slice(0, PROMPT_LIMIT)}…` : prompt
      const mapping: EventMapping = {
        input: {
          title,
          description: '',
          prompt: bounded,
          source: 'event' as const,
          ...(config.workspaceId === undefined || config.workspaceId === '' ? {} : { workspaceId: config.workspaceId }),
        },
        autoRun: config.autoRun === true,
      }
      return mapping
    },
  }
}
