/**
 * Model picker shared by the new-task modal and the workspace-defaults
 * editor: a blank "default" option plus one optgroup per provider. The blank
 * option's label is context-dependent — the task pickers read "Workspace
 * default" (a blank pin inherits the workspace default), while the
 * workspace-defaults editor keeps "Deployment default" (blank there means
 * the deployment default applies at launch).
 *
 * The parent passes the servable model subset (filtered by the task's pinned
 * endpoints when any are pinned); a current value that is no longer offered
 * stays selectable as a stale row so the user sees exactly what the task will
 * ask for (the parent labels that row through `staleLabel`).
 */
import { groupExecutionModelOptions, type ExecutionModelOption } from '../../core/controller.ts'
import { modelSelectionKey, parseModelSelectionKey } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

/** The model picker: a blank "default" option plus one optgroup per provider. */
export function ModelPicker({ models, value, onChange, blankLabel, staleLabel, disabled = false }: {
  /** Models the picker offers (already filtered by the pinned endpoints). */
  models: readonly ExecutionModelOption[]
  value: string
  onChange: (value: string) => void
  /** Blank-option label; defaults to "Deployment default". */
  blankLabel?: string
  /** Appended to the current value when it is not offered by `models` (e.g. "not served by pinned endpoints"). */
  staleLabel?: string
  disabled?: boolean
}) {
  const groups = groupExecutionModelOptions(models)
  const offered = value === '' || models.some(model =>
    modelSelectionKey({ provider: model.provider, model: model.model }) === value)
  const stale = value !== '' && !offered
  const parsed = stale ? parseModelSelectionKey(value) : undefined
  return (
    <select className={css.select} value={value} disabled={disabled} onChange={event => { onChange(event.target.value) }}>
      <option value="">{blankLabel ?? t('exec.model.default')}</option>
      {parsed !== undefined && (
        <option value={value}>{parsed.provider} · {parsed.model}{staleLabel ?? ''}</option>
      )}
      {groups.map(group => (
        <optgroup key={group.provider} label={group.providerName}>
          {group.models.map(model => (
            <option key={model.model} value={modelSelectionKey({ provider: model.provider, model: model.model })}>
              {model.modelName ?? model.model}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
