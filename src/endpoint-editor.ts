/**
 * Endpoint editor state and write-ops for the task-board settings card.
 *
 * Endpoints live in the plugin's own `task-board` settings namespace
 * (`endpoints` array + the `defaultEndpoints` fallback order). The router
 * reads them through `normalizeEndpointsConfig`; the new-task / task-detail
 * modal lists them through the browser's settings scope. This module is the
 * shared pure core for the settings-card editor: it resolves the effective
 * (schema-defaulted) endpoint list, validates a full replacement patch with
 * messages that name the offending field, and emits the settings ops that
 * store it. The write goes through `ctx.settings.mutate`, so DSH's own
 * namespace schema judges the values too.
 */
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** Bound on endpoint id / name / provider / model ids (mirrors core/endpoints). */
export const ENDPOINT_FIELD_BOUND = 256
/** Bound on the number of models one endpoint may list. */
export const ENDPOINT_MODELS_BOUND = 64

/** The schema defaults the editor round-trips against (index.ts offPeakWindow). */
export const DEFAULT_OFF_PEAK = { start: '16:30', end: '00:30', timezone: 'UTC' } as const

/** One endpoint the settings editor renders and round-trips. */
export interface EndpointEditorView {
  /** Stable endpoint id (referenced by tasks and the default list). */
  id: string
  /** Display name (DeepSeek Official, LM Studio on the NAS, …). */
  name: string
  /** DSH provider route id (an `llm.models` group id) this endpoint serves. */
  provider: string
  /** Model ids this endpoint serves; empty means all models of the provider. */
  models: string[]
  /** Model used when the task's model pin cannot be served by this endpoint. */
  defaultModel: string
  /** Max concurrent launched executions through this endpoint. */
  maxConcurrency: number
  /** Router token cap (0 = no cap). */
  maxTokens: number
  /** Daily allowed-hours window; both blank = always allowed. */
  allowedHours: { start: string; end: string }
  /** Only run inside the (global or per-endpoint) off-peak window. */
  offPeakOnly: boolean
  /** Per-endpoint off-peak window override. */
  offPeak: { start: string; end: string; timezone: string }
}

/** The editor's full state over the `task-board` namespace. */
export interface EndpointEditorState {
  endpoints: EndpointEditorView[]
  /** Ordered endpoints used by tasks without explicit endpoint pins. */
  defaultEndpoints: string[]
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function windowOf(value: unknown): { start: string; end: string } {
  if (typeof value !== 'object' || value === null) return { start: '', end: '' }
  const window = value as Record<string, unknown>
  return {
    start: typeof window.start === 'string' ? window.start : '',
    end: typeof window.end === 'string' ? window.end : '',
  }
}

function viewOf(raw: unknown): EndpointEditorView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id === '') return undefined
  const offPeak = windowOf(entry.offPeak)
  const timezone = (entry.offPeak as Record<string, unknown> | undefined)?.timezone
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : '',
    provider: typeof entry.provider === 'string' ? entry.provider : '',
    models: Array.isArray(entry.models) ? entry.models.filter((model): model is string => typeof model === 'string') : [],
    defaultModel: typeof entry.defaultModel === 'string' ? entry.defaultModel : '',
    maxConcurrency: numberOr(entry.maxConcurrency, 1),
    maxTokens: numberOr(entry.maxTokens, 0),
    allowedHours: windowOf(entry.allowedHours),
    offPeakOnly: entry.offPeakOnly === true,
    offPeak: {
      start: offPeak.start === '' ? DEFAULT_OFF_PEAK.start : offPeak.start,
      end: offPeak.end === '' ? DEFAULT_OFF_PEAK.end : offPeak.end,
      timezone: typeof timezone === 'string' && timezone !== '' ? timezone : DEFAULT_OFF_PEAK.timezone,
    },
  }
}

/**
 * Resolve the editor's state from the `task-board` namespace's effective
 * value. Malformed entries and unknown default-list ids are dropped
 * defensively; an absent namespace yields an empty editor.
 * @param settings - resolved `task-board` namespace value.
 */
