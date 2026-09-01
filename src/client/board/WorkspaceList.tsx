/**
 * Workspace overview (the board's landing view): a Monday.com-style board
 * table. A column-header row labels the aligned count columns (To do / Pending
 * / Working / Scheduled / Finished / Failed / Total); each workspace is one
 * table row (color-coded avatar + name, right-aligned tabular counts, and the
 * run / pause / stop + expand + settings controls) that expands inline into
 * its groups — colored section headers with a name pill, mode badge, member
 * count, and a per-group collapse toggle — and its task rows (status dot,
 * title, aligned status label and badges). Workspace rows are expanded by
 * default so their tasks show underneath, in foldable layers. Clicking a
 * workspace row opens that workspace's kanban; clicking a task row opens the
 * task detail; the ⚙ button opens the workspace default-settings editor.
 */
import { useState } from 'react'
import type { TaskGroupRecord } from '../../core/groups.ts'
import type { ExecutionWorkspaceOption } from '../../core/controller.ts'
import type { TaskRecord, TaskStatus } from '../../core/tasks.ts'
import { planWorkspaceActions } from '../../core/workspace-actions.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { STATUS_KEY } from './status-key.ts'
import css from '../board.module.css'
import {
  countWorkspaceTasks,
  entityHue,
  workspaceListEntries,
  workspaceTaskDirectory,
  type WorkspaceCounts,
} from './workspace-list.ts'

/** The count columns shown on every workspace row, in display order. */
const COUNT_COLUMNS: readonly { key: TaskBoardKey; field: keyof WorkspaceCounts; col: string }[] = [
  { key: 'grid.count.todo', field: 'todo', col: 'todo' },
  { key: 'grid.count.pending', field: 'pending', col: 'pending' },
  { key: 'grid.count.working', field: 'working', col: 'working' },
  { key: 'grid.count.scheduled', field: 'scheduled', col: 'scheduled' },
  { key: 'grid.count.finished', field: 'finished', col: 'finished' },
  { key: 'grid.count.failed', field: 'failed', col: 'failed' },
]

function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={css.statusDot} data-status={status} aria-hidden="true" />
}

/** One task row inside an expanded workspace: status dot + title + aligned cells. */
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
      <StatusDot status={task.status} />
      <span className={css.taskRowTitle}>{task.title}</span>
      <span className={css.taskStatus} data-status={task.status}>{t(STATUS_KEY[task.status])}</span>
      <span className={css.taskBadges}>
        {task.schedule?.enabled === true && <span className={css.taskBadge} data-kind="scheduled">{t('card.scheduled')}</span>}
        {task.approved === false && <span className={css.taskBadge} data-kind="unapproved">{t('card.unapproved')}</span>}
      </span>
    </button>
  )
}

