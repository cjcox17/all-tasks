/**
 * Model picker shared by the new-task modal and the workspace-defaults
 * editor: the "deployment default" option plus one optgroup per provider.
 */
import { groupExecutionModelOptions, type ExecutionModelOption } from '../../core/controller.ts'
import { modelSelectionKey } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

/** The model picker: one "deployment default" option plus one optgroup per provider. */
export function ModelPicker({ models, value, onChange }: {
  models: readonly ExecutionModelOption[]
  value: string
  onChange: (value: string) => void
}) {
  const groups = groupExecutionModelOptions(models)
  return (
    <select className={css.select} value={value} onChange={event => { onChange(event.target.value) }}>
      <option value="">{t('exec.model.default')}</option>
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
