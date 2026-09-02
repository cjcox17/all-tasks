/**
 * Archive/restore use-case transitions: only settled (done/failed) tasks can
 * be archived, the marker keeps status/executions intact, restore clears it,
 * and unknown ids are no-ops.
 */
import { describe, expect, it } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { applyArchiveTask, applyArchiveTasks, applyRestoreTask, collectExecutionSessionIds } from '../src/core/use-cases/task-archive.ts'

const NOW = 1_700_000_000_000

function task(id: string, status: TaskRecord['status']): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW, id), status }
}

/** A settled task with one recorded execution per given session id (undefined = interrupted start). */
function executed(id: string, status: TaskRecord['status'], sessionIds: (string | undefined)[]): TaskRecord {
  return {
    ...task(id, status),
    executions: sessionIds.map((sessionId, index) => ({
      id: `${id}-e${index}`,
      sessionId,
      startedAt: NOW + index,
      endedAt: NOW + index + 1,
      result: 'succeeded' as const,
      error: undefined,
    })),
  }
}

describe('applyArchiveTask', () => {
  it('archives a done task, retaining history and disarming its schedule', () => {
    const t = {
      ...task('t1', 'done'),
      executions: [{ id: 'e1', sessionId: 's1', startedAt: 1, endedAt: 2, result: 'succeeded' as const, error: undefined }],
      schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: NOW + 60_000, lastTriggeredAt: NOW - 60_000 },
    }
    const { tasks, archived } = applyArchiveTask([t], 't1', NOW + 5)
    expect(archived).toBe(true)
    expect(tasks[0]).toMatchObject({ id: 't1', status: 'done', archivedAt: NOW + 5 })
    expect(tasks[0].executions).toEqual(t.executions)
    expect(tasks[0].schedule).toEqual({
      enabled: false, cron: '0 9 * * *', nextRunAt: undefined, lastTriggeredAt: NOW - 60_000,
    })
  })

  it('archives a failed task', () => {
    const { tasks, archived } = applyArchiveTask([task('t2', 'failed')], 't2', NOW + 1)
    expect(archived).toBe(true)
    expect(tasks[0].archivedAt).toBe(NOW + 1)
  })

  it('refuses to archive running or unsettled tasks', () => {
    for (const status of ['backlog', 'todo', 'running'] as const) {
      const { tasks, archived } = applyArchiveTask([task('x', status)], 'x', NOW + 1)
      expect(archived).toBe(false)
      expect(tasks[0].archivedAt).toBeUndefined()
    }
  })

  it('is a no-op for unknown ids and already-archived tasks', () => {
    const archived = { ...task('t3', 'done'), archivedAt: NOW }
    const { tasks, archived: applied } = applyArchiveTask([archived], 't3', NOW + 10)
    expect(applied).toBe(false)
    expect(tasks[0].archivedAt).toBe(NOW)
    expect(applyArchiveTask([], 'ghost', NOW).archived).toBe(false)
  })
})

describe('applyRestoreTask', () => {
  it('clears the marker and bumps updatedAt', () => {
    const t = { ...task('t4', 'done'), archivedAt: NOW, updatedAt: NOW }
    const { tasks, archived } = applyRestoreTask([t], 't4', NOW + 7)
    expect(archived).toBe(true)
    expect(tasks[0].archivedAt).toBeUndefined()
    expect(tasks[0].status).toBe('done')
    expect(tasks[0].updatedAt).toBe(NOW + 7)
  })

  it('is a no-op for on-board or unknown tasks', () => {
    expect(applyRestoreTask([task('t5', 'done')], 't5', NOW).archived).toBe(false)
    expect(applyRestoreTask([], 'ghost', NOW).archived).toBe(false)
  })
})

describe('applyArchiveTasks (bulk hide)', () => {
  it('archives every requested settled task in one pass, disarming schedules', () => {
    const done = {
      ...executed('d1', 'done', ['s1']),
      schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: NOW + 60_000, lastTriggeredAt: NOW - 60_000 },
    }
    const failed = executed('f1', 'failed', ['s2'])
    const result = applyArchiveTasks([done, failed], ['d1', 'f1'], NOW + 5)
    expect(result.allArchived).toBe(true)
    expect(result.archivedIds).toEqual(['d1', 'f1'])
    expect(result.tasks[0]).toMatchObject({ id: 'd1', status: 'done', archivedAt: NOW + 5 })
    expect(result.tasks[0].schedule).toEqual({
      enabled: false, cron: '0 9 * * *', nextRunAt: undefined, lastTriggeredAt: NOW - 60_000,
    })
    expect(result.tasks[1]).toMatchObject({ id: 'f1', archivedAt: NOW + 5 })
    // Executions are untouched by archiving.
    expect(result.tasks[0].executions).toHaveLength(1)
  })

  it('skips unsettled and already-archived ids and reports the shortfall', () => {
    const done = executed('d1', 'done', ['s1'])
    const todo = executed('t1', 'todo', [])
    const already = { ...executed('a1', 'done', []), archivedAt: NOW }
    const result = applyArchiveTasks([done, todo, already], ['d1', 't1', 'a1', 'ghost'], NOW + 5)
    expect(result.archivedIds).toEqual(['d1'])
    expect(result.allArchived).toBe(false)
    expect(result.tasks.find(item => item.id === 't1')?.archivedAt).toBeUndefined()
    expect(result.tasks.find(item => item.id === 'a1')?.archivedAt).toBe(NOW)
  })

  it('is an all-true no-op for an empty id list', () => {
    const result = applyArchiveTasks([task('d1', 'done')], [], NOW + 5)
    expect(result.allArchived).toBe(true)
    expect(result.archivedIds).toEqual([])
    expect(result.tasks[0].archivedAt).toBeUndefined()
  })
})

describe('collectExecutionSessionIds', () => {
  it('returns the distinct recorded session ids in order of first appearance', () => {
    const a = executed('a', 'done', ['s1', 's2', 's2', 's3'])
    const b = executed('b', 'failed', ['s2', undefined, 's4'])
    expect(collectExecutionSessionIds([a, b], ['a', 'b'])).toEqual(['s1', 's2', 's3', 's4'])
    // A rerun with an interrupted (session-less) start contributes nothing.
    expect(collectExecutionSessionIds([a, b], ['b'])).toEqual(['s2', 's4'])
    expect(collectExecutionSessionIds([a, b], [])).toEqual([])
    expect(collectExecutionSessionIds([a, b], ['ghost'])).toEqual([])
  })
})
