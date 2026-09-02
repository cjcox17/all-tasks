/**
 * Cost estimation for the dashboard: DeepSeek's official peak/off-peak API
 * rates (hard-coded, like the off-peak schedule) and per-endpoint pricing for
 * local models. Pure and framework-free so the board and unit tests share one
 * engine.
 *
 * The estimate bills every execution individually and sums the results:
 *
 * - Runs through an endpoint whose provider is the official DeepSeek route
 *   (and unrouted runs pinned directly to that provider) use DeepSeek's
 *   official per-model rates, choosing peak or off-peak from the instant the
 *   run launched (`launchedAt`, falling back to `startedAt`), so an off-peak
 *   run is billed at half the peak rate. Cached input is billed at the
 *   cache-hit rate; uncached input and cache writes bill at the cache-miss
 *   rate; output bills at the output rate. A model without a published rate
 *   (an unknown official model id) yields no estimate for that run.
 * - Runs through any other endpoint use the endpoint's own configured
 *   USD-per-1M-token prices (0/absent = not configured, no estimate), the
 *   same flat input/output split the board used before — local compute has no
 *   peak/off-peak.
 * - Runs with no usage report yield no estimate.
 *
 * It is an estimate, not an invoice: the run's whole usage is billed at the
 * rate in effect when it launched rather than per model call, and changing an
 * endpoint's pricing (or default model) later also changes the historical
 * estimate.
 */
import { DEEPSEEK_OFF_PEAK, isOffPeakNow } from './endpoints.ts'

/** Provider route id of the official DeepSeek adapter (configures through `llm-deepseek`). */
export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official'

/**
 * DeepSeek's official API rates (USD per 1M tokens) since the 2026-08-23
 * peak/off-peak pricing change. Mirror of the official pricing page
 * (https://api-docs.deepseek.com/quick_start/pricing): peak hours are
 * 01:00–04:00 and 06:00–10:00 UTC Mon–Fri and off-peak rates are half of the
 * peak rates, matching {@link DEEPSEEK_OFF_PEAK}. Deliberately hard-coded —
 * DeepSeek owns its price list, not the user; when DeepSeek changes it, this
 * table changes with the schedule above.
 */
export interface OfficialRatePair {
  /** USD per 1M tokens during the peak windows (Mon–Fri 01:00–04:00 / 06:00–10:00 UTC). */
  peak: number
  /** USD per 1M tokens outside the peak windows (and all weekend); half of peak. */
  offPeak: number
}

/** One official DeepSeek model's rates. */
export interface OfficialModelRate {
  /** Input served from the prompt cache (cache hit). */
  inputCacheHit: OfficialRatePair
  /** Uncached input; newly written cache entries bill at this rate too. */
  inputCacheMiss: OfficialRatePair
  /** Generated output tokens. */
  output: OfficialRatePair
}

/** The official DeepSeek model rate table, keyed by model id. */
export const DEEPSEEK_OFFICIAL_RATES: Readonly<Record<string, OfficialModelRate>> = {
  'deepseek-v4-flash': {
    inputCacheHit: { peak: 0.014, offPeak: 0.007 },
    inputCacheMiss: { peak: 0.44, offPeak: 0.22 },
    output: { peak: 1.32, offPeak: 0.66 },
  },
  'deepseek-v4-pro': {
    inputCacheHit: { peak: 0.044, offPeak: 0.022 },
    inputCacheMiss: { peak: 1.32, offPeak: 0.66 },
    output: { peak: 3.96, offPeak: 1.98 },
  },
  'deepseek-v4-flash-vision-exp': {
    inputCacheHit: { peak: 0.014, offPeak: 0.007 },
    inputCacheMiss: { peak: 0.44, offPeak: 0.22 },
    output: { peak: 1.32, offPeak: 0.66 },
  },
}

/** The endpoint facts the cost estimate needs (the router's lean endpoint shape). */
export interface PricingEndpoint {
  /** Stable endpoint id (matches the execution's `endpointId`). */
  id: string
  /** DSH provider route id this endpoint serves; absent when the settings row is incomplete. */
  provider?: string
  /** Model ids this endpoint serves; empty/absent means every model of the provider. */
  models?: readonly string[]
  /** Model used when the task's model pin cannot be served by this endpoint. */
  defaultModel?: string
  /** Local pricing: USD per 1M input tokens (0/absent = not configured). */
  costPerMillionInputTokens?: number
  /** Local pricing: USD per 1M output tokens (0/absent = not configured). */
  costPerMillionOutputTokens?: number
}

