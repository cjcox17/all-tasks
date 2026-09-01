/**
 * Workspace overview list: the pure per-workspace count projection, the
 * list-entry builder (runtime workspaces + vanished-workspace fallback), and
 * the expandable per-workspace task directory (groups + ungrouped tasks).
 */
import { describe, expect, it } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import {
  countWorkspaceTasks,
  entityHue,
  workspaceListEntries,
  workspaceTaskDirectory,
} from '../src/client/board/workspace-list.ts'

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

describe('entityHue', () => {
  it('is deterministic and in hue range for repeated ids', () => {
    expect(entityHue('ws-a')).toBe(entityHue('ws-a'))
    expect(entityHue('g-1')).toBeGreaterThanOrEqual(0)
    expect(entityHue('g-1')).toBeLessThan(360)
    expect(entityHue('ws-a')).not.toBe(entityHue('ws-b'))
  })
})

describe('workspaceTaskDirectory', () => {
  const GROUP: TaskGroupRecord = {
    id: 'g1',
    name: 'Nightly',
    mode: 'sequential',
    order: ['t-a', 't-b'],
    createdAt: 0,
    updatedAt: 0,
    offPeakOnly: false,
    workspaceId: 'ws-a',
  }

  it('groups a workspace\'s on-board members in group order and lists its ungrouped tasks', () => {
    const tasks = [
      task({ id: 't-a', title: 'A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
      task({ id: 't-b', title: 'B', status: 'done', workspaceId: 'ws-a', groupId: 'g1' }),
      task({ id: 't-c', title: 'C', status: 'todo', workspaceId: 'ws-a' }),
      task({ id: 't-d', title: 'D', status: 'todo', workspaceId: 'ws-b' }),
    ]
    const directory = workspaceTaskDirectory(tasks, [GROUP], 'ws-a')
    expect(directory.grouped).toHaveLength(1)
    expect(directory.grouped[0]!.group.id).toBe('g1')
    expect(directory.grouped[0]!.members.map(member => member.id)).toEqual(['t-a', 't-b'])
    expect(directory.ungrouped.map(member => member.id)).toEqual(['t-c'])
  })

  it('excludes archived tasks in a scoped view and never shows another workspace\'s groups', () => {
    const tasks = [
      task({ id: 't-a', title: 'A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
      task({ id: 't-b', title: 'B', status: 'todo', workspaceId: 'ws-b', groupId: 'g-b' }),
      task({ id: 't-c', title: 'C', status: 'todo', workspaceId: 'ws-a', groupId: 'g1', archivedAt: 1 }),
    ]
    const directory = workspaceTaskDirectory(tasks, [GROUP, { ...GROUP, id: 'g-b', workspaceId: 'ws-b' }], 'ws-a')
    expect(directory.grouped).toHaveLength(1)
    expect(directory.grouped[0]!.members.map(member => member.id)).toEqual(['t-a'])
  })

  it('drops groups with no on-board members in scope', () => {
    const tasks = [task({ id: 't-b', title: 'B', status: 'todo', workspaceId: 'ws-b', groupId: 'g-b' })]
    const directory = workspaceTaskDirectory(tasks, [GROUP], 'ws-a')
    expect(directory.grouped).toHaveLength(0)
    expect(directory.ungrouped).toHaveLength(0)
  })

  it('keeps unassigned-scope groups out of a workspace row (only the All overview spans them)', () => {
    const unassignedGroup: TaskGroupRecord = {
      id: 'g-u', name: 'Open', mode: 'sequential', order: ['t-u'], createdAt: 0, updatedAt: 0, offPeakOnly: false,
    }
    const tasks = [
      task({ id: 't-u', title: 'U', status: 'todo', groupId: 'g-u' }),
      task({ id: 't-a', title: 'A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
    ]
    const scoped = workspaceTaskDirectory(tasks, [GROUP, unassignedGroup], 'ws-a')
    expect(scoped.grouped.map(entry => entry.group.id)).toEqual(['g1'])
    expect(scoped.ungrouped).toHaveLength(0)
    const all = workspaceTaskDirectory(tasks, [GROUP, unassignedGroup], undefined)
    expect(all.grouped.map(entry => entry.group.id).sort()).toEqual(['g-u', 'g1'])
  })

  it('the All overview (undefined) spans every workspace and keeps each group\'s own-scope members', () => {
    const unassignedGroup: TaskGroupRecord = {
      id: 'g-u', name: 'Open', mode: 'sequential', order: ['t-u'], createdAt: 0, updatedAt: 0, offPeakOnly: false,
    }
    const tasks = [
      task({ id: 't-a', title: 'A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
      task({ id: 't-u', title: 'U', status: 'todo', groupId: 'g-u' }),
      task({ id: 't-c', title: 'C', status: 'todo', workspaceId: 'ws-b' }),
      task({ id: 't-arc', title: 'Arc', status: 'done', workspaceId: 'ws-a', archivedAt: 1 }),
    ]
    const directory = workspaceTaskDirectory(tasks, [GROUP, unassignedGroup], undefined)
    expect(directory.grouped).toHaveLength(2)
    const wsMembers = directory.grouped.find(entry => entry.group.id === 'g1')!.members
    expect(wsMembers.map(member => member.id)).toEqual(['t-a'])
    const unassignedMembers = directory.grouped.find(entry => entry.group.id === 'g-u')!.members
    expect(unassignedMembers.map(member => member.id)).toEqual(['t-u'])
    expect(directory.ungrouped.map(member => member.id)).toEqual(['t-c'])
  })
})
