/**
 * Endpoint editor state and write-ops for the all-tasks settings card.
 *
 * Endpoints live in the plugin's own `all-tasks` settings namespace
 * (`endpoints` array + the `defaultEndpoints` fallback order). An endpoint is
 * deliberately lean — it names one DSH provider route and narrows that
 * provider's models plus a default model; provider-level concerns (concurrency,
 * token caps, windows) belong to the provider's own settings, not here. The
 * only per-endpoint tunables beyond the selection are the model request
 * timeouts (idle + total), which the editor resolves from the provider
 * route's settings (`llm-pi-ai` / `llm-deepseek`) and writes back through
 * them on save — the only place DSH honors timeouts. This module is the
 * shared pure core for the settings-card editor: it resolves the effective
 * (schema-defaulted) endpoint list, validates a full replacement patch with
 * messages that name the offending field, and emits the settings ops that
 * store it. The write goes through `ctx.settings.mutate`, so DSH's own
 * namespace schema judges the values too.
 */
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { DEEPSEEK_PROVIDER, DEFAULT_STREAM_IDLE_TIMEOUT_MS, type ModelTimeoutView } from './model-timeouts.ts'

/** Bound on endpoint id / name / provider / model ids (mirrors core/endpoints). */
export const ENDPOINT_FIELD_BOUND = 256
/** Bound on the number of models one endpoint may list. */
export const ENDPOINT_MODELS_BOUND = 64
/** Upper bound on the timeout fields (seconds; 24h). */
export const ENDPOINT_TIMEOUT_BOUND = 86_400

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
  /** Effective stream-idle timeout in seconds (from the provider route's settings). */
  idleSeconds: number
  /** Effective total request timeout in seconds; 0 = unset (pi-ai only). */
  totalSeconds: number
  /**
   * Local pricing for the dashboard cost estimate: USD per 1M input tokens
   * (0 = not configured; the official DeepSeek route bills its hard-coded
   * peak/off-peak rates instead and hides these fields).
   */
  costPerMillionInputTokens: number
  /** Local pricing for the dashboard cost estimate: USD per 1M output tokens. */
  costPerMillionOutputTokens: number
}

/** One known provider route the editor can attach an endpoint to. */
export interface EndpointProviderInfo {
  /** Provider route id (e.g. `lm-studio`, `deepseek-official`). */
  provider: string
  /** Human display name. */
  displayName: string
  /** Settings namespace the route's timeout lives in. */
  namespace: 'llm-pi-ai' | 'llm-deepseek'
  /** Model ids the route serves (empty when the settings expose none). */
  models: string[]
  /** Effective stream-idle timeout in milliseconds. */
  streamIdleTimeoutMs: number
  /** Effective total request timeout in milliseconds (pi-ai only, when set). */
  timeoutMs?: number
}

/** The editor's full state over the `all-tasks` namespace. */
export interface EndpointEditorState {
  endpoints: EndpointEditorView[]
  /** Ordered endpoints used by tasks without explicit endpoint pins. */
  defaultEndpoints: string[]
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Resolve the model ids a provider route exposes; accepts `{id}` objects or plain strings. */
function modelsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const models: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim() !== '' && !models.includes(item.trim())) models.push(item.trim())
    } else if (typeof item === 'object' && item !== null) {
      const id = (item as Record<string, unknown>).id
      if (typeof id === 'string' && id.trim() !== '' && !models.includes(id.trim())) models.push(id.trim())
    }
    if (models.length >= ENDPOINT_MODELS_BOUND) break
  }
  return models
}

/**
 * Resolve the provider catalog from the two settings namespaces' effective
 * values. Absent or malformed sections yield no entries; pi-ai routes without
 * a model list expose an empty `models` (the editor then falls back to free
 * text).
 */