/** The task's model pin, reduced to what pricing needs. */
export interface PricingTaskModel {
  /** DSH provider route id. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** The execution facts the cost estimate needs. */
export interface PricingExecution {
  /** The endpoint this run was routed through; absent on unrouted runs. */
  endpointId?: string
  /** When the session actually launched (the billing instant); absent on never-launched runs. */
  launchedAt?: number
  /** When the run started (request time); the fallback billing instant. */
  startedAt: number
  /** Token accounting captured at settlement; absent when the adapter reported none. */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}

/** One model's rate in effect at an instant, peak or off-peak. */
interface EffectiveRate {
  inputCacheHit: number
  inputCacheMiss: number
  output: number
}

/** Pick the rate pair in effect at an instant from the off-peak schedule. */
function rateAt(rate: OfficialModelRate, offPeak: boolean): EffectiveRate {
  const pick = (pair: OfficialRatePair): number => offPeak ? pair.offPeak : pair.peak
  return {
    inputCacheHit: pick(rate.inputCacheHit),
    inputCacheMiss: pick(rate.inputCacheMiss),
    output: pick(rate.output),
  }
}

/** The model the router would have used for one execution, or undefined when it cannot be resolved. */
function servedModel(task: { model?: PricingTaskModel }, endpoint: PricingEndpoint): string | undefined {
  const pinned = task.model
  const models = endpoint.models
  if (pinned !== undefined && pinned.provider === endpoint.provider
    && (models === undefined || models.length === 0 || models.includes(pinned.model))) {
    return pinned.model
  }
  return endpoint.defaultModel
}

/** The billing instant of one execution: the launch, falling back to the request time. */
function billingInstant(execution: PricingExecution): Date {
  return new Date(execution.launchedAt ?? execution.startedAt)
}

/** Bill one execution's usage at an official DeepSeek rate (cache-hit/miss split). */
function officialCost(usage: NonNullable<PricingExecution['usage']>, rate: EffectiveRate): number {
  const miss = usage.inputTokens + (usage.cacheWriteTokens ?? 0)
  const hit = usage.cacheReadTokens ?? 0
  return (miss / 1_000_000) * rate.inputCacheMiss
    + (hit / 1_000_000) * rate.inputCacheHit
    + (usage.outputTokens / 1_000_000) * rate.output
}

/** Bill one execution's usage at a flat per-million rate (local endpoint pricing). */
function flatCost(usage: NonNullable<PricingExecution['usage']>, inputPerMillion: number, outputPerMillion: number): number {
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return (input / 1_000_000) * inputPerMillion + (usage.outputTokens / 1_000_000) * outputPerMillion
}

/** Official DeepSeek pricing for one execution, or undefined when no rate applies. */
function officialExecutionCost(execution: PricingExecution, model: string): number | undefined {
  const rate = DEEPSEEK_OFFICIAL_RATES[model]
  const usage = execution.usage
  if (rate === undefined || usage === undefined) return undefined
  const offPeak = isOffPeakNow(billingInstant(execution), DEEPSEEK_OFF_PEAK)
  return officialCost(usage, rateAt(rate, offPeak))
}

/**
 * Estimate the USD cost of one execution, or undefined when no rate applies
 * (no usage, an unknown official model, or a local endpoint without pricing).
 * @param execution - the settled execution's cost-relevant facts.
 * @param task - the task the execution belongs to (its model pin).
 * @param endpoints - configured endpoints with their pricing.
 */
export function executionCostUsd(
  execution: PricingExecution,
  task: { model?: PricingTaskModel },
  endpoints: readonly PricingEndpoint[],
): number | undefined {
  if (execution.usage === undefined) return undefined
  const endpoint = execution.endpointId === undefined
    ? undefined
    : endpoints.find(candidate => candidate.id === execution.endpointId)
  // DeepSeek's official route: published peak/off-peak rates by model.
  if (endpoint !== undefined && endpoint.provider === DEEPSEEK_OFFICIAL_PROVIDER) {
    const model = servedModel(task, endpoint)
    return model === undefined ? undefined : officialExecutionCost(execution, model)
  }
  // Any other endpoint: its own flat per-million pricing (local compute).
  if (endpoint !== undefined) {
    const inputPerMillion = endpoint.costPerMillionInputTokens ?? 0
    const outputPerMillion = endpoint.costPerMillionOutputTokens ?? 0
    if (inputPerMillion <= 0 || outputPerMillion <= 0) return undefined
    return flatCost(execution.usage, inputPerMillion, outputPerMillion)
  }
  // Unrouted runs fall back to the direct model pin: official pricing applies
  // for a DeepSeek pin (the official route's own models), nothing otherwise.
  const pinned = task.model
  if (pinned === undefined || pinned.provider !== DEEPSEEK_OFFICIAL_PROVIDER) return undefined
  return officialExecutionCost(execution, pinned.model)
}