export function readEndpointEditorState(settings: unknown): EndpointEditorState {
  const section = (settings as { endpoints?: unknown; defaultEndpoints?: unknown } | undefined)
  const endpoints = Array.isArray(section?.endpoints)
    ? section.endpoints.map(viewOf).filter((view): view is EndpointEditorView => view !== undefined)
    : []
  const ids = new Set(endpoints.map(endpoint => endpoint.id))
  const defaultEndpoints = Array.isArray(section?.defaultEndpoints)
    ? [...new Set(section.defaultEndpoints.filter((id): id is string => typeof id === 'string' && ids.has(id)))]
    : []
  return { endpoints, defaultEndpoints }
}

function clockOrEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (!CLOCK.test(trimmed)) throw new Error(`${label} must be 'HH:MM' or blank`)
  return trimmed
}

function windowOrEmpty(value: unknown, label: string): { start: string; end: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const window = value as Record<string, unknown>
  const start = clockOrEmpty(window.start, `${label}.start`)
  const end = clockOrEmpty(window.end, `${label}.end`)
  if ((start === '') !== (end === '')) throw new Error(`${label} requires both start and end (or neither)`)
  return { start, end }
}

/**
 * Parse and validate the POST body of the endpoints route. Every message
 * names the field at fault; the values are normalized (trimmed, deduplicated)
 * so a save stores the same shape a hand-edited YAML would.
 * @param value - the parsed JSON body.
 * @returns the validated editor state.
 */
export function parseEndpointEditorPatch(value: unknown): EndpointEditorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('endpoint patch must be an object')
  const body = value as Record<string, unknown>
  if (!Array.isArray(body.endpoints)) throw new Error('endpoints must be an array')
  const endpoints: EndpointEditorView[] = []
  const seen = new Set<string>()
  for (const [index, raw] of body.endpoints.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`endpoints[${index}] must be an object`)
    const entry = raw as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') throw new Error(`endpoints[${index}].id is required`)
    if (id.length > ENDPOINT_FIELD_BOUND) throw new Error(`endpoints[${index}].id is too long`)
    if (seen.has(id)) throw new Error(`endpoints[${index}].id duplicates endpoint "${id}"`)
    seen.add(id)
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    if (provider === '') throw new Error(`endpoints[${index}].provider is required`)
    if (provider.length > ENDPOINT_FIELD_BOUND) throw new Error(`endpoints[${index}].provider is too long`)
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name.length > ENDPOINT_FIELD_BOUND) throw new Error(`endpoints[${index}].name is too long`)
    const defaultModel = typeof entry.defaultModel === 'string' ? entry.defaultModel.trim() : ''
    if (defaultModel.length > ENDPOINT_FIELD_BOUND) throw new Error(`endpoints[${index}].defaultModel is too long`)
    if (entry.models !== undefined) {
      if (!Array.isArray(entry.models)) throw new Error(`endpoints[${index}].models must be an array`)
      if (entry.models.length > ENDPOINT_MODELS_BOUND) throw new Error(`endpoints[${index}].models has too many entries`)
    }
    const models = Array.isArray(entry.models)
      ? [...new Set(entry.models.map(model => typeof model === 'string' ? model.trim() : '').filter(model => model !== ''))]
      : []
    for (const model of models) {
      if (model.length > ENDPOINT_FIELD_BOUND) throw new Error(`endpoints[${index}].models entry is too long`)
    }
    const maxConcurrency = entry.maxConcurrency === undefined ? 1 : entry.maxConcurrency
    if (typeof maxConcurrency !== 'number' || !Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(`endpoints[${index}].maxConcurrency must be a whole number >= 1`)
    }
    const maxTokens = entry.maxTokens === undefined ? 0 : entry.maxTokens
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 0) {
      throw new Error(`endpoints[${index}].maxTokens must be a whole number >= 0`)
    }
    const allowed = windowOrEmpty(entry.allowedHours, `endpoints[${index}].allowedHours`) ?? { start: '', end: '' }
    if (typeof entry.offPeakOnly !== 'undefined' && typeof entry.offPeakOnly !== 'boolean') {
      throw new Error(`endpoints[${index}].offPeakOnly must be a boolean`)
    }
    let offPeak: { start: string; end: string; timezone: string } = DEFAULT_OFF_PEAK
    if (entry.offPeak !== undefined) {
      const window = windowOrEmpty(entry.offPeak, `endpoints[${index}].offPeak`) ?? { start: '', end: '' }
      const rawTz = (entry.offPeak as Record<string, unknown>).timezone
      if (rawTz !== undefined && typeof rawTz !== 'string') throw new Error(`endpoints[${index}].offPeak.timezone must be a string`)
      let timezone: string = DEFAULT_OFF_PEAK.timezone
      if (typeof rawTz === 'string' && rawTz.trim() !== '') timezone = rawTz.trim()
      if (timezone.length > ENDPOINT_FIELD_BOUND) throw new Error(`endpoints[${index}].offPeak.timezone is too long`)
      offPeak = {
        start: window.start === '' ? DEFAULT_OFF_PEAK.start : window.start,
        end: window.end === '' ? DEFAULT_OFF_PEAK.end : window.end,
        timezone,
      }
    }
    endpoints.push({
      id,
      name,
      provider,
      models,
      defaultModel,
      maxConcurrency,
      maxTokens,
      allowedHours: allowed,
      offPeakOnly: entry.offPeakOnly === true,
      offPeak,
    })
  }
  const defaultEndpoints: string[] = []
  if (body.defaultEndpoints !== undefined) {
    if (!Array.isArray(body.defaultEndpoints)) throw new Error('defaultEndpoints must be an array')
    for (const [index, id] of body.defaultEndpoints.entries()) {
      if (typeof id !== 'string' || id.trim() === '') throw new Error(`defaultEndpoints[${index}] must be a non-empty endpoint id`)
      const trimmed = id.trim()
      if (!seen.has(trimmed)) throw new Error(`defaultEndpoints[${index}] names an unknown endpoint "${trimmed}"`)
      if (!defaultEndpoints.includes(trimmed)) defaultEndpoints.push(trimmed)
    }
  }
  return { endpoints, defaultEndpoints }
}

