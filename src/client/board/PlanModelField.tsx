/**
 * Plan-model field shared by the task forms, the task detail's execution
 * settings, the workspace-defaults editor, and the group editor: a plain
 * model picker (NOT endpoint-scoped — the plan model is a direct pin, the
 * router only resolves the work model) plus the reasoning-effort picker.
 * A pinned model the catalog no longer knows stays selectable as a stale row
 * so the user sees exactly what the plan phase will ask for.
 */
import type { ReactNode } from 'react'
import type { ExecutionModelOption } from '../../core/controller.ts'
import { modelSelectionKey } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { ModelPicker } from './ModelPicker.tsx'
import { ReasoningEffortPicker } from './ReasoningEffortPicker.tsx'

export function PlanModelField({
  models,
  modelKey,
  onModelChange,
  modelBlankLabel,
  effort,
  onEffortChange,
  disabled = false,
  hint,
  label,
}: {
  /** Full model catalog (the plan model is not endpoint-scoped). */
  models: readonly ExecutionModelOption[]
  /** The pinned plan-model selection key ('' = no plan phase). */
  modelKey: string
  onModelChange: (key: string) => void
  /** Blank-option label; defaults to "Deployment default". */
  modelBlankLabel?: string
  /** Reasoning-effort level for the pinned plan model. */
  effort: string
  onEffortChange: (effort: string) => void
  disabled?: boolean
  /** Extra hint under the picker (e.g. the effective default when blank). */
  hint?: ReactNode
  /** Field label; defaults to "Plan model". */
  label?: string
}) {
  const modelInCatalog = modelKey === '' || models.some(model =>
    modelSelectionKey({ provider: model.provider, model: model.model }) === modelKey)
  return (
    <div className={css.endpointModelGroup}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{label ?? t('new.planModel')}</span>
        <ModelPicker
          models={models}
          value={modelKey}
          onChange={onModelChange}
          blankLabel={modelBlankLabel}
          staleLabel={modelInCatalog ? undefined : t('exec.model.removed')}
          disabled={disabled}
        />
        {modelKey === '' && hint}
      </label>

      {modelKey !== '' && (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.model.effort')}</span>
          <ReasoningEffortPicker value={effort} disabled={disabled} onChange={onEffortChange} />
        </label>
      )}
    </div>
  )
}
