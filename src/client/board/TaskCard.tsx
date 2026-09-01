/**
 * Task card: the board's column item. Clicking opens the task detail — it
 * never executes anything directly (detail holds the Run button).
 *
 * Memoized: the card re-renders only when its own task record changes, so a
 * status/filter update on one card (or scrolling) never re-renders every
 * card on the board. The per-card onClick is built with a stable task reference
 * by the board, so the memo boundary is effective.
 */
import { memo } from 'react'
import type { TaskRecord } from '../../core/tasks.ts'
import { executionLabel } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

/** A 1x1 transparent GIF: hides the native drag ghost so the board can draw its own. */
const TRANSPARENT_DRAG_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** The drag payload for one task card (`task:<id>` — see the board's drop handlers). */
export function taskDragPayload(taskId: string): string {
  return `task:${taskId}`
}

/** Parse a `task:<id>` drag payload; undefined when it is not a task payload. */
export function parseTaskDragPayload(payload: string): string | undefined {
  return payload.startsWith('task:') ? payload.slice('task:'.length) : undefined
}

/** Compact relative/absolute time label. */
export function formatHostTimestamp(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

export function formatTime(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (timeZone !== undefined) return formatHostTimestamp(ms, timeZone)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function TaskCardInner({ task, pending, timeZone, onClick, onDragStart }: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  onClick: () => void
  /** Board-level drag hook: payload + the source rect (for the custom ghost). */
  onDragStart?: (payload: string, rect: { x: number; y: number; width: number; height: number }, html: string) => void
}) {
  const latest = task.executions[task.executions.length - 1]
  const runs = task.executions.length
  const archived = task.archivedAt !== undefined
  const paused = !archived && task.status === 'running' && latest?.pausedAt !== undefined
  const isDraggable = !archived && task.status !== 'running' && !pending

  return (
    <button
      type="button"
      className={css.card}
      data-status={archived ? 'archived' : task.status}
      data-paused={paused || undefined}
      data-dsh-part="card"
      data-task-id={task.id}
      data-pending={pending || undefined}
      draggable={isDraggable}
      onDragStart={isDraggable ? (event) => {
        event.dataTransfer.setData('text/plain', taskDragPayload(task.id))
        event.dataTransfer.effectAllowed = 'move'
        // Hide the native square ghost; the board draws a fluid clone instead.
        const image = new Image()
        image.src = TRANSPARENT_DRAG_IMAGE
        event.dataTransfer.setDragImage(image, 0, 0)
        const rect = event.currentTarget.getBoundingClientRect()
        onDragStart?.(taskDragPayload(task.id), {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }, event.currentTarget.outerHTML)
      } : undefined}
      onClick={onClick}
      title={task.description !== '' ? task.description : task.title}
    >
      <span className={css.cardTitle}>{task.title}</span>
      {task.description !== '' && <span className={css.cardExcerpt}>{task.description}</span>}
      <span className={css.cardMeta}>
        <span className={css.cardTime}>{t('board.updated')} {formatTime(task.updatedAt)}</span>
        {!archived && (task.approved === false
          ? (
            <span className={css.cardUnapproved} title={t('card.unapprovedHint')}>
              {t('card.unapproved')}
            </span>
          )
          : (
            <span className={css.cardApproved} title={t('card.approvedHint')}>
              {t('card.approved')}
            </span>
          ))}
        {!archived && task.schedule?.enabled === true && (
          <span
            className={css.cardSchedule}
            title={task.schedule.nextRunAt !== undefined
              ? `${t('card.scheduled')} · ${formatHostTimestamp(task.schedule.nextRunAt, timeZone)}`
              : t('card.scheduled')}
          >
            {t('card.scheduled')}
          </span>
        )}
        {latest !== undefined && (
          <span className={css.cardRun} data-result={archived ? undefined : latest.result}>
            {runs} {t('board.runs')}
          </span>
        )}
        {latest?.sessionId !== undefined && (
          <span className={css.cardSession} title={latest.sessionId}>⌁</span>
        )}
        {paused && (
          <span className={css.cardPaused} title={t('detail.pause')}>
            ⏸ {t('card.paused')}
          </span>
        )}
        {!archived && !paused && (task.status === 'running' || pending) && <span className={css.cardSpinner} aria-hidden="true" />}
      </span>
      {!archived && pending && <span className={css.cardRunningLabel}>{t('board.pending')}…</span>}
      {!archived && latest !== undefined && executionLabel(latest) === 'running' && (
        latest.pausedAt !== undefined
          ? <span className={css.cardRunningLabel} data-paused="">{t('detail.result.paused')}</span>
          : latest.queuedAt !== undefined && latest.sessionId === undefined
            ? <span className={css.cardRunningLabel}>{t(latest.queuedReason === 'group'
              ? 'detail.result.waitingGroup'
              : latest.queuedReason === 'window' ? 'detail.result.waitingWindow'
                : latest.queuedReason === 'workspace' ? 'detail.result.waitingWorkspace'
                  : 'detail.result.waiting')}</span>
            : <span className={css.cardRunningLabel}>{t('detail.result.running')}…</span>
      )}
    </button>
  )
}

/** Memoized card: re-renders only when the card's own task record changes. */
export const TaskCard = memo(TaskCardInner)
