/**
 * New-task modal: title + description + the prompt that execution will send.
 * Creates through the Host and closes only after the Host confirms it.
 */
import { useEffect, useState } from 'react'
import type { BoardController, ExecutionModelOption } from '../../core/controller.ts'
import { groupExecutionModelOptions } from '../../core/controller.ts'
import { isValidCron, nextRunAtMs } from '../../core/schedule.ts'
import { modelSelectionKey, parseModelSelectionKey, TASK_PERMISSIONS, type TaskPermission } from '../../core/tasks.ts'
import { withReasoningEffort } from '../reasoning-effort.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { SCHEDULE_PRESETS } from '../schedule-presets.ts'
import { EndpointOrderEditor } from './EndpointOrderEditor.tsx'
import { ModalShell, TaskContentFields } from './TaskForm.tsx'
import { ReasoningEffortPicker } from './ReasoningEffortPicker.tsx'
import css from '../board.module.css'

/** The model picker: one "deployment default" option plus one optgroup per provider. */
function ModelPicker({ models, value, onChange }: {
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

/** New-task form overlay. */
export function NewTaskModal({ controller, onClose }: { controller: BoardController; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [mode, setMode] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [endpoints, setEndpoints] = useState<string[]>([])
  const [groupId, setGroupId] = useState('')
  const [permission, setPermission] = useState('')
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
            {groups.map(group => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
        </label>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.workspace')}</span>
          <select
            className={css.select}
            value={workspaceId}
            onChange={event => { setWorkspaceId(event.target.value) }}
          >
            <option value="">{t('exec.workspace.recent')}</option>
            {options.workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </select>
        </label>

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
          <ModelPicker models={options.models} value={modelKey} onChange={setModelKey} />
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
