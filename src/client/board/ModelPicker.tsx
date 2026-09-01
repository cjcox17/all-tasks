/**
 * Model picker shared by the new-task modal and the workspace-defaults
 * editor: a blank "default" option plus one optgroup per provider. The blank
 * option's label is context-dependent — the task pickers read "Workspace
 * default" (a blank pin inherits the workspace default), while the
 * workspace-defaults editor keeps "Deployment default" (blank there means
 * the deployment default applies at launch).
 */
import { groupExecutionModelOptions, type ExecutionModelOption } from '../../core/controller.ts'
import { modelSelectionKey } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

/** The model picker: a blank "default" option plus one optgroup per provider. */
export function ModelPicker({ models, value, onChange, blankLabel }: {
  models: readonly ExecutionModelOption[]
  value: string
  onChange: (value: string) => void
  /** Blank-option label; defaults to "Deployment default". */
  blankLabel?: string
}) {
  const groups = groupExecutionModelOptions(models)
  return (
    <select className={css.select} value={value} onChange={event => { onChange(event.target.value) }}>
      <option value="">{blankLabel ?? t('exec.model.default')}</option>
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
