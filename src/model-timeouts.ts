/**
 * Model timeout views and settings write-ops for the all-tasks settings
 * card.
 *
 * DSH's model-request timeouts live in the user-settings seam, not on the
 * session or request wire: `llm-pi-ai` (custom/local providers such as LM
 * Studio, Ollama, or any OpenAI-compatible gateway) carries one
 * `streamIdleTimeoutMs` (plus an optional `timeoutMs`) per provider route,
 * and `llm-deepseek` (the official route) carries a single
 * `streamIdleTimeoutMs`. Both default to 300 000 ms — the "default 300
 * seconds" that kills a local LLM recomputing a long message chain or
 * generating tokens slowly, because the adapter aborts the stream when no
 * new chunk arrives inside the window even though the backend is still
 * working.
 *
 * The board surfaces these through the endpoint editor: each endpoint names
 * one provider route, so its idle/total timeout fields write through to that
 * route's settings (the only place DSH honors them). Reading resolves the
 * effective (schema-defaulted) value; writing emits path ops for
 * `ctx.settings.mutate`, which validates against the provider's own schema,
 * so a bad value is refused by DSH, not silently stored.
 */
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** DSH's default stream-idle timeout (dsh-llm-pi-ai / dsh-llm-deepseek `DEFAULT_STREAM_IDLE_TIMEOUT_MS`). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** `setTimeout`'s maximum delay; dsh-timeout caps every watchdog at this bound. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Provider route id of the official DeepSeek adapter (configures through `llm-deepseek`). */
export const DEEPSEEK_PROVIDER = 'deepseek-official'

/** The two settings namespaces that own model timeouts. */
export type ModelTimeoutNamespace = 'llm-pi-ai' | 'llm-deepseek'

/** One provider row the settings card renders. */
export interface ModelTimeoutView {
  /** Provider route id (e.g. `lm-studio`, `deepseek-official`). */
  provider: string
  /** Human display name (profile `displayName`, else the route id). */
  displayName: string
  /** Settings namespace the timeout lives in. */
  namespace: ModelTimeoutNamespace
  /** Effective stream-idle timeout in milliseconds (schema default 300 000). */
  streamIdleTimeoutMs: number
  /** Effective total HTTP request timeout in milliseconds (pi-ai only, when set). */
  timeoutMs?: number
}

/** One timeout write from the settings card. */
export interface ModelTimeoutPatch {
  /** Provider route id. */
  provider: string
  /** Desired stream-idle timeout in milliseconds; null restores the schema default. */
  streamIdleTimeoutMs: number | null
  /** Desired total request timeout in milliseconds; null removes the override; absent leaves it stored. */
  timeoutMs?: number | null
}

/** The narrow host-side settings seam the board needs (a cordis `settings` face). */
export interface ModelTimeoutSettingsSeam {
  /** Read one registered namespace's resolved value. */
  get(ns: string): unknown
  /** Apply path-addressed edits to one namespace's user section. */
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

/** Reject a timeout that DSH's schemas would refuse, with a field-naming message. */
export function assertTimeoutMs(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${label} must be a number of milliseconds between 1 and ${MAX_TIMER_DELAY_MS}`)
  }
}

function positiveTimeoutMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Resolve the provider rows from the two settings namespaces' effective
 * values. Absent or malformed sections yield no rows (the pi-ai dict skips
 * non-object entries defensively).
 * @param piAi - resolved `llm-pi-ai` value (schema-defaulted).
 * @param deepSeek - resolved `llm-deepseek` value, or undefined when the
 *   adapter is not composed.
 */
export function readModelTimeoutViews(piAi: unknown, deepSeek: unknown): ModelTimeoutView[] {
  const views: ModelTimeoutView[] = []
  const providers = (piAi as { providers?: Record<string, unknown> } | undefined)?.providers
  if (providers !== undefined && typeof providers === 'object') {
    for (const [provider, raw] of Object.entries(providers)) {
      if (typeof raw !== 'object' || raw === null) continue
      const profile = raw as { displayName?: unknown; streamIdleTimeoutMs?: unknown; timeoutMs?: unknown }
      const timeoutMs = positiveTimeoutMs(profile.timeoutMs, 0)
      views.push({
        provider,
        displayName: typeof profile.displayName === 'string' && profile.displayName !== ''
          ? profile.displayName
          : provider,
        namespace: 'llm-pi-ai',
        streamIdleTimeoutMs: positiveTimeoutMs(profile.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
        ...(timeoutMs > 0 ? { timeoutMs } : {}),
      })
    }
  }
  if (typeof deepSeek === 'object' && deepSeek !== null) {
    const section = deepSeek as { streamIdleTimeoutMs?: unknown }
    views.push({
      provider: DEEPSEEK_PROVIDER,
      displayName: 'DeepSeek',
      namespace: 'llm-deepseek',
      streamIdleTimeoutMs: positiveTimeoutMs(section.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    })
  }
  return views
}

/**
 * Build the settings ops that realize one patch on an existing provider row.
 * `streamIdleTimeoutMs: null` unsets the field (the schema default takes
 * over); `timeoutMs: null` removes the total-request override; an absent
 * `timeoutMs` leaves the stored value untouched. A non-null value is
 * validated before any op is produced.
 * @param target - the provider's current view (its namespace picks the path).
 * @param patch - the desired timeout state.
 * @returns the namespace to mutate and the ordered path ops.
 */
export function modelTimeoutOps(target: ModelTimeoutView, patch: ModelTimeoutPatch): { namespace: ModelTimeoutNamespace; ops: SettingsPathOp[] } {
  const idle = patch.streamIdleTimeoutMs
  if (idle !== null) assertTimeoutMs(idle, 'stream idle timeout')
  if (target.namespace === 'llm-pi-ai') {
    const base = ['providers', patch.provider]
    const ops: SettingsPathOp[] = [
      idle === null
        ? { op: 'unset', path: [...base, 'streamIdleTimeoutMs'] }
        : { op: 'set', path: [...base, 'streamIdleTimeoutMs'], value: idle },
    ]
    const total = patch.timeoutMs
    if (total !== undefined) {
      if (total !== null) assertTimeoutMs(total, 'total request timeout')
      ops.push(
        total === null
          ? { op: 'unset', path: [...base, 'timeoutMs'] }
          : { op: 'set', path: [...base, 'timeoutMs'], value: total },
      )
    }
    return { namespace: 'llm-pi-ai', ops }
  }
  if (patch.timeoutMs !== undefined && patch.timeoutMs !== null) {
    throw new Error('a total request timeout is only supported for llm-pi-ai providers')
  }
  return {
    namespace: 'llm-deepseek',
    ops: [
      idle === null
        ? { op: 'unset', path: ['streamIdleTimeoutMs'] }
        : { op: 'set', path: ['streamIdleTimeoutMs'], value: idle },
    ],
  }
}
