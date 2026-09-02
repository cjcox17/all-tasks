/**
 * New-task modal: title + description + the prompt that execution will send.
 * Creates through the Host and closes only after the Host confirms it.
 * When opened from a workspace's kanban the workspace is pre-selected and the
 * workspace's execution defaults pre-fill the target pickers (see the
 * WorkspaceDefaultsModal editor).
 *
 * While the title is blank and the user types a prompt, a debounced request
 * asks the Host to generate a title from the prompt through a short backend
 * session (see title-suggest); the field fills in when it lands, a manual
 * title always wins, and a prompt-line fallback guarantees creation never
 * blocks on the LLM.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { isValidCron, nextRunAtMs } from '../../core/schedule.ts'
import { fallbackTitle } from '../../core/title.ts'
import { modelSelectionKey, parseModelSelectionKey, TASK_PERMISSIONS, type TaskPermission } from '../../core/tasks.ts'
import type { WorkspaceDefaultsRecord } from '../../core/workspace-defaults.ts'
import { withReasoningEffort } from '../reasoning-effort.ts'
import { t, type AllTasksKey } from '../locales.ts'
import { SCHEDULE_PRESETS } from '../schedule-presets.ts'
import { effectiveDefaultNames } from './execution-default-labels.ts'
import { EndpointModelFields } from './EndpointModelFields.tsx'
import { PlanModelField } from './PlanModelField.tsx'
import { suggestTaskTitleClient } from '../title-suggest.ts'
import { ModalShell, TaskContentFields } from './TaskForm.tsx'
import css from '../board.module.css'

/**
 * Pause before asking the Host for an auto-generated title: long enough that
 * a burst of prompt typing settles into one request, short enough that the
 * title is usually ready by the time the user hits Create.
 */
