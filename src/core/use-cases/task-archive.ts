/**
 * Archive/restore task use case: move a settled (done/failed) task off the
 * main board and back. The task keeps its status, execution history, and
 * transcript references, while archiving disarms any schedule so it cannot
 * create more execution records until the user restores and re-enables it.
 */
import type { TaskRecord } from '../tasks.ts'
import { ARCHIVABLE_STATUSES } from '../tasks.ts'

/** Result of an archive transition. */
export interface ArchiveTaskResult {
  /** The next ledger. */
  tasks: readonly TaskRecord[]
  /** Whether the archive was applied (false = unknown task / not archivable). */
  archived: boolean
}

/** Result of a bulk archive transition (the board's hide-old-tasks action). */
export interface ArchiveTasksResult {
  /** The next ledger. */
  tasks: readonly TaskRecord[]
  /** Ids the transition actually archived (a requested id may be skipped). */
  archivedIds: readonly string[]
  /** Whether every requested id was archived. */
  allArchived: boolean
}

/**
 * Archive one task: only settled statuses (done/failed) can be archived;
 * a running or not-yet-settled task stays on the board (its runner still
 * owns its lifecycle). Archiving disarms a schedule; already-archived tasks
 * are a no-op.
 */
export function applyArchiveTask(
  tasks: readonly TaskRecord[],
  id: string,
  now: number,
): ArchiveTaskResult {
  let applied = false
  const next = tasks.map(task => {
    if (task.id !== id || task.archivedAt !== undefined) return task
    if (!(ARCHIVABLE_STATUSES as readonly string[]).includes(task.status)) return task
    applied = true
    const schedule = task.schedule === undefined
      ? undefined
      : { ...task.schedule, enabled: false, nextRunAt: undefined }
    return {
      ...task,
      ...(schedule === undefined ? {} : { schedule }),
      archivedAt: now,
      updatedAt: now,
    }
  })
  return { tasks: next, archived: applied }
}

/**
 * Archive several settled tasks in one pass (the column hide action). Each
 * requested id is archived with the same rules as {@link applyArchiveTask}:
 * only done/failed tasks, never an already-archived one. The pass is a single
 * shot over the task list, so bulk-hiding a whole column never degrades into
 * one map per id. A requested id that is unknown, already archived, or not
 * settled is simply skipped — the caller decides how to treat the shortfall
 * (the Host ledger fails the whole action closed, the controller mirrors it).
 */
export function applyArchiveTasks(
  tasks: readonly TaskRecord[],
  ids: readonly string[],
  now: number,
): ArchiveTasksResult {
  const wanted = new Set(ids)
  if (wanted.size === 0) return { tasks: [...tasks], archivedIds: [], allArchived: true }
  const archivedIds: string[] = []
  const next = tasks.map(task => {
    if (!wanted.has(task.id) || task.archivedAt !== undefined) return task
    if (!(ARCHIVABLE_STATUSES as readonly string[]).includes(task.status)) return task
    archivedIds.push(task.id)
    const schedule = task.schedule === undefined
      ? undefined
      : { ...task.schedule, enabled: false, nextRunAt: undefined }
    return {
      ...task,
      ...(schedule === undefined ? {} : { schedule }),
      archivedAt: now,
      updatedAt: now,
    }
  })
  const archived = new Set(archivedIds)
  return {
    tasks: next,
    archivedIds,
    allArchived: ids.every(id => archived.has(id)),
  }
}

/**
 * Collect the distinct execution session ids of the given tasks, in ledger
 * order of first appearance. Only executions that actually recorded a session
 * id contribute (a queued run or an interrupted start has none). This is the
 * session set the hide dialog offers to archive alongside the tasks; the Host
 * derives it from the ledger records it just archived, never from the wire.
 */
export function collectExecutionSessionIds(
  tasks: readonly TaskRecord[],
  ids: readonly string[],
): readonly string[] {
  const wanted = new Set(ids)
  const seen = new Set<string>()
  const result: string[] = []
  for (const task of tasks) {
    if (!wanted.has(task.id)) continue
    for (const execution of task.executions) {
      const sessionId = execution.sessionId
      if (sessionId !== undefined && sessionId !== '' && !seen.has(sessionId)) {
        seen.add(sessionId)
        result.push(sessionId)
      }
    }
  }
  return result
}

/** Restore one task back onto the main board (clears the archive marker). */
export function applyRestoreTask(tasks: readonly TaskRecord[], id: string, now: number): ArchiveTaskResult {
  let applied = false
  const next = tasks.map(task => {
    if (task.id !== id || task.archivedAt === undefined) return task
    applied = true
    const { archivedAt: _archived, ...rest } = task
    return { ...rest, updatedAt: now }
  })
  return { tasks: next, archived: applied }
}
