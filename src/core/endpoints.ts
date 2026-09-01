/**
 * Endpoint model-router core: endpoint configuration shape, normalization,
 * the hard-coded DeepSeek off-peak schedule, and the pure eligibility /
 * picking engine. Framework-free (no cordis, no runtime imports) so the Host
 * router and unit tests share one engine.
 *
 * An endpoint is deliberately lean: it names one DSH provider route and
 * narrows that provider's models (plus a default model when the task's pin
 * cannot be served). Provider-level concerns — concurrency, token caps,
 * allowed hours, off-peak windows — do not belong on the endpoint; they live
 * in the provider's own settings. The only per-endpoint tunables beyond the
 * selection are the model request timeouts (idle + total), which the editor
 * writes through to the provider route's settings.
 *
 * Routing is a preference, never a hard pin: a task lists candidate endpoints
 * in priority order and the router uses the first one that can serve the
 * task's model (or its default model). When none can, the run waits (queued)
 * and is retried until the max-wait expires.
 */

/**
 * DeepSeek's official off-peak schedule since 2026-08-23: peak hours are
 * 01:00–04:00 and 06:00–10:00 UTC Monday–Friday (Beijing 9:00–12:00 /
 * 14:00–18:00); every other hour is off-peak, and weekends are fully
 * off-peak (the Aug 23 change unified Sat/Sun to off-peak pricing). The
 * older single-window default (16:30–00:30 UTC) is obsolete and the schedule
 * is intentionally hard-coded — DeepSeek owns these hours, not the user.
 */
export const DEEPSEEK_OFF_PEAK = {
  peak: [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ],
  weekdays: [1, 2, 3, 4, 5], // Mon–Fri; weekends fully off-peak
  timezone: 'UTC',
} as const

/** Bound on endpoint id/name/provider/model id length (defense-in-depth). */
export const ENDPOINT_FIELD_BOUND = 256
/** Bound on the number of models an endpoint may list. */
export const ENDPOINT_MODELS_BOUND = 64
/** Bound on how many endpoints a task (or the default list) may pin. */
export const ENDPOINT_LIST_BOUND = 16

/** A daily clock window; `start > end` crosses midnight. */
export interface DailyWindow {
  /** 24h 'HH:MM'. */
  start: string
  /** 24h 'HH:MM'. */
  end: string
}

/**
 * A weekday-aware off-peak schedule: the daily peak windows that must be
 * avoided, evaluated in a named time zone (defaults to UTC). Every hour
 * outside the listed peak windows is off-peak, and any weekday not listed is
 * fully off-peak (so the DeepSeek default's Sat/Sun are entirely off-peak).
 */
export interface OffPeakWindow {
  /** Daily peak windows (hours billed at peak rate) to avoid. */
  peak: readonly DailyWindow[]
  /** Weekdays (0=Sunday … 6=Saturday) the peak windows apply; unlisted days are fully off-peak. */
  weekdays: readonly number[]
  /** IANA time zone name. */
  timezone?: string
}

/** One configured compute endpoint (a named backend serving one DSH provider route). */
export interface EndpointConfig {
  /** Stable endpoint id (referenced by tasks and the default list). */
  id: string
  /** Display name (DeepSeek Official, LM Studio on the NAS, …). */
  name: string
  /** DSH provider route id (an `llm.models` group id) this endpoint serves. */
  provider: string
  /** Model ids this endpoint serves; empty means all models of the provider. */
  models: string[]
  /** Model used when the task's model pin cannot be served by this endpoint. */
  defaultModel?: string
}

/** The resolved router configuration (normalized; never trusts raw input). */
export interface EndpointRouterConfig {
  /** How long a queued run may wait for eligibility before it fails (hours). */
  endpointMaxWaitHours: number
  /** Ordered endpoints used by tasks without explicit endpoint pins. */
  defaultEndpoints: string[]
  /** All configured endpoints, keyed by id. */
  endpoints: EndpointConfig[]
}

/** Parse a 'HH:MM' clock string into minutes since midnight; undefined when malformed. */
export function parseClock(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/** Normalize one daily window; undefined when malformed (a malformed window disables the constraint). */
export function normalizeDailyWindow(value: unknown): DailyWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const window = value as Record<string, unknown>
  if (typeof window.start !== 'string' || typeof window.end !== 'string') return undefined
  if (parseClock(window.start) === undefined || parseClock(window.end) === undefined) return undefined
  return { start: window.start, end: window.end }
}

/** Normalize a bounded non-blank string; undefined when invalid. */
function boundedString(value: unknown, bound: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > bound) return undefined
  return trimmed
}

/**
 * Normalize a list of endpoint ids from the wire (task pin / default list):
 * bounded non-blank strings, deduplicated, capped in length; an empty or
 * malformed list collapses to undefined (no endpoint routing).
 */
