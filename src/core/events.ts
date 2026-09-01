/**
 * Events framework: the inbound-trigger contract and its registry. An event
 * source is a thin plugin that owns one HTTP route, verifies the request, and
 * maps the verified payload into task-creation input. Pure and framework-free;
 * the Host route layer adapts `IncomingMessage` to the structural `EventRequest`.
 */
import type { NewTaskInput } from './tasks.ts'

/** Structural request view (the Host adapts `IncomingMessage` to this). */
export interface EventRequest {
  method: string
  url: string
  headers: Readonly<Record<string, string | string[] | undefined>>
}

/** What one verified event becomes: task input plus launch/cooldown policy. */
export interface EventMapping {
  input: NewTaskInput
  /** Run immediately, or land in the backlog for review. */
  autoRun: boolean
  /** Idempotency/cooldown key (e.g. a delivery id or payload hash). */
  dedupeKey?: string
}

/** A direct, non-task response an event source may produce (e.g. a Slack URL-verification challenge). */
export interface EventSourceResponse {
  status: number
  body: unknown
}

/** One inbound event source (a webhook plugin). */
export interface EventSource {
  /** Stable plugin id (e.g. `github`, `http`). */
  id: string
  method: 'POST' | 'GET'
  /** Route path under the all-tasks prefix (e.g. `/api/all-tasks/events/github`). */
  path: string
  /** Verify the raw request (signature/token). Fail closed: return false to reject. */
  verify(request: EventRequest, rawBody: string): boolean | Promise<boolean>
  /** Map the verified body into task creation input. */
  map(request: EventRequest, body: unknown): EventMapping | Promise<EventMapping>
  /** Optional direct response that short-circuits task creation. */
  respond?(body: unknown): EventSourceResponse | undefined
}

export class EventSourceRegistry {
  private readonly sources = new Map<string, EventSource>()
  private readonly routes = new Set<string>()

  register(source: EventSource): void {
    if (this.sources.has(source.id)) throw new Error(`event source ${source.id} is already registered`)
    const route = `${source.method.toUpperCase()} ${source.path}`
    if (this.routes.has(route)) throw new Error(`event route ${route} is already registered`)
    this.sources.set(source.id, source)
    this.routes.add(route)
  }

  get(id: string): EventSource | undefined {
    return this.sources.get(id)
  }

  all(): EventSource[] {
    return [...this.sources.values()]
  }
}
