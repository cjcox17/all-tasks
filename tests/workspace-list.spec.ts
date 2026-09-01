/**
 * Workspace overview list: the pure per-workspace count projection and the
 * list-entry builder (runtime workspaces + vanished-workspace fallback).
 */
import { describe, expect, it } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { countWorkspaceTasks, workspaceListEntries } from '../src/client/board/workspace-list.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'T', description: '', prompt: '' }, 0, `t-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  }
}

describe('countWorkspaceTasks', () => {
  it('counts every status bucket for one workspace, excluding archived tasks', () => {
    const tasks = [
      task({ status: 'todo', workspaceId: 'ws-a' }),
      task({ status: 'todo', workspaceId: 'ws-a', approved: false }),
      task({ status: 'backlog', workspaceId: 'ws-a' }),
      task({ status: 'running', workspaceId: 'ws-a' }),
      task({ status: 'done', workspaceId: 'ws-a' }),
      task({ status: 'failed', workspaceId: 'ws-a' }),
      task({ status: 'done', workspaceId: 'ws-a', archivedAt: 1 }),
    ]
    expect(countWorkspaceTasks(tasks, 'ws-a')).toEqual({
      total: 6, todo: 2, pending: 1, working: 1, scheduled: 0, finished: 1, failed: 1,
    })
  })

  it('counts an armed schedule in the scheduled bucket without double counting the status', () => {
    const tasks = [
      task({ status: 'todo', workspaceId: 'ws-a', schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: 1, lastTriggeredAt: undefined } }),
      task({ status: 'running', workspaceId: 'ws-a', schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: 1, lastTriggeredAt: undefined } }),
      task({ status: 'todo', workspaceId: 'ws-a', schedule: { enabled: false, cron: '0 9 * * *', nextRunAt: 1, lastTriggeredAt: undefined } }),
    ]
    expect(countWorkspaceTasks(tasks, 'ws-a')).toEqual({
      total: 3, todo: 2, pending: 0, working: 1, scheduled: 2, finished: 0, failed: 0,
    })
  })

  it('counts every workspace when no workspace id is given (the All overview)', () => {
    const tasks = [
      task({ status: 'todo', workspaceId: 'ws-a' }),
      task({ status: 'done', workspaceId: 'ws-b' }),
      task({ status: 'done' }),
    ]
    expect(countWorkspaceTasks(tasks, undefined)).toEqual({
      total: 3, todo: 1, pending: 0, working: 0, scheduled: 0, finished: 2, failed: 0,
    })
  })
})

describe('workspaceListEntries', () => {
  it('orders entries by the runtime workspace list and appends vanished pinned workspaces', () => {
    const tasks = [
      task({ workspaceId: 'ws-a' }),
      task({ workspaceId: 'ws-gone' }),
      task({ workspaceId: 'ws-b' }),
    ]
    const entries = workspaceListEntries(tasks, [
      { workspaceId: 'ws-b', title: 'Beta' },
      { workspaceId: 'ws-a', title: 'Alpha' },
    ])
    expect(entries.map(entry => entry.workspaceId)).toEqual(['ws-b', 'ws-a', 'ws-gone'])
    expect(entries[2]!.title).toBe('ws-gone')
  })
})