export function normalizeEndpointList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of value) {
    const id = boundedString(item, ENDPOINT_FIELD_BOUND)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= ENDPOINT_LIST_BOUND) break
  }
  return ids.length === 0 ? undefined : ids
}

/** Normalize one endpoint from raw settings; undefined when the entry is unusable. */
export function normalizeEndpoint(value: unknown): EndpointConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = boundedString(raw.id, ENDPOINT_FIELD_BOUND)
  const provider = boundedString(raw.provider, ENDPOINT_FIELD_BOUND)
  if (id === undefined || provider === undefined) return undefined
  const name = boundedString(raw.name, ENDPOINT_FIELD_BOUND) ?? id
  const models: string[] = []
  if (Array.isArray(raw.models)) {
    for (const item of raw.models) {
      const model = boundedString(item, ENDPOINT_FIELD_BOUND)
      if (model === undefined || models.includes(model)) continue
      models.push(model)
      if (models.length >= ENDPOINT_MODELS_BOUND) break
    }
  }
  return {
    id,
    name,
    provider,
    models,
    ...(boundedString(raw.defaultModel, ENDPOINT_FIELD_BOUND) === undefined ? {} : { defaultModel: boundedString(raw.defaultModel, ENDPOINT_FIELD_BOUND) }),
  }
}

/** Normalize the full router config from raw settings; safe defaults for every field. */
export function normalizeEndpointsConfig(value: unknown): EndpointRouterConfig {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const endpoints = Array.isArray(raw.endpoints)
    ? raw.endpoints.flatMap(endpoint => {
        const normalized = normalizeEndpoint(endpoint)
        return normalized === undefined ? [] : [normalized]
      })
    : []
  const byId = new Map<string, EndpointConfig>()
  for (const endpoint of endpoints) {
    if (!byId.has(endpoint.id)) byId.set(endpoint.id, endpoint)
  }
  return {
    endpointMaxWaitHours: typeof raw.endpointMaxWaitHours === 'number' && Number.isFinite(raw.endpointMaxWaitHours) && raw.endpointMaxWaitHours >= 0
      ? raw.endpointMaxWaitHours
      : 24,
    defaultEndpoints: normalizeEndpointList(raw.defaultEndpoints) ?? [],
    endpoints: [...byId.values()],
  }
}

/** Whether a task goes through the router at all (explicit pins or a default list). */
export function shouldUseRouter(task: { endpoints?: readonly string[] }, config: EndpointRouterConfig): boolean {
  return (task.endpoints !== undefined && task.endpoints.length > 0) || config.defaultEndpoints.length > 0
}

/** Whether a clock minute-of-day falls inside a (possibly midnight-crossing) window. */
export function inDailyWindow(minutes: number, window: DailyWindow): boolean {
  const start = parseClock(window.start)
  const end = parseClock(window.end)
  if (start === undefined || end === undefined) return true
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** Minutes-of-day for a Date in a named IANA time zone; undefined when the zone is unusable. */
export function clockMinutesInTimeZone(date: Date, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const hour = Number(parts.find(part => part.type === 'hour')?.value)
    const minute = Number(parts.find(part => part.type === 'minute')?.value)
    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : undefined
  } catch {
    return undefined
  }
}

/** Weekday (0=Sunday … 6=Saturday) for a Date in a named IANA time zone; undefined when unusable. */
export function weekdayInTimeZone(date: Date, timeZone: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).formatToParts(date)
    const value = parts.find(part => part.type === 'weekday')?.value
    const index = value === undefined ? -1 : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value)
    return index >= 0 ? index : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a Date falls in an off-peak hour of the schedule: unlisted weekdays
 * (weekends by default) are fully off-peak; listed weekdays are off-peak
 * outside every peak window. An unusable time zone or clock probe treats the
 * instant as off-peak (the constraint is skipped, mirroring the old probes).
 */
export function isOffPeakNow(date: Date, schedule: OffPeakWindow = DEEPSEEK_OFF_PEAK): boolean {
  const timezone = schedule.timezone ?? 'UTC'
  const weekday = weekdayInTimeZone(date, timezone)
  const minutes = clockMinutesInTimeZone(date, timezone)
  if (weekday === undefined || minutes === undefined) return true
  if (!schedule.weekdays.includes(weekday)) return true
  return !schedule.peak.some(window => inDailyWindow(minutes, window))
}

