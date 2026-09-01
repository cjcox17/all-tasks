/**
 * Workspace overview (the board's landing view): a grid of one card per
 * workspace — plus an "All tasks" card — each showing the workspace's live
 * task counts (to-do approved / pending approval / working / scheduled /
 * finished / failed). Clicking a card opens that workspace's kanban; the ⚙
 * button opens the workspace default-settings editor. The grid is the first
 * view the board shows; the kanban is always workspace-scoped behind it.
 */
import type { ExecutionWorkspaceOption } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import css from '../board.module.css'
import { countWorkspaceTasks, workspaceGridEntries, type WorkspaceCounts } from './workspace-grid.ts'

/** The count cells shown on every card, in display order. */
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
    <span className={css.gridCount}>
      <span className={css.gridCountValue} data-count={value > 0 ? 'nonzero' : 'zero'}>{value}</span>
      <span className={css.gridCountLabel}>{label}</span>
    </span>
  )
}

export function WorkspaceGrid({ tasks, workspaces, onOpen, onOpenAll, onSettings }: {
  tasks: readonly TaskRecord[]
  workspaces: readonly ExecutionWorkspaceOption[]
  onOpen: (workspaceId: string) => void
  onOpenAll: () => void
  onSettings: (workspaceId: string) => void
}) {
  const entries = workspaceGridEntries(tasks, workspaces)
  const allCounts = countWorkspaceTasks(tasks, undefined)
  return (
    <div className={css.grid} data-dsh-part="workspace-grid">
      <div className={css.gridCardWrap} data-workspace="" data-dsh-part="workspace-card">
        <button
          type="button"
          className={css.gridCard}
          title={t('grid.allTasksHint')}
          onClick={onOpenAll}
        >
          <span className={css.gridCardTitle}>
            <span>{t('grid.allTasks')}</span>
            <span className={css.gridCardTotal}>{t('grid.total', { count: String(allCounts.total) })}</span>
          </span>
          <span className={css.gridCardCounts}>
            {COUNT_KEYS.map(cell => (
              <CountCell key={cell.key} label={t(cell.key)} value={allCounts[cell.field]} />
            ))}
          </span>
        </button>
      </div>
      {entries.map(entry => (
        <div key={entry.workspaceId} className={css.gridCardWrap} data-workspace={entry.workspaceId} data-dsh-part="workspace-card">
          <button
            type="button"
            className={css.gridCard}
            onClick={() => { onOpen(entry.workspaceId) }}
          >
            <span className={css.gridCardTitle}>
              <span>{entry.title}</span>
              <span className={css.gridCardTotal}>{t('grid.total', { count: String(entry.counts.total) })}</span>
            </span>
            <span className={css.gridCardCounts}>
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
