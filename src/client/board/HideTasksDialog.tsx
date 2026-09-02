/**
 * Hide-settled-tasks dialog: the confirm step of hiding settled tasks — from
 * a Done/Failed column, one group's settled members in a column, or a single
 * task card. Lists every task the hide will archive (they leave the column
 * for the Archive view, restorable later) and offers to also archive their
 * DSH execution sessions — checked by default, because this is the "clear old
 * tasks and their sessions in one go" flow. The candidate list is derived
 * from the live snapshot on every render, so after a slice of a very long
 * column is hidden (or another tab hides some) the dialog shows exactly what
 * is still waiting to be hidden.
 */
import { useState } from 'react'
import type { TaskRecord, TaskStatus } from '../../core/tasks.ts'
import { collectExecutionSessionIds } from '../../core/use-cases/task-archive.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { STATUS_KEY } from './status-key.ts'
import { matchesWorkspace } from './workspace-filter.ts'

/** How many task titles the dialog lists before collapsing into "+N more". */
const HIDE_PREVIEW_LIMIT = 40

/** Confirm step props. */
export interface HideTasksDialogProps {
  /** The column the hidden tasks sit in (`done` or `failed`), for the message. */
  status: TaskStatus
  /**
   * The task ids the hide was opened for (a whole column, one group's members
   * in that column, or a single card). The dialog re-derives what still needs
   * hiding from the live snapshot, so already-hidden or moved tasks drop out.
   */
  ids: readonly string[]
  /** Board-visible tasks (vanished-workspace tasks already filtered out). */
  tasks: readonly TaskRecord[]
  /** The active workspace scope (undefined = the All-tasks overview). */
  workspaceId: string | undefined
  /** Latest Host transport error, shown when a hide attempt was refused. */
  transportError?: string
  /**
   * Hide (archive) the given settled task ids, archiving their execution
   * sessions in DSH too when `archiveSessions` is true. Resolves true when
   * every request slice was accepted.
   */
  onHide: (taskIds: readonly string[], archiveSessions: boolean) => Promise<boolean>
  onCancel: () => void
}

/** Confirm overlay for hiding settled tasks. */
export function HideTasksDialog({ status, ids, tasks, workspaceId, transportError, onHide, onCancel }: HideTasksDialogProps) {
  // Candidates are recomputed from the live snapshot every render: a hide
  // that ran (or another tab) shrinks the list, so the dialog always shows
  // exactly what still needs hiding.
  const wanted = new Set(ids)
  const candidates = tasks.filter(task =>
    task.archivedAt === undefined
    && task.status === status
    && wanted.has(task.id)
    && matchesWorkspace(task, workspaceId))
  const taskIds = candidates.map(task => task.id)
  const sessionIds = collectExecutionSessionIds(tasks, taskIds)
  const columnLabel = t(STATUS_KEY[status])
  // Default the session-archive option on: the dialog's whole point is the
  // one-shot clear of old tasks and the sessions they ran in. It stays
  // disabled (and uncheckable) when no execution recorded a session id.
  const [archiveSessions, setArchiveSessions] = useState(sessionIds.length > 0)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState(false)
  const error = transportError ?? (localError ? t('hide.failed') : undefined)

  const confirm = async (): Promise<void> => {
    if (taskIds.length === 0 || busy) return
    setBusy(true)
    setLocalError(false)
    try {
      if (await onHide(taskIds, archiveSessions)) onCancel()
      else setLocalError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <div className={css.modal} role="alertdialog" aria-label={t('hide.title')}>
        <h2 className={css.modalTitle}>{t('hide.title')}</h2>
        <p className={css.confirmMessage}>{t('hide.message', { column: columnLabel, count: String(candidates.length) })}</p>
        {candidates.length === 0 ? (
          <p className={css.confirmMessage}>{t('hide.empty')}</p>
        ) : (
          <ul className={css.hideList}>
            {candidates.slice(0, HIDE_PREVIEW_LIMIT).map(task => (
              <li key={task.id} className={css.hideRow} title={task.title}>
                <span className={css.hideRowTitle}>{task.title}</span>
              </li>
            ))}
            {candidates.length > HIDE_PREVIEW_LIMIT && (
              <li className={css.hideRow} aria-hidden="true">
                <span className={css.hideRowMore}>{t('hide.more', { count: String(candidates.length - HIDE_PREVIEW_LIMIT) })}</span>
              </li>
            )}
          </ul>
        )}
        <label className={`${css.hideSessionOption}${sessionIds.length === 0 ? ` ${css.hideSessionOptionDisabled}` : ''}`}>
          <input
            type="checkbox"
            checked={archiveSessions}
            disabled={sessionIds.length === 0 || busy}
            onChange={event => { setArchiveSessions(event.target.checked) }}
          />
          <span>{t('hide.sessions', { count: String(sessionIds.length) })}</span>
        </label>
        <p className={css.fieldHint}>{t('hide.sessionsHint')}</p>
        {error !== undefined && (
          <p className={css.formError}>{error}</p>
        )}
        <footer className={css.modalFooter}>
          <button type="button" className={css.ghostButton} disabled={busy} onClick={onCancel}>
            {t('delete.cancel')}
          </button>
          <button
            type="button"
            className={css.primaryButton}
            disabled={busy || candidates.length === 0}
            onClick={() => { void confirm() }}
          >
            {busy ? t('hide.hiding') : t('hide.confirm', { count: String(candidates.length) })}
          </button>
        </footer>
      </div>
    </div>
  )
}