export function readEndpointProviderCatalog(piAi: unknown, deepSeek: unknown): EndpointProviderInfo[] {
  const catalog: EndpointProviderInfo[] = []
  const providers = (piAi as { providers?: Record<string, unknown> } | undefined)?.providers
  if (providers !== undefined && typeof providers === 'object') {
    for (const [provider, raw] of Object.entries(providers)) {
      if (typeof raw !== 'object' || raw === null) continue
      const profile = raw as { displayName?: unknown; models?: unknown; streamIdleTimeoutMs?: unknown; timeoutMs?: unknown }
      catalog.push({
        provider,
        displayName: typeof profile.displayName === 'string' && profile.displayName !== ''
          ? profile.displayName
          : provider,
        namespace: 'llm-pi-ai',
        models: modelsOf(profile.models),
        streamIdleTimeoutMs: numberOr(profile.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
        ...(numberOr(profile.timeoutMs, 0) > 0 ? { timeoutMs: numberOr(profile.timeoutMs, 0) } : {}),
      })
    }
  }
  if (typeof deepSeek === 'object' && deepSeek !== null) {
    const section = deepSeek as { models?: unknown; streamIdleTimeoutMs?: unknown }
    catalog.push({
      provider: DEEPSEEK_PROVIDER,
      displayName: 'DeepSeek',
      namespace: 'llm-deepseek',
      models: modelsOf(section.models),
      streamIdleTimeoutMs: numberOr(section.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    })
  }
  return catalog
}

function viewOf(raw: unknown, byProvider: ReadonlyMap<string, ModelTimeoutView>): EndpointEditorView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id === '') return undefined
  const provider = typeof entry.provider === 'string' ? entry.provider : ''
  const timeout = provider === '' ? undefined : byProvider.get(provider)
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : '',
    provider,
    models: Array.isArray(entry.models) ? entry.models.filter((model): model is string => typeof model === 'string') : [],
    defaultModel: typeof entry.defaultModel === 'string' ? entry.defaultModel : '',
    idleSeconds: timeout === undefined
      ? Math.round(DEFAULT_STREAM_IDLE_TIMEOUT_MS / 1000)
      : Math.round(timeout.streamIdleTimeoutMs / 1000),
    totalSeconds: timeout?.timeoutMs === undefined ? 0 : Math.round(timeout.timeoutMs / 1000),
    // Clamp defensively: a hand-edited negative price means "not configured".
    costPerMillionInputTokens: Math.max(numberOr(entry.costPerMillionInputTokens, 0), 0),
    costPerMillionOutputTokens: Math.max(numberOr(entry.costPerMillionOutputTokens, 0), 0),
  }
}

/**
 * Resolve the editor's state from the `all-tasks` namespace's effective
 * value plus the resolved provider timeout views. Malformed entries and
 * unknown default-list ids are dropped defensively; an absent namespace
 * yields an empty editor.
 * @param settings - resolved `all-tasks` namespace value.
 * @param providerViews - resolved provider timeout rows (`readModelTimeoutViews`).
 */
export function readEndpointEditorState(settings: unknown, providerViews: readonly ModelTimeoutView[] = []): EndpointEditorState {
  const byProvider = new Map(providerViews.map(view => [view.provider, view]))
  const section = (settings as { endpoints?: unknown; defaultEndpoints?: unknown } | undefined)
  const endpoints = Array.isArray(section?.endpoints)
    ? section.endpoints.map(raw => viewOf(raw, byProvider)).filter((view): view is EndpointEditorView => view !== undefined)
    : []
  const ids = new Set(endpoints.map(endpoint => endpoint.id))
  const defaultEndpoints = Array.isArray(section?.defaultEndpoints)
    ? [...new Set(section.defaultEndpoints.filter((id): id is string => typeof id === 'string' && ids.has(id)))]
    : []
  return { endpoints, defaultEndpoints }
}