const TITLE_SUGGEST_DEBOUNCE_MS = 900

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
  const [planModelKey, setPlanModelKey] = useState(defaults?.planModel === undefined ? '' : modelSelectionKey(defaults.planModel))
  const [planReasoningEffort, setPlanReasoningEffort] = useState(defaults?.planModel?.reasoningEffort ?? '')
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
  const [workspaceDefaults, setWorkspaceDefaults] = useState(controller.getSnapshot().workspaceDefaults)
  /** Auto-title lifecycle: idle (nothing to generate), generating, or done. */
  const [titleStatus, setTitleStatus] = useState<'idle' | 'generating' | 'done'>('idle')
  /** Whether the title currently shown came from auto-generation (offers Regenerate). */
  const [autoFilled, setAutoFilled] = useState(false)
  /** The `autoTitle` setting pushed from the client wiring (default on). */
  const [autoTitleEnabled, setAutoTitleEnabled] = useState(true)

  // Live refs so the stable suggestion callback reads current field values
  // without re-creating itself (and re-arming the debounce) on every keystroke.
  const titleRef = useRef(title)
  titleRef.current = title
  const promptRef = useRef(prompt)
  promptRef.current = prompt
  const descriptionRef = useRef(description)
  descriptionRef.current = description
  const modelKeyRef = useRef(modelKey)
  modelKeyRef.current = modelKey
  const effortRef = useRef(reasoningEffort)
  effortRef.current = reasoningEffort
  /** Monotonic id of the newest generation request; stale resolutions are dropped. */
  const generationRef = useRef(0)
  /** Serializes generation: one in-flight Host request at a time. */
  const inFlightRef = useRef(false)

  // The workspace list, preset roster, model catalog, and group roster arrive
  // from the runtime after mount; follow them so the pickers never freeze on
  // an empty snapshot.
  useEffect(
    () => controller.subscribe(() => {
      const snapshot = controller.getSnapshot()
      setOptions(snapshot.executionOptions)
      setGroups(snapshot.groups)
      setWorkspaceDefaults(snapshot.workspaceDefaults)
      setAutoTitleEnabled(snapshot.autoTitle ?? true)
    }),
    [controller],
  )

  /**
   * Ask the Host for a generated title from the current prompt/description
   * and fill the title field when it is still blank. Serialized: a second
   * call while one is in flight is ignored, and a resolution only lands when
   * it is the newest request and the user has not typed a manual title
   * meanwhile. On failure the deterministic prompt-line fallback fills the
   * field, so creation never blocks on the LLM.
   */
  const runSuggestion = useCallback((): void => {
    if (inFlightRef.current) return
    const generationId = ++generationRef.current
    inFlightRef.current = true
    setTitleStatus('generating')
    const key = modelKeyRef.current
    const parsed = key === '' ? undefined : parseModelSelectionKey(key)
    const model = parsed === undefined ? undefined : withReasoningEffort(parsed, effortRef.current)
    void suggestTaskTitleClient({
      prompt: promptRef.current,
      description: descriptionRef.current,
      ...(model === undefined ? {} : { model }),
    }).then((suggested) => {
      if (generationRef.current !== generationId) return
      if (titleRef.current.trim() !== '') return
      // The user cleared the prompt while the request was in flight: no title.
      if (promptRef.current.trim() === '' && descriptionRef.current.trim() === '') {
        setTitleStatus('idle')
        return
      }
      setTitle(suggested)
      setAutoFilled(true)
      setTitleStatus('done')
    }).catch(() => {
      if (generationRef.current !== generationId) return
      if (titleRef.current.trim() !== '') return
      if (promptRef.current.trim() === '' && descriptionRef.current.trim() === '') {
        setTitleStatus('idle')
        return
      }
      const fallback = fallbackTitle(promptRef.current, descriptionRef.current)
      if (fallback !== '') {
        setTitle(fallback)
        setAutoFilled(true)
      }
      setTitleStatus('done')
    }).finally(() => {
      if (generationRef.current === generationId) inFlightRef.current = false
    })
  }, [])

  /**
   * Debounced auto-generation: while the title is blank and the user has
   * typed a prompt (or description), wait for a pause and ask the Host. A
   * manual title always wins — typing one cancels the pending request, and a
   * resolution landing after it is discarded.
   */
  useEffect(() => {
    if (!autoTitleEnabled || inFlightRef.current) return
    if (title.trim() !== '' || (prompt.trim() === '' && description.trim() === '')) {
      setTitleStatus('idle')
      return
    }
    setTitleStatus('generating')
    const timer = globalThis.setTimeout(runSuggestion, TITLE_SUGGEST_DEBOUNCE_MS)
    return () => { globalThis.clearTimeout(timer) }
  }, [autoTitleEnabled, title, prompt, description, runSuggestion])

  /** Re-run generation for the current prompt (a first suggestion may be weak). */
  const regenerateTitle = (): void => {
    setTitle('')
    setAutoFilled(false)
    // The immediate call sets inFlight synchronously, so the debounce effect
    // (re-armed by the cleared title) skips its own scheduling.
    runSuggestion()
  }

  const submit = async (): Promise<void> => {
    if (scheduleEnabled) {
      const cron = scheduleCron.trim()
      if (cron === '' || !isValidCron(cron)) {
        setScheduleError(t('detail.schedule.invalid'))
        return
      }
    }
    // A blank title falls back to the prompt's first line, so creation never
    // blocks on the LLM — a manual title, an auto-generated one, or the
    // prompt-line fallback all satisfy the ledger's non-blank title. A fully
    // blank task still flows through the Host, which rejects it as before.
    const effectiveTitle = title.trim() !== '' ? title : fallbackTitle(prompt, description)
    setPending(true)
    const model = modelKey === '' ? undefined : parseModelSelectionKey(modelKey)
    const planModel = planModelKey === '' ? undefined : parseModelSelectionKey(planModelKey)
    const task = await controller.createTaskConfirmed({
      title: effectiveTitle,
      description,
      prompt,
      workspaceId: workspaceId === '' ? undefined : workspaceId,
      mode: mode === '' ? undefined : mode,
      model: model === undefined ? undefined : withReasoningEffort(model, reasoningEffort),
      planModel: planModel === undefined ? undefined : withReasoningEffort(planModel, planReasoningEffort),
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

  // A blank execution target resolves at run time to the group's default,
  // then the workspace's default (the currently selected workspace), then the
  // deployment default, so name the effective default in the pickers' blank
  // options.
  const defaultNames = effectiveDefaultNames(
    workspaceId === '' ? undefined : workspaceId,
    groupId === '' ? undefined : groupId,
    workspaceDefaults,
    groups,
    options.presets,
    options.models,
  )
  // The worker-model blank option names the effective default (group →
  // workspace); the plan-model blank option names it too, or "no plan phase"
  // when nothing supplies one.
  const workerModelBlank = defaultNames.workerModelSource === 'group'
    ? t('exec.model.groupDefaultWithValue', { value: defaultNames.model ?? '' })
    : defaultNames.workerModelSource === 'workspace'
      ? t('exec.model.workspaceDefaultWithValue', { value: defaultNames.model ?? '' })
      : t('exec.model.workspaceDefault')
  const planModelBlank = defaultNames.planModelSource === 'group'
    ? t('exec.planModel.groupDefaultWithValue', { value: defaultNames.planModel ?? '' })
    : defaultNames.planModelSource === 'workspace'
      ? t('exec.planModel.workspaceDefaultWithValue', { value: defaultNames.planModel ?? '' })
      : t('exec.planModel.none')

  // The endpoint → model cascade (EndpointModelFields) keeps the model select
  // inside the endpoint selection: only models at least one pinned endpoint
  // serves are offered (a blank pin = deployment default, which the router
  // resolves to the endpoint's default model), and a current value the
  // endpoints cannot serve stays selectable as a stale row so the user sees
  // exactly what the task will ask for instead of a silent substitution.

  /**
   * Under the title field: while a generation is pending (or a prompt awaits
   * the debounce) show its status; once a generated title sits in the field
   * offer Regenerate. Nothing renders for a manual title.
   */
  const titleHint = (() => {
    if (title.trim() === '' && (prompt.trim() !== '' || description.trim() !== '') && autoTitleEnabled) {
      return (
        <span className={css.fieldHint} role="status">
          {titleStatus === 'generating' ? t('new.titleGenerating') : t('new.titleAutoHint')}
        </span>
      )
    }
    if (autoFilled) {
      return (
        <button type="button" className={css.linkButton} onClick={regenerateTitle}>
          {t('new.titleRegenerate')}
        </button>
      )
    }
    return undefined
  })()

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
        onTitleChange={value => { setTitle(value); setAutoFilled(false); setError(undefined) }}
        onDescriptionChange={setDescription}
        onPromptChange={setPrompt}
        titleHint={titleHint}
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
            <option value="">{defaultNames.mode === undefined ? t('exec.mode.workspaceDefault') : t('exec.mode.workspaceDefaultWithValue', { value: defaultNames.mode })}</option>
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
          modelBlankLabel={workerModelBlank}
          effort={reasoningEffort}
          onEffortChange={setReasoningEffort}
        />

        <PlanModelField
          models={options.models}
          modelKey={planModelKey}
          onModelChange={setPlanModelKey}
          modelBlankLabel={planModelBlank}
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
