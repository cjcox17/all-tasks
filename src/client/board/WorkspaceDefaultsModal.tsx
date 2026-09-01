/**
 * Workspace default-settings editor: the execution targets (agent preset,
 * model + reasoning effort, endpoints, permission) and the new-task approval
 * default that are pre-filled when a task is created in that workspace.
 * Blank fields mean "no default" (the runtime default applies at execution
 * time, exactly like an unpinned task); saving with every field blank
 * removes the workspace's entry entirely.
 */
import { useEffect, useState } from 'react'
import type { BoardController, ExecutionOptionsSnapshot } from '../../core/controller.ts'
import { filterModelsByEndpoints } from '../../core/endpoints.ts'
import { modelSelectionKey, parseModelSelectionKey, TASK_PERMISSIONS, type TaskPermission } from '../../core/tasks.ts'
import type { WorkspaceDefaultsPatch } from '../../core/workspace-defaults.ts'
import { withReasoningEffort } from '../reasoning-effort.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import css from '../board.module.css'
import { EndpointOrderEditor } from './EndpointOrderEditor.tsx'
import { ModalShell } from './TaskForm.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { ReasoningEffortPicker } from './ReasoningEffortPicker.tsx'

/** Workspace default-settings overlay. */
export function WorkspaceDefaultsModal({ controller, workspaceId, title, onClose }: {
  controller: BoardController
  workspaceId: string
  /** Display title of the workspace the defaults belong to. */
  title: string
  onClose: () => void
}) {
  const [options, setOptions] = useState<ExecutionOptionsSnapshot>(controller.getSnapshot().executionOptions)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)

  // The picker option sets arrive from the runtime after mount; follow them
  // so the pickers never freeze on an empty snapshot.
  useEffect(
    () => controller.subscribe(() => {
      setOptions(controller.getSnapshot().executionOptions)
    }),
    [controller],
  )

  // The current defaults are read once at mount (the modal only opens after
  // the board has synced with the Host) and seed the form fields.
  const [mode, setMode] = useState(() => controller.getSnapshot().workspaceDefaults[workspaceId]?.mode ?? '')
  const [modelKey, setModelKey] = useState(() => {
    const model = controller.getSnapshot().workspaceDefaults[workspaceId]?.model
    return model === undefined ? '' : modelSelectionKey(model)
  })
  const [reasoningEffort, setReasoningEffort] = useState(() => controller.getSnapshot().workspaceDefaults[workspaceId]?.model?.reasoningEffort ?? '')
  const [endpoints, setEndpoints] = useState<string[]>(() => [...(controller.getSnapshot().workspaceDefaults[workspaceId]?.endpoints ?? [])])
  const [permission, setPermission] = useState(() => controller.getSnapshot().workspaceDefaults[workspaceId]?.permission ?? '')
  const [unapproved, setUnapproved] = useState(() => controller.getSnapshot().workspaceDefaults[workspaceId]?.approved === false)

  const submit = async (): Promise<void> => {
    setPending(true)
    // The editor sends the full desired state: a blank field explicitly
    // clears the stored default (null), so saving an empty form removes the
    // workspace's entry instead of being a no-op.
    const model = modelKey === '' ? null : withReasoningEffort(parseModelSelectionKey(modelKey)!, reasoningEffort)
    const patch: WorkspaceDefaultsPatch = {
      mode: mode === '' ? null : mode,
      model,
      endpoints: endpoints.length === 0 ? null : endpoints,
      permission: permission === '' ? null : permission as TaskPermission,
      approved: unapproved ? false : null,
    }
    const accepted = await controller.setWorkspaceDefaults(workspaceId, patch)
    if (!accepted) {
      setPending(false)
      setError(t('grid.saveFailed', { error: controller.getSnapshot().transportError ?? 'unknown' }))
      return
    }
    onClose()
  }

  // The model dropdown is constrained by the pinned endpoints, exactly like
  // the new-task modal: only models at least one pinned endpoint serves are
  // offered; a current value outside that set stays selectable as a stale row
  // so the saved default is never a silent surprise.
  const servableModels = filterModelsByEndpoints(options.models, options.endpoints, endpoints)
  const modelInCatalog = modelKey === '' || options.models.some(model =>
    modelSelectionKey({ provider: model.provider, model: model.model }) === modelKey)
  const modelServable = modelKey === '' || servableModels.some(model =>
    modelSelectionKey({ provider: model.provider, model: model.model }) === modelKey)
  const modelStale = modelKey !== '' && !modelServable
  const modelStaleLabel = modelStale
    ? (modelInCatalog ? t('exec.model.notServed') : t('exec.model.removed'))
    : undefined
  const modelStaleHint = modelStale && modelInCatalog ? t('exec.model.endpointHint') : undefined

  return (
    <ModalShell
      ariaLabel={t('grid.settingsTitle')}
      title={`${t('grid.settingsTitle')} · ${title}`}
      error={error}
      pending={pending}
      submitLabel={t('settings.save')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
    >
      <p className={css.settingsHint}>{t('grid.settingsHint')}</p>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.mode')}</span>
        <select
          className={css.select}
          value={mode}
          onChange={event => { setMode(event.target.value) }}
        >
          <option value="">{t('exec.mode.default')}</option>
          {options.presets.map(preset => (
            <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
              {preset.name ?? preset.id}
              {preset.isDefault ? t('exec.mode.defaultSuffix') : ''}
              {preset.broken !== undefined ? t('exec.mode.brokenSuffix') : ''}
            </option>
          ))}
        </select>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.model')}</span>
        <ModelPicker
          models={servableModels}
          value={modelKey}
          onChange={setModelKey}
          staleLabel={modelStaleLabel}
          staleHint={modelStaleHint}
        />
      </label>

      {modelKey !== '' && (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.model.effort')}</span>
          <ReasoningEffortPicker value={reasoningEffort} onChange={setReasoningEffort} />
        </label>
      )}

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.endpoints')}</span>
        <EndpointOrderEditor endpoints={endpoints} options={options.endpoints} onChange={setEndpoints} />
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.permission')}</span>
        <select
          className={css.select}
          value={permission}
          onChange={event => { setPermission(event.target.value) }}
        >
          <option value="">{t('exec.permission.default')}</option>
          {TASK_PERMISSIONS.map(id => (
            <option key={id} value={id}>{t(`exec.permission.${id}` as TaskBoardKey)}</option>
          ))}
        </select>
      </label>

      <label className={css.scheduleToggle} title={t('grid.approvedDefaultHint')}>
        <input
          type="checkbox"
          checked={unapproved}
          onChange={event => { setUnapproved(event.target.checked) }}
        />
        <span>{t('grid.approvedDefault')}</span>
      </label>
    </ModalShell>
  )
}
