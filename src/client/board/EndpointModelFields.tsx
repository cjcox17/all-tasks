/**
 * The endpoint → model cascade shared by the task forms, the task detail's
 * execution settings, and the workspace-defaults editor. The endpoint
 * selection comes first, and the model select sits inside it: only the models
 * the selected endpoints actually serve are offered (see
 * filterModelsByEndpoints — the picker-side mirror of the router's serve
 * rule), so a model the endpoints cannot serve can never be picked silently.
 * A pinned model the endpoints no longer serve stays selectable as a stale
 * row ("not served by pinned endpoints", or "removed" when the catalog no
 * longer knows it), and a note explains the scoped list whenever endpoints
 * are pinned. The reasoning-effort picker follows the model pin.
 */
import type { ReactNode } from 'react'
import type { ExecutionEndpointOption, ExecutionModelOption } from '../../core/controller.ts'
import { filterModelsByEndpoints } from '../../core/endpoints.ts'
import { modelSelectionKey } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { EndpointOrderEditor } from './EndpointOrderEditor.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { ReasoningEffortPicker } from './ReasoningEffortPicker.tsx'

export function EndpointModelFields({
  endpoints,
  onEndpointsChange,
  endpointOptions,
  models,
  modelKey,
  onModelChange,
  modelBlankLabel,
  effort,
  onEffortChange,
  disabled = false,
  endpointsHint,
  modelHint,
}: {
  /** Pinned endpoint ids, in priority order. */
  endpoints: readonly string[]
  onEndpointsChange: (endpoints: string[]) => void
  endpointOptions: readonly ExecutionEndpointOption[]
  /** Full model catalog; the endpoint-scoped subset is computed here. */
  models: readonly ExecutionModelOption[]
  /** The pinned model selection key ('' = deployment/workspace default). */
  modelKey: string
  onModelChange: (key: string) => void
  /** Blank-option label; defaults to "Deployment default". */
  modelBlankLabel?: string
  /** Reasoning-effort level for the pinned model. */
  effort: string
  onEffortChange: (effort: string) => void
  disabled?: boolean
  /** Extra hint under the endpoint editor (e.g. the workspace's default list). */
  endpointsHint?: ReactNode
  /** Extra hint under the model picker (e.g. the workspace's default model). */
  modelHint?: ReactNode
}) {
  const servableModels = filterModelsByEndpoints(models, endpointOptions, endpoints)
  const modelInCatalog = modelKey === '' || models.some(model =>
    modelSelectionKey({ provider: model.provider, model: model.model }) === modelKey)
  const modelServable = modelKey === '' || servableModels.some(model =>
    modelSelectionKey({ provider: model.provider, model: model.model }) === modelKey)
  const modelStale = modelKey !== '' && !modelServable
  const modelStaleLabel = modelStale
    ? (modelInCatalog ? t('exec.model.notServed') : t('exec.model.removed'))
    : undefined
  // Whenever at least one pinned endpoint resolves to a known provider route
  // the roster is endpoint-scoped (unknown ids are dropped by the filter and
  // the router falls back to the direct model pin); say so even when the
  // pinned model is blank, so the shrinking list is never a surprise.
  const pinnedKnown = endpoints.some(id =>
    endpointOptions.some(option => option.id === id && option.provider !== undefined))
  const scopedHint = pinnedKnown ? t('exec.model.endpointHint') : undefined

  return (
    <div className={css.endpointModelGroup}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.endpoints')}</span>
        <EndpointOrderEditor endpoints={endpoints} options={endpointOptions} disabled={disabled} onChange={onEndpointsChange} />
        {endpointsHint}
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.model')}</span>
        <ModelPicker
          models={servableModels}
          value={modelKey}
          onChange={onModelChange}
          blankLabel={modelBlankLabel}
          staleLabel={modelStaleLabel}
          disabled={disabled}
        />
        {scopedHint !== undefined && <p className={css.settingsHint}>{scopedHint}</p>}
        {modelHint}
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
