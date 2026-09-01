/**
 * Group modal: create or edit a task group — name, execution mode
 * (sequential/parallel with a parallel cap), endpoint list, allowed-hours
 * window, off-peak-only flag, and the group cron — plus, when editing, the
 * member order (up/down) with per-member removal and group deletion.
 *
 * Groups are ledger entities (not plugin settings), so every change goes
 * through the Host actions; the modal closes only after the Host confirms.
 * Groups are workspace-scoped: a new group belongs to the workspace the
 * modal was opened from (`workspaceId`; absent = the unassigned scope), and
 * that scope is fixed for the group's life.
 */
import { useEffect, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { parseClock } from '../../core/endpoints.ts'
import { isValidCron, nextRunAtMs } from '../../core/schedule.ts'
import type { GroupExecutionMode, TaskGroupRecord } from '../../core/groups.ts'
import { t } from '../locales.ts'
import { SCHEDULE_PRESETS } from '../schedule-presets.ts'
import css from '../board.module.css'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { EndpointOrderEditor } from './EndpointOrderEditor.tsx'
import { ModalShell } from './TaskForm.tsx'

export function GroupModal({ controller, group, workspaceId, onClose }: {
  controller: BoardController
  /** Present when editing an existing group; absent when creating. */
  group?: TaskGroupRecord
  /** The workspace a NEW group is created in (the kanban's scope); absent = the unassigned scope. */
  workspaceId?: string
  onClose: () => void
}) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )

  const [name, setName] = useState(group?.name ?? '')
  const [mode, setMode] = useState<GroupExecutionMode>(group?.mode ?? 'sequential')
  const [maxParallel, setMaxParallel] = useState(group?.maxParallel === undefined ? '' : String(group.maxParallel))
  const [endpoints, setEndpoints] = useState<string[]>(group?.endpoints ?? [])
  const [windowEnabled, setWindowEnabled] = useState(group?.allowedHours !== undefined)
  const [windowStart, setWindowStart] = useState(group?.allowedHours?.start ?? '')
  const [windowEnd, setWindowEnd] = useState(group?.allowedHours?.end ?? '')
  const [offPeakOnly, setOffPeakOnly] = useState(group?.offPeakOnly ?? false)
  const [maintainSession, setMaintainSession] = useState(group?.maintainSession === true)
  const [compactBetween, setCompactBetween] = useState(group?.compactBetween === true)
  const [scheduleEnabled, setScheduleEnabled] = useState(group?.schedule?.enabled ?? false)
  const [scheduleCron, setScheduleCron] = useState(group?.schedule?.cron ?? '')
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const editing = group !== undefined
  // The group's scope is fixed at creation: an existing group shows its own,
  // a new one is bound to the workspace the modal was opened from.
  const scope = group?.workspaceId ?? workspaceId
  const scopeLabel = scope === undefined
    ? t('group.workspaceNone')
    : snapshot.executionOptions.workspaces.find(workspace => workspace.workspaceId === scope)?.title ?? scope
  // Archived members cannot be ungrouped or reordered through update-task
  // (archived tasks are read-only), so keep them out of the order editor.
  const members = editing ? controller.groupMembers(group.id).filter(member => member.archivedAt === undefined) : []

  const scheduleNextRun = scheduleEnabled && scheduleCron.trim() !== '' && isValidCron(scheduleCron)
    ? nextRunAtMs(scheduleCron, Date.now())
    : undefined

  const validate = (): string | undefined => {
    if (name.trim() === '') return t('new.required')
    if (windowEnabled) {
      if (parseClock(windowStart) === undefined || parseClock(windowEnd) === undefined) {
        return t('group.allowedHours') + ': HH:MM'
      }
    }
    if (scheduleEnabled && (scheduleCron.trim() === '' || !isValidCron(scheduleCron))) {
      return t('detail.schedule.invalid')
    }
    const parsed = maxParallel.trim() === '' ? undefined : Number(maxParallel)
    if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1)) {
      return t('settings.invalidNumber')
    }
    return undefined
  }

  const submit = async (): Promise<void> => {
    const problem = validate()
    if (problem !== undefined) {
      setError(problem)
      return
    }
    setPending(true)
    setError(undefined)
    const accepted = editing
      ? await controller.updateGroup(group!.id, {
        name: name.trim(),
        mode,
        maxParallel: maxParallel.trim() === '' ? null : Number(maxParallel),
        endpoints: endpoints.length === 0 ? null : endpoints,
        allowedHours: !windowEnabled ? null : { start: windowStart, end: windowEnd },
        offPeakOnly,
        maintainSession: mode === 'sequential' && maintainSession,
        compactBetween: mode === 'sequential' && maintainSession && compactBetween,
        schedule: scheduleEnabled ? { enabled: true, cron: scheduleCron.trim() } : null,
      })
      : (await controller.createGroupConfirmed({
        name: name.trim(),
        ...(scope === undefined ? {} : { workspaceId: scope }),
        mode,
        ...(maxParallel.trim() === '' ? {} : { maxParallel: Number(maxParallel) }),
        ...(endpoints.length === 0 ? {} : { endpoints }),
        ...(!windowEnabled ? {} : { allowedHours: { start: windowStart, end: windowEnd } }),
        offPeakOnly,
        ...(mode === 'sequential' && maintainSession ? { maintainSession: true } : {}),
        ...(mode === 'sequential' && maintainSession && compactBetween ? { compactBetween: true } : {}),
        ...(scheduleEnabled ? { schedule: { enabled: true, cron: scheduleCron.trim() } } : {}),
      })) !== undefined
    if (!accepted) {
      setPending(false)
      setError(controller.getSnapshot().transportError ?? t('new.required'))
      return
    }
    onClose()
  }

  const reorder = (index: number, delta: number): void => {
    if (!editing) return
    const ids = members.map(member => member.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    void controller.setGroupOrder(group!.id, ids)
  }

  return (
    <ModalShell
      ariaLabel={editing ? t('group.edit') : t('group.create')}
      title={editing ? t('group.edit') : t('group.create')}
      error={error}
      pending={pending}
      submitLabel={editing ? t('edit.save') : t('new.submit')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
    >
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('group.name')}</span>
        <input
          className={css.input}
          value={name}
          autoFocus
          onChange={event => { setName(event.target.value); setError(undefined) }}
        />
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('group.workspace')}</span>
        <select className={css.select} value={scope ?? ''} disabled>
          <option value={scope ?? ''}>{scopeLabel}</option>
        </select>
        <span className={css.detailText}>{t('group.workspaceHint')}</span>
      </label>

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('group.mode')}</span>
        <select
          className={css.select}
          value={mode}
          onChange={event => { setMode(event.target.value as GroupExecutionMode) }}
        >
          <option value="sequential">{t('group.mode.sequential')}</option>
          <option value="parallel">{t('group.mode.parallel')}</option>
        </select>
        <span className={css.detailText}>{t('group.modeHint')}</span>
      </label>

      {mode === 'parallel' && (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('group.maxParallel')}</span>
          <input
            className={css.input}
            inputMode="numeric"
            value={maxParallel}
            placeholder={t('group.maxParallelHint')}
            onChange={event => { setMaxParallel(event.target.value) }}
          />
        </label>
      )}

      {mode === 'sequential' && (
        <>
          <label className={css.scheduleToggle}>
            <input
              type="checkbox"
              checked={maintainSession}
              onChange={event => {
                setMaintainSession(event.target.checked)
                if (!event.target.checked) setCompactBetween(false)
              }}
            />
            <span>{t('group.maintainSession')}</span>
          </label>
          <p className={css.detailText}>{t('group.maintainSessionHint')}</p>
          {maintainSession && (
            <>
              <label className={css.scheduleToggle}>
                <input
                  type="checkbox"
                  checked={compactBetween}
                  onChange={event => { setCompactBetween(event.target.checked) }}
                />
                <span>{t('group.compactBetween')}</span>
              </label>
              <p className={css.detailText}>{t('group.compactBetweenHint')}</p>
            </>
          )}
        </>
      )}

      <label className={css.field}>
        <span className={css.fieldLabel}>{t('group.endpoints')}</span>
        <EndpointOrderEditor endpoints={endpoints} options={snapshot.executionOptions.endpoints} onChange={setEndpoints} />
      </label>

      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={windowEnabled}
          onChange={event => { setWindowEnabled(event.target.checked) }}
        />
        <span>{t('group.allowedHours')}</span>
      </label>
      {windowEnabled && (
        <div className={css.scheduleRow}>
          <input
            className={css.input}
            type="time"
            value={windowStart}
            aria-label={t('group.allowedStart')}
            onChange={event => { setWindowStart(event.target.value) }}
          />
          <input
            className={css.input}
            type="time"
            value={windowEnd}
            aria-label={t('group.allowedEnd')}
            onChange={event => { setWindowEnd(event.target.value) }}
          />
        </div>
      )}
      <p className={css.detailText}>{t('group.allowedHoursHint')}</p>

      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={offPeakOnly}
          onChange={event => { setOffPeakOnly(event.target.checked) }}
        />
        <span>{t('group.offPeakOnly')}</span>
      </label>
      <p className={css.detailText}>{t('group.offPeakHint')}</p>

      <section className={css.detailSection}>
        <h4>{t('detail.schedule')}</h4>
        <label className={css.scheduleToggle}>
          <input
            type="checkbox"
            checked={scheduleEnabled}
            onChange={event => { setScheduleEnabled(event.target.checked) }}
          />
          <span>{t('group.scheduleEnable')}</span>
        </label>
        {scheduleEnabled && (
          <>
            <div className={css.scheduleRow}>
              <input
                className={`${css.input} ${css.scheduleInput}`}
                value={scheduleCron}
                placeholder="0 9 * * *"
                spellCheck={false}
                aria-label={t('detail.schedule.cron')}
                onChange={event => { setScheduleCron(event.target.value) }}
              />
              <select
                className={css.schedulePreset}
                value=""
                aria-label={t('detail.schedule.presets')}
                onChange={event => {
                  if (event.target.value === '') return
                  setScheduleCron(event.target.value)
                }}
              >
                <option value="">{t('detail.schedule.presets')}…</option>
                {SCHEDULE_PRESETS.map(preset => (
                  <option key={preset.cron} value={preset.cron}>{t(preset.label)}</option>
                ))}
              </select>
            </div>
            {scheduleNextRun !== undefined && (
              <p className={css.scheduleMeta}>
                {t('detail.schedule.nextRun')} {new Date(scheduleNextRun).toLocaleString()}
              </p>
            )}
          </>
        )}
      </section>

      {editing && members.length > 0 && (
        <section className={css.detailSection}>
          <h4>{t('group.members')}</h4>
          <p className={css.detailText}>{t('group.membersHint')}</p>
          <ol className={css.endpointOrderList}>
            {members.map((member, index) => (
              <li key={member.id} className={css.endpointOrderRow}>
                <span className={css.endpointOrderName}>{member.title}</span>
                <span className={css.endpointOrderActions}>
                  <button
                    type="button"
                    className={css.ghostButton}
                    disabled={index === 0}
                    aria-label={t('group.memberMoveUp')}
                    onClick={() => { reorder(index, -1) }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={css.ghostButton}
                    disabled={index === members.length - 1}
                    aria-label={t('group.memberMoveDown')}
                    onClick={() => { reorder(index, 1) }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={css.ghostButton}
                    aria-label={t('group.memberRemove')}
                    onClick={() => { void controller.updateTask(member.id, { groupId: null }) }}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {editing && members.length === 0 && (
        <p className={css.detailText}>{t('group.emptyMembers')}</p>
      )}

      {editing && (
        <button
          type="button"
          className={css.dangerButton}
          onClick={() => { setConfirmDelete(true) }}
        >
          {t('group.delete')}
        </button>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t('group.delete')}
          message={t('group.deleteConfirm', { name: group!.name })}
          confirmLabel={t('group.delete')}
          danger
          onCancel={() => { setConfirmDelete(false) }}
          onConfirm={() => {
            setConfirmDelete(false)
            void controller.deleteGroup(group!.id).then(() => { onClose() })
          }}
        />
      )}
    </ModalShell>
  )
}