/** The resolved model selection a task would use through an endpoint, or undefined when unsupported. */
export function resolveEndpointSelection(
  task: { model?: { provider: string; model: string; reasoningEffort?: string } },
  endpoint: EndpointConfig,
): { provider: string; model: string; reasoningEffort?: string } | undefined {
  const pinned = task.model
  if (pinned !== undefined && pinned.provider === endpoint.provider
    && (endpoint.models.length === 0 || endpoint.models.includes(pinned.model))) {
    return pinned
  }
  if (endpoint.defaultModel !== undefined) {
    return { provider: endpoint.provider, model: endpoint.defaultModel }
  }
  return undefined
}

/** Why an endpoint cannot take a run right now. */
export type EndpointBlockReason =
  | 'unknown-endpoint'
  | 'model-not-served'

/** The router's decision for one task. */
export type RouteDecision =
  | { mode: 'unrouted' }
  | { mode: 'routed'; endpoint: EndpointConfig; selection: { provider: string; model: string; reasoningEffort?: string } }
  | {
    mode: 'wait'
    endpointId: string | undefined
    reasons: EndpointBlockReason[]
    /**
     * Why the run is held before launch: no eligible endpoint (the default),
     * a group slot is occupied, the group's allowed window is closed, or the
     * task's workspace is paused.
     */
    reason?: 'endpoint' | 'group' | 'window' | 'workspace'
  }

/**
 * Pick the first eligible endpoint for a task: explicit task pins first, then
 * the global default list. An endpoint is eligible when it can serve the
 * task's selection (the pinned model, or its own default model). Unknown ids
 * are skipped; when every candidate is blocked the decision is `wait` (with
 * the first known candidate as the preferred endpoint for the waiting note).
 * `unrouted` when no candidate list exists at all — the run proceeds with
 * today's direct model pin.
 */
export function pickEndpoint(
  task: { endpoints?: readonly string[]; model?: { provider: string; model: string; reasoningEffort?: string } },
  config: EndpointRouterConfig,
): RouteDecision {
  const candidates = task.endpoints !== undefined && task.endpoints.length > 0
    ? task.endpoints
    : config.defaultEndpoints
  if (candidates.length === 0) return { mode: 'unrouted' }
  let preferred: string | undefined
  let known = 0
  const reasons: EndpointBlockReason[] = []
  for (const id of candidates) {
    const endpoint = config.endpoints.find(candidate => candidate.id === id)
    if (endpoint === undefined) {
      reasons.push('unknown-endpoint')
      continue
    }
    known += 1
    if (preferred === undefined) preferred = endpoint.id
    const selection = resolveEndpointSelection(task, endpoint)
    if (selection !== undefined) return { mode: 'routed', endpoint, selection }
    reasons.push('model-not-served')
  }
  // Every candidate id was unknown (e.g. an endpoint was renamed or removed):
  // never wedge the task — fall back to today's direct model pin.
  if (known === 0) return { mode: 'unrouted' }
  return { mode: 'wait', endpointId: preferred, reasons }
}

/** The minimal endpoint facts the model-servability filter needs. */
export interface EndpointServeFacts {
  id: string
  provider?: string
  models?: readonly string[]
  defaultModel?: string
}

/**
 * Whether one endpoint can serve one catalog model. Mirrors the router's own
 * serve rule in {@link resolveEndpointSelection}: the provider route must
 * match, and the endpoint either serves every model of its provider (empty
 * list) or the model id is on its narrowed list (the endpoint's own default
 * model counts as served too, because the router falls back to it).
 */
export function endpointServesModel(endpoint: EndpointServeFacts, provider: string, model: string): boolean {
  if (endpoint.provider !== provider) return false
  const models = endpoint.models ?? []
  return models.length === 0 || models.includes(model) || endpoint.defaultModel === model
}

/**
 * Filter a model catalog to the models at least one pinned endpoint can
 * serve, in catalog order. An empty pinned list (or a list whose ids all
 * resolve to nothing — including rows without a provider, which the router
 * drops during normalization) returns the catalog unchanged: the router falls
 * back to the direct model pin in that case, so no endpoint constraint
 * applies. This is the picker-side mirror of the router's serve rule: it
 * keeps the model dropdown from offering a model no pinned endpoint can
 * actually serve.
 */
export function filterModelsByEndpoints<T extends { provider: string; model: string }>(
  models: readonly T[],
  endpoints: readonly EndpointServeFacts[],
  pinnedIds: readonly string[],
): readonly T[] {
  if (pinnedIds.length === 0) return models
  const byId = new Map(endpoints.map(endpoint => [endpoint.id, endpoint]))
  const pinned = pinnedIds
    .map(id => byId.get(id))
    .filter((endpoint): endpoint is EndpointServeFacts => endpoint !== undefined && endpoint.provider !== undefined)
  if (pinned.length === 0) return models
  return models.filter(model => pinned.some(endpoint => endpointServesModel(endpoint, model.provider, model.model)))
}
