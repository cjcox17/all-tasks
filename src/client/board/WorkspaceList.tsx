/**
 * Workspace overview (the board's landing view): an expandable directory in
 * the Monday.com style — one row per workspace (plus an "All tasks" row),
 * each with a color-coded avatar and live task-count pills. Clicking a row
 * opens that workspace's kanban; the ▸ chevron expands the row inline into
 * its groups (colored group bands with mode badge and member count) and its
 * task rows; clicking a task row opens the task detail; the ⚙ button opens
 * the workspace default-settings editor. The list is the first view the
 * board shows; the kanban is always workspace-scoped behind it.
 */
import { useState } from 'react'
import type { TaskGroupRecord } from '../../core/groups.ts'
import type { ExecutionWorkspaceOption } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import css from '../board.module.css'
import {
  countWorkspaceTasks,
  entityHue,
  workspaceListEntries,
  workspaceTaskDirectory,
  type WorkspaceCounts,
} from './workspace-list.ts'

/** The count pills shown on every row (only statuses with tasks), in display order. */
const COUNT_KEYS: readonly { key: TaskBoardKey; field: keyof WorkspaceCounts; status: string }[] = [
  { key: 'grid.count.todo', field: 'todo', status: 'todo' },
  { key: 'grid.count.pending', field: 'pending', status: 'pending' },
  { key: 'grid.count.working', field: 'working', status: 'working' },
  { key: 'grid.count.scheduled', field: 'scheduled', status: 'scheduled' },
  { key: 'grid.count.finished', field: 'finished', status: 'finished' },
  { key: 'grid.count.failed', field: 'failed', status: 'failed' },
]

function CountPill({ status, label, value }: { status: string; label: string; value: number }) {
  return (
    <span className={css.listCount} data-status={status}>
      <span className={css.listCountValue}>{value}</span>
      <span className={css.listCountLabel}>{label}</span>
    </span>
  )
}

/** One task row inside an expanded workspace: status dot + title + badges. */
function TaskRow({ task, pending, onOpen }: { task: TaskRecord; pending: boolean; onOpen: (taskId: string) => void }) {
  return (
    <button
      type="button"
      className={css.taskRow}
      data-dsh-part="task-row"
      data-status={task.status}
      data-pending={pending || undefined}
      onClick={() => { onOpen(task.id) }}
    >
      <span className={css.statusDot} data-status={task.status} aria-hidden="true" />
      <span className={css.taskRowTitle}>{task.title}</span>
      {task.schedule?.enabled === true && <span className={css.cardSchedule}>{t('card.scheduled')}</span>}
      {task.approved === false && <span className={css.cardUnapproved}>{t('card.unapproved')}</span>}
    </button>
  )
}

/** One group band inside an expanded workspace: colored header + member rows. */
function GroupBand({ group, members, hue, onOpenTask, pendingTaskIds }: {
  group: TaskGroupRecord
  members: readonly TaskRecord[]
  hue: number
  onOpenTask: (taskId: string) => void
  pendingTaskIds: readonly string[]
}) {
  return (
    <div
      className={css.groupBand}
      data-dsh-part="workspace-group"
      data-group={group.id}
      style={{ borderLeftColor: `hsl(${hue} 62% 50%)`, backgroundColor: `hsl(${hue} 62% 50% / 0.09)` }}
    >
      <header className={css.groupBandHeader}>
        <span className={css.groupBandName} title={group.name}>{group.name}</span>
        <span className={css.groupBadge} data-mode={group.mode}>
          {group.mode === 'sequential' ? t('group.sequentialBadge') : t('group.parallelBadge')}
        </span>
        {group.stopped === true && <span className={css.groupStopped}>{t('group.stopped')}</span>}
        {group.schedule?.enabled === true && <span className={css.cardSchedule}>{t('card.scheduled')}</span>}
        <span className={css.groupBandCount}>{members.length}</span>
      </header>
      {members.map(task => (
        <TaskRow key={task.id} task={task} pending={pendingTaskIds.includes(task.id)} onOpen={onOpenTask} />
      ))}
    </div>
  )
}

