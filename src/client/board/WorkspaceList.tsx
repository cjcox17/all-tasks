/**
 * Workspace overview (the board's landing view): a list of one row per
 * workspace — plus an "All tasks" row — each showing the workspace's live
 * task counts (to-do approved / pending approval / working / scheduled /
 * finished / failed). Clicking a row opens that workspace's kanban; the ⚙
 * button opens the workspace default-settings editor. The list is the first
 * view the board shows; the kanban is always workspace-scoped behind it.
 */
import type { ExecutionWorkspaceOption } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import css from '../board.module.css'
import { countWorkspaceTasks, workspaceListEntries, type WorkspaceCounts } from './workspace-list.ts'

/** The count cells shown on every row, in display order. */
const COUNT_KEYS: readonly { key: TaskBoardKey; field: keyof WorkspaceCounts }[] = [
  { key: 'grid.count.todo', field: 'todo' },
  { key: 'grid.count.pending', field: 'pending' },
  { key: 'grid.count.working', field: 'working' },
  { key: 'grid.count.scheduled', field: 'scheduled' },
  { key: 'grid.count.finished', field: 'finished' },
  { key: 'grid.count.failed', field: 'failed' },
]

function CountCell({ label, value }: { label: string; value: number }) {
  return (
    <span className={css.listCount}>
      <span className={css.listCountValue} data-count={value > 0 ? 'nonzero' : 'zero'}>{value}</span>
      <span className={css.listCountLabel}>{label}</span>
    </span>
  )
}

export function WorkspaceList({ tasks, workspaces, onOpen, onOpenAll, onSettings }: {
  tasks: readonly TaskRecord[]
  workspaces: readonly ExecutionWorkspaceOption[]
  onOpen: (workspaceId: string) => void
  onOpenAll: () => void
  onSettings: (workspaceId: string) => void
}) {
  const entries = workspaceListEntries(tasks, workspaces)
  const allCounts = countWorkspaceTasks(tasks, undefined)
  return (
    <div className={css.list} data-dsh-part="workspace-list">
      <div className={css.listRow} data-workspace="" data-dsh-part="workspace-card">
        <button
          type="button"
          className={css.listWorkspace}
          title={t('grid.allTasksHint')}
          onClick={onOpenAll}
        >
          <span className={css.listTitle}>
            <span>{t('grid.allTasks')}</span>
            <span className={css.listTotal}>{t('grid.total', { count: String(allCounts.total) })}</span>
          </span>
          <span className={css.listCounts}>
            {COUNT_KEYS.map(cell => (
              <CountCell key={cell.key} label={t(cell.key)} value={allCounts[cell.field]} />
            ))}
          </span>
        </button>
      </div>
      {entries.map(entry => (
        <div key={entry.workspaceId} className={css.listRow} data-workspace={entry.workspaceId} data-dsh-part="workspace-card">
          <button
            type="button"
            className={css.listWorkspace}
            onClick={() => { onOpen(entry.workspaceId) }}
          >
            <span className={css.listTitle}>
              <span>{entry.title}</span>
              <span className={css.listTotal}>{t('grid.total', { count: String(entry.counts.total) })}</span>
            </span>
            <span className={css.listCounts}>
              {COUNT_KEYS.map(cell => (
                <CountCell key={cell.key} label={t(cell.key)} value={entry.counts[cell.field]} />
              ))}
            </span>
          </button>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('grid.workspaceSettings')}
            title={t('grid.workspaceSettings')}
            onClick={() => { onSettings(entry.workspaceId) }}
          >
            ⚙
          </button>
        </div>
      ))}
    </div>
  )
}
