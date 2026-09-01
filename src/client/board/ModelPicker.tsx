/**
 * Model picker shared by the new-task modal and the workspace-defaults
 * editor: the "deployment default" option plus one optgroup per provider.
 *
 * The parent passes the servable model subset (filtered by the task's pinned
 * endpoints when any are pinned); a current value that is no longer offered
 * stays selectable as a stale row so the user sees exactly what the task will
 * ask for, with an optional label and hint the parent supplies.
 */
import { groupExecutionModelOptions, type ExecutionModelOption } from '../../core/controller.ts'
import { modelSelectionKey, parseModelSelectionKey } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

/** The model picker: one "deployment default" option plus one optgroup per provider. */
export function ModelPicker({ models, value, onChange, staleLabel, staleHint }: {
  /** Models the picker offers (already filtered by the pinned endpoints). */
  models: readonly ExecutionModelOption[]
  value: string
  onChange: (value: string) => void
  /** Appended to the current value when it is not offered by `models` (e.g. "not served by pinned endpoints"). */
  staleLabel?: string
  /** Hint shown under the picker when the current value is not offered. */
  staleHint?: string
}) {
  const groups = groupExecutionModelOptions(models)
  const offered = value === '' || models.some(model =>
    modelSelectionKey({ provider: model.provider, model: model.model }) === value)
  const stale = value !== '' && !offered
  const parsed = stale ? parseModelSelectionKey(value) : undefined
  return (
    <>
      <select className={css.select} value={value} onChange={event => { onChange(event.target.value) }}>
        <option value="">{t('exec.model.default')}</option>
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
      {stale && staleHint !== undefined && <p className={css.settingsHint}>{staleHint}</p>}
    </>
  )
}