function wholeSeconds(value: unknown, label: string, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} must be a whole number of seconds`)
  if (value < (allowZero ? 0 : 1) || value > ENDPOINT_TIMEOUT_BOUND) {
    throw new Error(`${label} must be between ${allowZero ? 0 : 1} and ${ENDPOINT_TIMEOUT_BOUND} seconds`)
  }
  return value
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
    // Local pricing for the cost estimate: a finite non-negative number, 0 = not
    // configured. Absent collapses to 0 so the section stays hand-editable.
    const price = (field: string): number => {
      const value = entry[field]
      if (value === undefined) return 0
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`endpoints[${index}].${field} must be a non-negative number`)
      }
      return value
    }
    endpoints.push({
      id,
      name,
      provider,
      models,
      defaultModel,
      idleSeconds: wholeSeconds(entry.idleSeconds ?? Math.round(DEFAULT_STREAM_IDLE_TIMEOUT_MS / 1000), `endpoints[${index}].idleSeconds`, false),
      totalSeconds: wholeSeconds(entry.totalSeconds ?? 0, `endpoints[${index}].totalSeconds`, true),
      costPerMillionInputTokens: price('costPerMillionInputTokens'),
      costPerMillionOutputTokens: price('costPerMillionOutputTokens'),
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

/** The stored (minimal) shape of one endpoint: provider-ish defaults are omitted so the section stays hand-editable. */
function rawOf(view: EndpointEditorView): Record<string, unknown> {
  const raw: Record<string, unknown> = { id: view.id, provider: view.provider }
  if (view.name !== '') raw.name = view.name
  if (view.models.length > 0) raw.models = view.models
  if (view.defaultModel !== '') raw.defaultModel = view.defaultModel
  if (view.costPerMillionInputTokens > 0) raw.costPerMillionInputTokens = view.costPerMillionInputTokens
  if (view.costPerMillionOutputTokens > 0) raw.costPerMillionOutputTokens = view.costPerMillionOutputTokens
  return raw
}

/**
 * The settings ops that store one editor state in the `all-tasks` namespace:
 * the full `endpoints` array plus the `defaultEndpoints` order, written as one
 * atomic-per-namespace mutation. The timeout fields are intentionally NOT
 * stored here — they belong to the provider route's settings (see
 * `endpointTimeoutPatches`), which is where DSH honors them.
 * @param state - the validated editor state.
 * @returns the ordered path ops.
 */
export function endpointEditorOps(state: EndpointEditorState): SettingsPathOp[] {
  return [
    { op: 'set', path: ['endpoints'], value: state.endpoints.map(rawOf) },
    { op: 'set', path: ['defaultEndpoints'], value: state.defaultEndpoints },
  ]
}

/**
 * Build the provider-timeout writes one endpoint state implies: each endpoint
 * whose provider resolves to a known route carries its idle (and, for pi-ai,
 * total) timeout through to that route's settings. Endpoints on unknown
 * providers are skipped (their timeouts cannot be applied anywhere). A blank
 * (0) total timeout maps to an explicit unset — DSH's schema refuses a zero
 * value, and blank means "no bound" (the backend default), not zero.
 * @param state - the validated editor state.
 * @param catalog - the resolved provider catalog.
 * @returns per-endpoint timeout patches keyed by endpoint index, in input order.
 */
export function endpointTimeoutPatches(
  state: EndpointEditorState,
  catalog: readonly EndpointProviderInfo[],
): Array<{ namespace: 'llm-pi-ai' | 'llm-deepseek'; provider: string; streamIdleTimeoutMs: number; timeoutMs?: number | null }> {
  const patches: Array<{ namespace: 'llm-pi-ai' | 'llm-deepseek'; provider: string; streamIdleTimeoutMs: number; timeoutMs?: number | null }> = []
  for (const endpoint of state.endpoints) {
    const info = catalog.find(candidate => candidate.provider === endpoint.provider)
    if (info === undefined) continue
    patches.push({
      namespace: info.namespace,
      provider: info.provider,
      streamIdleTimeoutMs: endpoint.idleSeconds * 1000,
      ...(info.namespace === 'llm-pi-ai'
        ? { timeoutMs: endpoint.totalSeconds > 0 ? endpoint.totalSeconds * 1000 : null }
        : {}),
    })
  }
  return patches
}
