/**
 * Endpoint model-router core: endpoint configuration shape, normalization,
 * time-window math (allowed hours + peak/off-peak), and the pure eligibility /
 * picking engine. Framework-free (no cordis, no runtime imports) so the Host
 * router and unit tests share one engine.
 *
 * Routing is a preference, never a hard pin: a task lists candidate endpoints
 * in priority order and the router uses the first one that is eligible right
 * now (within its allowed hours, off-peak satisfied, under its concurrency
 * cap, within its token cap). When none is eligible the run waits (queued) and
 * is retried until a window opens or the max-wait expires.
 */

/**
 * DeepSeek's official off-peak discount window (16:30–00:30 UTC, 50% off chat
 * / 75% off reasoner). UTC-based and overridable globally or per endpoint.
 */
export const DEEPSEEK_OFF_PEAK = { start: '16:30', end: '00:30', timezone: 'UTC' } as const

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

/** A daily window evaluated in a named time zone (defaults to UTC). */
export interface OffPeakWindow extends DailyWindow {
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
  /** Max concurrent launched executions through this endpoint (host-wide). */
  maxConcurrency: number
  /**
   * Router token cap: a candidate model whose DSH-configured maxTokens exceeds
   * this cap is ineligible (the endpoint lacks the token space for the task).
   */
  maxTokens?: number
  /** Daily hours (host-local time) the endpoint may be used; absent = always. */
  allowedHours?: DailyWindow
  /** Only run inside the (global or per-endpoint) off-peak window. */
  offPeakOnly: boolean
  /** Per-endpoint off-peak window override. */
  offPeak?: OffPeakWindow
}

/** The resolved router configuration (normalized; never trusts raw input). */
export interface EndpointRouterConfig {
  /** Global off-peak window (DeepSeek 16:30–00:30 UTC by default). */
  offPeak: OffPeakWindow
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

/** Normalize an off-peak window; falls back to the DeepSeek default. */
export function normalizeOffPeakWindow(value: unknown): OffPeakWindow {
  const window = normalizeDailyWindow(value)
  if (window === undefined) return { ...DEEPSEEK_OFF_PEAK }
  const timezone = (value as Record<string, unknown>)?.timezone
  return typeof timezone === 'string' && timezone.trim() !== ''
    ? { ...window, timezone: timezone.trim() }
    : { ...window, timezone: 'UTC' }
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
  const maxConcurrency = typeof raw.maxConcurrency === 'number' && Number.isInteger(raw.maxConcurrency) && raw.maxConcurrency >= 1
    ? raw.maxConcurrency
    : 1
  const maxTokens = typeof raw.maxTokens === 'number' && Number.isInteger(raw.maxTokens) && raw.maxTokens >= 1
    ? raw.maxTokens
    : undefined
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
    maxConcurrency,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(normalizeDailyWindow(raw.allowedHours) === undefined ? {} : { allowedHours: normalizeDailyWindow(raw.allowedHours) }),
    offPeakOnly: raw.offPeakOnly === true,
    ...(normalizeDailyWindow(raw.offPeak) === undefined ? {} : { offPeak: normalizeOffPeakWindow(raw.offPeak) }),
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
    offPeak: normalizeOffPeakWindow(raw.offPeak),
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

/** The effective off-peak window for one endpoint (per-endpoint override or the global default). */
export function effectiveOffPeakWindow(endpoint: EndpointConfig, global: OffPeakWindow): OffPeakWindow {
  return endpoint.offPeak ?? global
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
  | 'outside-allowed-hours'
  | 'off-peak-only'
  | 'concurrency-full'
  | 'model-over-cap'
  | 'model-not-served'

/** Inputs the eligibility check needs (assembled by the Host router from live state). */
export interface EndpointEligibilityInput {
  endpoint: EndpointConfig
  /** Minutes-of-day in the allowed-hours time zone (host-local). */
  localMinutes: number | undefined
  /** Minutes-of-day in the off-peak window time zone (UTC). */
  offPeakMinutes: number | undefined
  /** The effective off-peak window for this endpoint (per-endpoint override or global). */
  offPeakWindow: OffPeakWindow
  /** Launched-and-unsettled executions currently using this endpoint. */
  activeCount: number
  /** DSH-configured maxTokens for the candidate model (best-effort). */
  modelMaxTokens: number | undefined
  /** The resolved selection this run would use through the endpoint. */
  selection: { provider: string; model: string; reasoningEffort?: string } | undefined
}

/** Eligibility verdict: ok, or a single blocking reason. */
export type EndpointEligibility = { ok: true } | { ok: false; reason: EndpointBlockReason }

/** Whether one endpoint can take a run right now (pure; all time inputs pre-computed). */
export function isEndpointEligible(input: EndpointEligibilityInput): EndpointEligibility {
  const { endpoint } = input
  if (input.selection === undefined) return { ok: false, reason: 'model-not-served' }
  if (endpoint.allowedHours !== undefined && input.localMinutes !== undefined && !inDailyWindow(input.localMinutes, endpoint.allowedHours)) {
    return { ok: false, reason: 'outside-allowed-hours' }
  }
  if (endpoint.offPeakOnly && input.offPeakMinutes !== undefined && !inDailyWindow(input.offPeakMinutes, input.offPeakWindow)) {
    return { ok: false, reason: 'off-peak-only' }
  }
  if (input.activeCount >= endpoint.maxConcurrency) return { ok: false, reason: 'concurrency-full' }
  if (endpoint.maxTokens !== undefined && input.modelMaxTokens !== undefined && input.modelMaxTokens > endpoint.maxTokens) {
    return { ok: false, reason: 'model-over-cap' }
  }
  return { ok: true }
}

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
     * a group slot is occupied, or the group's allowed window is closed.
     */
    reason?: 'endpoint' | 'group' | 'window'
  }

/** Live state the pure picker needs (assembled per evaluation). */
export interface EndpointPickerState {
  localMinutes: number | undefined
  offPeakMinutes: number | undefined
  activeCounts: ReadonlyMap<string, number>
  modelMaxTokens: (provider: string, model: string) => number | undefined
}

/**
 * Pick the first eligible endpoint for a task: explicit task pins first, then
 * the global default list. Unknown ids are skipped; when every candidate is
 * blocked the decision is `wait` (with the first known candidate as the
 * preferred endpoint for the waiting note). `unrouted` when no candidate list
 * exists at all — the run proceeds with today's direct model pin.
 */
export function pickEndpoint(
  task: { endpoints?: readonly string[]; model?: { provider: string; model: string; reasoningEffort?: string } },
  config: EndpointRouterConfig,
  state: EndpointPickerState,
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
    const verdict = isEndpointEligible({
      endpoint,
      localMinutes: state.localMinutes,
      offPeakMinutes: state.offPeakMinutes,
      offPeakWindow: effectiveOffPeakWindow(endpoint, config.offPeak),
      activeCount: state.activeCounts.get(endpoint.id) ?? 0,
      modelMaxTokens: selection === undefined ? undefined : state.modelMaxTokens(selection.provider, selection.model),
      selection,
    })
    if (verdict.ok) return { mode: 'routed', endpoint, selection: selection! }
    reasons.push(verdict.reason)
  }
  // Every candidate id was unknown (e.g. an endpoint was renamed or removed):
  // never wedge the task — fall back to today's direct model pin.
  if (known === 0) return { mode: 'unrouted' }
  return { mode: 'wait', endpointId: preferred, reasons }
}