/** One group band inside an expanded workspace: colored header + member rows. */
function GroupBand({ group, members, hue, collapsed, onToggle, onOpenTask, pendingTaskIds }: {
  group: TaskGroupRecord
  members: readonly TaskRecord[]
  hue: number
  collapsed: boolean
  onToggle: () => void
  onOpenTask: (taskId: string) => void
  pendingTaskIds: readonly string[]
}) {
  return (
    <section
      className={css.groupBand}
      data-dsh-part="workspace-group"
      data-group={group.id}
      style={{ borderLeftColor: `hsl(${hue} 62% 50%)`, backgroundColor: `hsl(${hue} 62% 50% / 0.07)` }}
    >
      <header className={css.groupBandHeader}>
        <button
          type="button"
          className={css.groupToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('list.expandGroup') : t('list.collapseGroup')}
          onClick={onToggle}
        >
          ▸
        </button>
        <span className={css.groupBandPill} style={{ backgroundColor: `hsl(${hue} 55% 42%)` }} title={group.name}>
          {group.name}
        </span>
        <span className={css.groupBadge} data-mode={group.mode}>
          {group.mode === 'sequential' ? t('group.sequentialBadge') : t('group.parallelBadge')}
        </span>
        {group.stopped === true && <span className={css.groupStopped}>{t('group.stopped')}</span>}
        {group.paused === true && <span className={css.groupPaused}>{t('group.paused')}</span>}
        {group.schedule?.enabled === true && <span className={css.cardSchedule}>{t('card.scheduled')}</span>}
        <span className={css.groupBandCount}>{members.length}</span>
      </header>
      {!collapsed && members.map(task => (
        <TaskRow key={task.id} task={task} pending={pendingTaskIds.includes(task.id)} onOpen={onOpenTask} />
      ))}
    </section>
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const hasContent = directory.grouped.length > 0 || directory.ungrouped.length > 0
  if (!hasContent) {
    return <p className={css.listEmpty}>{t('list.noTasks')}</p>
  }
  return (
    <div className={css.directoryBody}>
      {directory.grouped.map(({ group, members }) => (
        <GroupBand
          key={group.id}
          group={group}
          members={members}
          hue={entityHue(group.id)}
          collapsed={collapsed[group.id] === true}
          onToggle={() => { setCollapsed(previous => ({ ...previous, [group.id]: previous[group.id] !== true })) }}
          onOpenTask={onOpenTask}
          pendingTaskIds={pendingTaskIds}
        />
      ))}
      {directory.ungrouped.length > 0 && (
        <section className={css.groupBand} data-dsh-part="workspace-group" data-ungrouped="">
          <header className={css.groupBandHeader}>
            <span className={css.groupBandPill} data-neutral="">{t('list.ungrouped')}</span>
            <span className={css.groupBandCount}>{directory.ungrouped.length}</span>
          </header>
          {directory.ungrouped.map(task => (
            <TaskRow key={task.id} task={task} pending={pendingTaskIds.includes(task.id)} onOpen={onOpenTask} />
          ))}
        </section>
      )}
    </div>
  )
}

export function WorkspaceList({ tasks, workspaces, groups, onOpen, onOpenAll, onSettings, onOpenTask, pendingTaskIds, workspacePaused, onRun, onPause, onStop, onPauseWorkspace, onContinueWorkspace }: {
  tasks: readonly TaskRecord[]
  workspaces: readonly ExecutionWorkspaceOption[]
  groups: readonly TaskGroupRecord[]
  onOpen: (workspaceId: string) => void
  onOpenAll: () => void
  onSettings: (workspaceId: string) => void
  onOpenTask: (taskId: string) => void
  pendingTaskIds: readonly string[]
  onRun: (workspaceId: string | undefined) => void
  onPause: (workspaceId: string | undefined) => void
  onStop: (workspaceId: string | undefined) => void
  /** When each workspace was paused (ms epoch); the '' key = the whole board. */
  workspacePaused: Record<string, number>
  onPauseWorkspace: (workspaceId: string) => void
  onContinueWorkspace: (workspaceId: string) => void
}) {
  // Workspace rows are expanded by default; the aggregate All-tasks row stays
  // collapsed until asked (it repeats every workspace's content).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ '': false })
  const toggle = (key: string): void => {
    setExpanded(previous => ({ ...previous, [key]: previous[key] === false ? true : false }))
  }
  const entries = workspaceListEntries(tasks, workspaces)
  const allCounts = countWorkspaceTasks(tasks, undefined)

  const renderSection = (entry: { workspaceId: string; title: string; counts: WorkspaceCounts }) => {
    const isAll = entry.workspaceId === ''
    const scope = isAll ? undefined : entry.workspaceId
    const open = expanded[entry.workspaceId] !== false
    const hue = isAll ? undefined : entityHue(entry.workspaceId)
    const plan = planWorkspaceActions(tasks, groups, scope)
    const runEnabled = plan.todoTaskIds.length > 0 || plan.runnableGroupIds.length > 0
    const pauseEnabled = plan.pausableGroupIds.length > 0
    const stopEnabled = plan.stoppableTaskIds.length > 0 || plan.stoppableGroupIds.length > 0
    const paused = workspacePaused[entry.workspaceId] !== undefined
    const hasRunning = entry.counts.working > 0
    return (
      <div key={entry.workspaceId} className={css.directorySection} data-workspace={entry.workspaceId} data-dsh-part="workspace-card">
        <div className={css.directoryRow}>
          <button
            type="button"
            className={css.directoryName}
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
            <span className={css.listTitle}>{entry.title}</span>
            {paused && <span className={css.workspacePaused}>{t('grid.workspacePaused')}</span>}
          </button>
          {COUNT_COLUMNS.map(column => (
            <span
              key={column.col}
              className={css.directoryCount}
              data-col={column.col}
              data-zero={entry.counts[column.field] === 0 || undefined}
            >
              {entry.counts[column.field] > 0 ? entry.counts[column.field] : '–'}
            </span>
          ))}
          <span className={css.directoryTotal} data-col="total">{entry.counts.total}</span>
          <span className={css.directoryControls}>
            <button
              type="button"
              className={css.iconButton}
              data-ctl="run"
              disabled={!runEnabled}
              aria-label={t('list.run')}
              title={t('list.run')}
              onClick={() => { onRun(scope) }}
            >
              ▶
            </button>
            <button
              type="button"
              className={css.iconButton}
              data-ctl="pause"
              disabled={!pauseEnabled}
              aria-label={t('list.pause')}
              title={t('list.pause')}
              onClick={() => { onPause(scope) }}
            >
              ⏸
            </button>
            <button
              type="button"
              className={css.iconButton}
              data-ctl="stop"
              disabled={!stopEnabled}
              aria-label={t('list.stop')}
              title={t('list.stop')}
              onClick={() => { onStop(scope) }}
            >
              ⏹
            </button>
          </span>
          <span className={css.directoryActions}>
            {paused ? (
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('grid.continueWorkspace')}
                title={t('grid.continueWorkspace')}
                onClick={() => { onContinueWorkspace(entry.workspaceId) }}
              >
                ▶
              </button>
            ) : (
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('grid.pauseWorkspace')}
                title={t('grid.pauseWorkspace')}
                disabled={!hasRunning}
                onClick={() => { onPauseWorkspace(entry.workspaceId) }}
              >
                ⏸
              </button>
            )}
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
          </span>
        </div>
        {open && (
          <WorkspaceBody
            tasks={tasks}
            groups={groups}
            workspaceId={scope}
            onOpenTask={onOpenTask}
            pendingTaskIds={pendingTaskIds}
          />
        )}
      </div>
    )
  }

  return (
    <div className={css.list} data-dsh-part="workspace-list">
      <div className={css.directory}>
        <div className={css.directoryHead}>
          <span className={css.headName}>{t('list.workspace')}</span>
          {COUNT_COLUMNS.map(column => (
            <span key={column.col} className={css.headCount} data-col={column.col}>{t(column.key)}</span>
          ))}
          <span className={css.headTotal} data-col="total">{t('list.total')}</span>
          <span className={css.headControls} />
          <span className={css.headActions} />
        </div>
        {renderSection({ workspaceId: '', title: t('grid.allTasks'), counts: allCounts })}
        {entries.map(entry => renderSection({ workspaceId: entry.workspaceId, title: entry.title, counts: entry.counts }))}
      </div>
    </div>
  )
}
