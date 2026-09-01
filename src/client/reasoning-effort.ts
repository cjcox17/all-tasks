/**
 * Reasoning-effort levels the model pickers offer for a pinned model. The
 * value is adapter-owned and passed through verbatim to `session.selectModel`;
 * the presets cover the common cross-provider set, and any other non-blank
 * value stays editable through the picker (as a custom row).
 */
import type { TaskModelSelection } from '../core/tasks.ts'
import type { AllTasksKey } from './locales.ts'

/** Preset effort levels offered by the model pickers (adapter-owned values). */
export const REASONING_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'] as const

/** Locale key for one preset effort level's display label. */
export function reasoningEffortLabelKey(level: string): AllTasksKey {
  return `exec.model.effort.${level}` as AllTasksKey
}

/**
 * Attach a non-blank effort level to a model selection; a blank value keeps
 * the selection effort-free (the adapter/provider default applies).
 */
export function withReasoningEffort(model: TaskModelSelection, effort: string): TaskModelSelection {
  const trimmed = effort.trim()
  return trimmed === ''
    ? { provider: model.provider, model: model.model }
    : { provider: model.provider, model: model.model, reasoningEffort: trimmed }
}
