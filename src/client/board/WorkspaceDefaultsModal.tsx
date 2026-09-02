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
import { modelSelectionKey, parseModelSelectionKey, TASK_PERMISSIONS, type TaskPermission } from '../../core/tasks.ts'
import type { WorkspaceDefaultsPatch } from '../../core/workspace-defaults.ts'
import { withReasoningEffort } from '../reasoning-effort.ts'
import { t, type AllTasksKey } from '../locales.ts'
import css from '../board.module.css'
import { EndpointModelFields } from './EndpointModelFields.tsx'
import { PlanModelField } from './PlanModelField.tsx'
import { ModalShell } from './TaskForm.tsx'

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
  const [planModelKey, setPlanModelKey] = useState(() => {
    const planModel = controller.getSnapshot().workspaceDefaults[workspaceId]?.planModel
    return planModel === undefined ? '' : modelSelectionKey(planModel)
  })
  const [planReasoningEffort, setPlanReasoningEffort] = useState(() => controller.getSnapshot().workspaceDefaults[workspaceId]?.planModel?.reasoningEffort ?? '')
  const [endpoints, setEndpoints] = useState<string[]>(() => [...(controller.getSnapshot().workspaceDefaults[workspaceId]?.endpoints ?? [])])
  const [permission, setPermission] = useState(() => controller.getSnapshot().workspaceDefaults[workspaceId]?.permission ?? '')
  // The approval default reads positively: on (the runtime default) means new
  // tasks start approved; turning it off pins them to start unapproved.
  const [approved, setApproved] = useState(() => controller.getSnapshot().workspaceDefaults[workspaceId]?.approved !== false)

  const submit = async (): Promise<void> => {
    setPending(true)
    // The editor sends the full desired state: a blank field explicitly
    // clears the stored default (null), so saving an empty form removes the
    // workspace's entry instead of being a no-op.
    const model = modelKey === '' ? null : withReasoningEffort(parseModelSelectionKey(modelKey)!, reasoningEffort)
    const planModel = planModelKey === '' ? null : withReasoningEffort(parseModelSelectionKey(planModelKey)!, planReasoningEffort)
    const patch: WorkspaceDefaultsPatch = {
      mode: mode === '' ? null : mode,
      model,
      planModel,
      endpoints: endpoints.length === 0 ? null : endpoints,
      permission: permission === '' ? null : permission as TaskPermission,
      approved: approved ? null : false,
    }
    const accepted = await controller.setWorkspaceDefaults(workspaceId, patch)
    if (!accepted) {
      setPending(false)
      setError(t('grid.saveFailed', { error: controller.getSnapshot().transportError ?? 'unknown' }))
      return
    }
    onClose()
  }

  // The endpoint → model cascade (EndpointModelFields) keeps the model select
  // inside the endpoint selection, exactly like the task forms: only models at
  // least one pinned endpoint serves are offered; a current value outside that
  // set stays selectable as a stale row so the saved default is never a
  // silent surprise.
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

      <EndpointModelFields
        endpoints={endpoints}
        onEndpointsChange={setEndpoints}
        endpointOptions={options.endpoints}
        models={options.models}
        modelKey={modelKey}
        onModelChange={setModelKey}
        effort={reasoningEffort}
        onEffortChange={setReasoningEffort}
      />

      <PlanModelField
        models={options.models}
        modelKey={planModelKey}
        onModelChange={setPlanModelKey}
        modelBlankLabel={t('exec.planModel.none')}
        effort={planReasoningEffort}
        onEffortChange={setPlanReasoningEffort}
        hint={<p className={css.settingsHint}>{t('new.planModelHint')}</p>}
      />

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.permission')}</span>
        <select
          className={css.select}
          value={permission}
          onChange={event => { setPermission(event.target.value) }}
        >
          <option value="">{t('exec.permission.default')}</option>
          {TASK_PERMISSIONS.map(id => (
            <option key={id} value={id}>{t(`exec.permission.${id}` as AllTasksKey)}</option>
          ))}
        </select>
      </label>

      <label className={css.approvalToggle} title={t('grid.approvedDefaultHint')}>
        <input
          type="checkbox"
          role="switch"
          checked={approved}
          onChange={event => { setApproved(event.target.checked) }}
        />
        <span>{t('grid.approvedDefault')}</span>
      </label>
    </ModalShell>
  )
}
