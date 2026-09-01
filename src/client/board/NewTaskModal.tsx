/**
 * New-task modal: title + description + the prompt that execution will send.
 * Creates through the Host and closes only after the Host confirms it.
 * When opened from a workspace's kanban the workspace is pre-selected and the
 * workspace's execution defaults pre-fill the target pickers (see the
 * WorkspaceDefaultsModal editor).
 */
import { useEffect, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { filterModelsByEndpoints } from '../../core/endpoints.ts'
import { isValidCron, nextRunAtMs } from '../../core/schedule.ts'
import { modelSelectionKey, parseModelSelectionKey, TASK_PERMISSIONS, type TaskPermission } from '../../core/tasks.ts'
import type { WorkspaceDefaultsRecord } from '../../core/workspace-defaults.ts'
import { withReasoningEffort } from '../reasoning-effort.ts'
import { t, type AllTasksKey } from '../locales.ts'
import { SCHEDULE_PRESETS } from '../schedule-presets.ts'
import { EndpointOrderEditor } from './EndpointOrderEditor.tsx'
import { ModalShell, TaskContentFields } from './TaskForm.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { ReasoningEffortPicker } from './ReasoningEffortPicker.tsx'
import css from '../board.module.css'

/** New-task form overlay. */
export function NewTaskModal({ controller, onClose, defaultWorkspaceId, defaults }: {
  controller: BoardController
  onClose: () => void
  /** Workspace pre-selected in the workspace picker (the kanban's workspace). */
  defaultWorkspaceId?: string
  /** Workspace execution defaults to pre-fill the execution-target pickers. */
  defaults?: WorkspaceDefaultsRecord
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? '')
  const [mode, setMode] = useState(defaults?.mode ?? '')
  const [modelKey, setModelKey] = useState(defaults?.model === undefined ? '' : modelSelectionKey(defaults.model))
  const [reasoningEffort, setReasoningEffort] = useState(defaults?.model?.reasoningEffort ?? '')
  const [endpoints, setEndpoints] = useState<string[]>(defaults?.endpoints ? [...defaults.endpoints] : [])
  const [groupId, setGroupId] = useState('')
  const [permission, setPermission] = useState(defaults?.permission ?? '')
  // Approval defaults to on (tasks start approved); the workspace default can
  // pin them to start unapproved instead.
  const [approved, setApproved] = useState(defaults?.approved !== false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleCron, setScheduleCron] = useState('')
  const [scheduleError, setScheduleError] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [options, setOptions] = useState(controller.getSnapshot().executionOptions)
  const [groups, setGroups] = useState(controller.getSnapshot().groups)

  // The workspace list, preset roster, model catalog, and group roster arrive
  // from the runtime after mount; follow them so the pickers never freeze on
  // an empty snapshot.
  useEffect(
    () => controller.subscribe(() => {
      const snapshot = controller.getSnapshot()
      setOptions(snapshot.executionOptions)
      setGroups(snapshot.groups)
    }),
    [controller],
  )

  const submit = async (): Promise<void> => {
    if (scheduleEnabled) {
      const cron = scheduleCron.trim()
      if (cron === '' || !isValidCron(cron)) {
        setScheduleError(t('detail.schedule.invalid'))
        return
      }
    }
    setPending(true)
    const model = modelKey === '' ? undefined : parseModelSelectionKey(modelKey)
    const task = await controller.createTaskConfirmed({
      title,
      description,
      prompt,
      workspaceId: workspaceId === '' ? undefined : workspaceId,
      mode: mode === '' ? undefined : mode,
      model: model === undefined ? undefined : withReasoningEffort(model, reasoningEffort),
      endpoints: endpoints.length === 0 ? undefined : endpoints,
      groupId: groupId === '' ? undefined : groupId,
      permission: permission === '' ? undefined : permission as TaskPermission,
      schedule: scheduleEnabled ? { enabled: true, cron: scheduleCron.trim() } : undefined,
      // Manual creation defaults to approved; turning the toggle off mints an
      // unapproved task (it cannot run until approved).
      ...(approved ? {} : { approved: false as const }),
    })
    if (task === undefined) {
      setPending(false)
      setError(controller.getSnapshot().transportError ?? t('new.required'))
      return
    }
    onClose()
  }

  /** Next-run preview for a valid armed cron (creation-time only). */
  const scheduleNextRun = scheduleEnabled && scheduleCron.trim() !== '' && isValidCron(scheduleCron)
    ? nextRunAtMs(scheduleCron, Date.now())
    : undefined

  // Groups are workspace-scoped: the picker offers only the groups of the
  // selected workspace (no selection = the unassigned scope).
  const workspaceScope = workspaceId === '' ? undefined : workspaceId
  const scopeGroups = groups.filter(group => group.workspaceId === workspaceScope)

  const changeWorkspace = (next: string): void => {
    setWorkspaceId(next)
    // A group picked for the previous workspace cannot follow the task into
    // another scope (membership is workspace-locked Host-side).
    const nextScope = next === '' ? undefined : next
    if (groupId !== '' && !groups.some(group => group.id === groupId && group.workspaceId === nextScope)) {
      setGroupId('')
    }
  }

  // The model dropdown is constrained by the pinned endpoints: only models at
  // least one pinned endpoint serves are offered (a blank pin = deployment
  // default, which the router resolves to the endpoint's default model). A
  // current value that survives the filter keeps its normal option; one that
  // does not stays selectable as a stale row — "not served by pinned
  // endpoints" when the catalog still knows it, "removed" when it is gone —
  // so the user sees exactly what the task will ask for instead of a silent
  // substitution.
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
      ariaLabel={t('board.new')}
      title={t('board.new')}
      error={error}
      pending={pending}
      submitLabel={t('new.submit')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
    >
      <TaskContentFields
        title={title}
        description={description}
        prompt={prompt}
        onTitleChange={value => { setTitle(value); setError(undefined) }}
        onDescriptionChange={setDescription}
        onPromptChange={setPrompt}
      />

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.group')}</span>
          <select
            className={css.select}
            value={groupId}
            onChange={event => { setGroupId(event.target.value) }}
          >
            <option value="">{t('exec.group.default')}</option>
            {scopeGroups.map(group => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.workspace')}</span>
          <select
            className={css.select}
            value={workspaceId}
            onChange={event => { changeWorkspace(event.target.value) }}
          >
            <option value="">{t('exec.workspace.recent')}</option>
            {options.workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
            {/* A pre-selected workspace may be gone from the live list (deleted); keep it selectable. */}
            {workspaceId !== '' && !options.workspaces.some(workspace => workspace.workspaceId === workspaceId) && (
              <option value={workspaceId}>{workspaceId}{t('exec.mode.removed')}</option>
            )}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.mode')}</span>
          <select
            className={css.select}
            value={mode}
            onChange={event => { setMode(event.target.value) }}
          >
            <option value="">{t('exec.mode.workspaceDefault')}</option>
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
            blankLabel={t('exec.model.workspaceDefault')}
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
              <option key={id} value={id}>{t(`exec.permission.${id}` as AllTasksKey)}</option>
            ))}
          </select>
        </label>

        <label className={css.approvalToggle} title={t('new.approvedHint')}>
          <input
            type="checkbox"
            role="switch"
            checked={approved}
            onChange={event => { setApproved(event.target.checked) }}
          />
          <span>{t('new.approved')}</span>
        </label>

        <section className={css.detailSection}>
          <h4>{t('detail.schedule')}</h4>
          <label className={css.scheduleToggle}>
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={event => {
                setScheduleEnabled(event.target.checked)
                if (!event.target.checked) setScheduleError(undefined)
              }}
            />
            <span>{t('detail.schedule.enable')}</span>
          </label>
          {scheduleEnabled && (
            <>
              <div className={css.scheduleRow}>
                <input
                  className={`${css.input} ${css.scheduleInput}${scheduleError !== undefined ? ` ${css.scheduleInputInvalid}` : ''}`}
                  value={scheduleCron}
                  placeholder="0 9 * * *"
                  spellCheck={false}
                  aria-label={t('detail.schedule.cron')}
                  onChange={event => { setScheduleCron(event.target.value); setScheduleError(undefined) }}
                />
                <select
                  className={css.schedulePreset}
                  value=""
                  aria-label={t('detail.schedule.presets')}
                  onChange={event => {
                    if (event.target.value === '') return
                    setScheduleCron(event.target.value)
                    setScheduleError(undefined)
                  }}
                >
                  <option value="">{t('detail.schedule.presets')}…</option>
                  {SCHEDULE_PRESETS.map(preset => (
                    <option key={preset.cron} value={preset.cron}>{t(preset.label)}</option>
                  ))}
                </select>
              </div>
              {scheduleError !== undefined && <p className={css.formError}>{scheduleError}</p>}
              {scheduleError === undefined && scheduleNextRun !== undefined && (
                <p className={css.scheduleMeta}>
                  {t('detail.schedule.nextRun')} {new Date(scheduleNextRun).toLocaleString()}
                </p>
              )}
            </>
          )}
        </section>
    </ModalShell>
  )
}