/** The stored (minimal) shape of one endpoint: defaults are omitted so the section stays hand-editable. */
function rawOf(view: EndpointEditorView): Record<string, unknown> {
  const raw: Record<string, unknown> = { id: view.id, provider: view.provider }
  if (view.name !== '') raw.name = view.name
  if (view.models.length > 0) raw.models = view.models
  if (view.defaultModel !== '') raw.defaultModel = view.defaultModel
  if (view.maxConcurrency !== 1) raw.maxConcurrency = view.maxConcurrency
  if (view.maxTokens !== 0) raw.maxTokens = view.maxTokens
  if (view.allowedHours.start !== '' && view.allowedHours.end !== '') {
    raw.allowedHours = { start: view.allowedHours.start, end: view.allowedHours.end }
  }
  if (view.offPeakOnly) raw.offPeakOnly = true
  const offPeak = view.offPeak
  if (!(offPeak.start === DEFAULT_OFF_PEAK.start && offPeak.end === DEFAULT_OFF_PEAK.end && offPeak.timezone === DEFAULT_OFF_PEAK.timezone)) {
    const value: Record<string, string> = { start: offPeak.start, end: offPeak.end }
    if (offPeak.timezone !== DEFAULT_OFF_PEAK.timezone) value.timezone = offPeak.timezone
    raw.offPeak = value
  }
  return raw
}

/**
 * The settings ops that store one editor state in the `task-board` namespace:
 * the full `endpoints` array plus the `defaultEndpoints` order, written as one
 * atomic-per-namespace mutation.
 * @param state - the validated editor state.
 * @returns the ordered path ops.
 */
export function endpointEditorOps(state: EndpointEditorState): SettingsPathOp[] {
  return [
    { op: 'set', path: ['endpoints'], value: state.endpoints.map(rawOf) },
    { op: 'set', path: ['defaultEndpoints'], value: state.defaultEndpoints },
  ]
}