/** The expanded body of one workspace row: its group bands plus ungrouped tasks. */
function WorkspaceBody({ tasks, groups, workspaceId, onOpenTask, pendingTaskIds }: {
  tasks: readonly TaskRecord[]
  groups: readonly TaskGroupRecord[]
  workspaceId: string | undefined
  onOpenTask: (taskId: string) => void
  pendingTaskIds: readonly string[]
}) {
  const directory = workspaceTaskDirectory(tasks, groups, workspaceId)
  const hasContent = directory.grouped.length > 0 || directory.ungrouped.length > 0
  if (!hasContent) {
    return <p className={css.listEmpty}>{t('list.noTasks')}</p>
  }
  return (
    <div className={css.listBody}>
      {directory.grouped.map(({ group, members }) => (
        <GroupBand
          key={group.id}
          group={group}
          members={members}
          hue={entityHue(group.id)}
          onOpenTask={onOpenTask}
          pendingTaskIds={pendingTaskIds}
        />
      ))}
      {directory.ungrouped.length > 0 && (
        <div className={css.groupBand} data-dsh-part="workspace-group">
          <header className={css.groupBandHeader}>
            <span className={css.groupBandName}>{t('list.ungrouped')}</span>
            <span className={css.groupBandCount}>{directory.ungrouped.length}</span>
          </header>
          {directory.ungrouped.map(task => (
            <TaskRow key={task.id} task={task} pending={pendingTaskIds.includes(task.id)} onOpen={onOpenTask} />
          ))}
        </div>
      )}
    </div>
  )
}

export function WorkspaceList({ tasks, workspaces, groups, onOpen, onOpenAll, onSettings, onOpenTask, pendingTaskIds }: {
  tasks: readonly TaskRecord[]
  workspaces: readonly ExecutionWorkspaceOption[]
  groups: readonly TaskGroupRecord[]
  onOpen: (workspaceId: string) => void
  onOpenAll: () => void
  onSettings: (workspaceId: string) => void
  onOpenTask: (taskId: string) => void
  pendingTaskIds: readonly string[]
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (key: string): void => {
    setExpanded(previous => ({ ...previous, [key]: !previous[key] }))
  }
  const entries = workspaceListEntries(tasks, workspaces)
  const allCounts = countWorkspaceTasks(tasks, undefined)

  const renderRow = (entry: { workspaceId: string; title: string; counts: WorkspaceCounts }) => {
    const isAll = entry.workspaceId === ''
    const open = expanded[entry.workspaceId] === true
    const visibleCounts = COUNT_KEYS.filter(cell => entry.counts[cell.field] > 0)
    const hue = isAll ? undefined : entityHue(entry.workspaceId)
    return (
      <div key={entry.workspaceId} className={css.listRow} data-workspace={entry.workspaceId} data-dsh-part="workspace-card">
        <button
          type="button"
          className={css.listWorkspace}
          title={isAll ? t('grid.allTasksHint') : undefined}
          onClick={isAll ? onOpenAll : () => { onOpen(entry.workspaceId) }}
        >
          <span
            className={css.listAvatar}
            data-all={isAll || undefined}
            style={isAll ? undefined : { backgroundColor: `hsl(${hue} 62% 46%)` }}
            aria-hidden="true"
          >
            {(entry.title.trim()[0] ?? '?').toUpperCase()}
          </span>
          <span className={css.listTitle}>
            <span>{entry.title}</span>
            <span className={css.listTotal}>{t('grid.total', { count: String(entry.counts.total) })}</span>
          </span>
          {visibleCounts.length > 0 && (
            <span className={css.listCounts}>
              {visibleCounts.map(cell => (
                <CountPill key={cell.key} status={cell.status} label={t(cell.key)} value={entry.counts[cell.field]} />
              ))}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`${css.iconButton} ${css.listChevron}`}
          aria-expanded={open}
          aria-label={open ? t('list.collapse') : t('list.expand')}
          onClick={() => { toggle(entry.workspaceId) }}
        >
          ▸
        </button>
        {!isAll && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('grid.workspaceSettings')}
            title={t('grid.workspaceSettings')}
            onClick={() => { onSettings(entry.workspaceId) }}
          >
            ⚙
          </button>
        )}
        {open && (
          <WorkspaceBody
            tasks={tasks}
            groups={groups}
            workspaceId={isAll ? undefined : entry.workspaceId}
            onOpenTask={onOpenTask}
            pendingTaskIds={pendingTaskIds}
          />
        )}
      </div>
    )
  }

  return (
    <div className={css.list} data-dsh-part="workspace-list">
      {renderRow({ workspaceId: '', title: t('grid.allTasks'), counts: allCounts })}
      {entries.map(entry => renderRow({ workspaceId: entry.workspaceId, title: entry.title, counts: entry.counts }))}
    </div>
  )
}
