/**
 * Unit tests for the board's workspace scoping helpers, including the
 * deleted-workspace ("vanished pin") filter.
 */
import { describe, expect, it } from 'vitest'
import {
  boardGroups,
  boardTasks,
  isVanishedWorkspacePin,
  liveWorkspaceIds,
  matchesWorkspace,
  splitWorkspaceTasks,
} from '../src/client/board/workspace-filter.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    title: 'Task',
    description: '',
    prompt: 'do it',
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    ...overrides,
  }
}

function group(overrides: Partial<TaskGroupRecord> = {}): TaskGroupRecord {
  return {
    id: 'g1',
    name: 'Group',
    mode: 'sequential',
    order: [],
    createdAt: 0,
    updatedAt: 0,
    offPeakOnly: false,
    ...overrides,
  }
}

describe('matchesWorkspace', () => {
  it('passes every task without a filter (general overview)', () => {
    expect(matchesWorkspace(task(), undefined)).toBe(true)
    expect(matchesWorkspace(task({ workspaceId: 'ws-a' }), undefined)).toBe(true)
  })

  it('passes tasks pinned to the selected workspace', () => {
    expect(matchesWorkspace(task({ workspaceId: 'ws-a' }), 'ws-a')).toBe(true)
  })

  it('rejects tasks pinned to other workspaces', () => {
    expect(matchesWorkspace(task({ workspaceId: 'ws-b' }), 'ws-a')).toBe(false)
  })

  it('always passes unassigned tasks so they land in the Unassigned section', () => {
    expect(matchesWorkspace(task(), 'ws-a')).toBe(true)
  })
})

describe('splitWorkspaceTasks', () => {
  const pinnedA = task({ id: 'a', workspaceId: 'ws-a' })
  const pinnedB = task({ id: 'b', workspaceId: 'ws-b' })
  const unassigned = task({ id: 'u' })

  it('returns everything as pinned with no unassigned section in the All view', () => {
    const { pinned, unassigned: rest } = splitWorkspaceTasks([pinnedA, pinnedB, unassigned], undefined)
    expect(pinned).toHaveLength(3)
    expect(rest).toHaveLength(0)
  })

  it('splits pinned vs unassigned for a workspace view', () => {
    const { pinned, unassigned: rest } = splitWorkspaceTasks([pinnedA, pinnedB, unassigned], 'ws-a')
    expect(pinned.map(t => t.id)).toEqual(['a'])
    expect(rest.map(t => t.id)).toEqual(['u'])
  })
})

describe('liveWorkspaceIds / isVanishedWorkspacePin', () => {
  it('treats pins to workspaces missing from the runtime list as vanished', () => {
    const live = liveWorkspaceIds([{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }])
    expect(isVanishedWorkspacePin({ workspaceId: 'ws-a' }, live)).toBe(false)
    expect(isVanishedWorkspacePin({ workspaceId: 'ws-b' }, live)).toBe(false)
    expect(isVanishedWorkspacePin({ workspaceId: 'ws-gone' }, live)).toBe(true)
    expect(isVanishedWorkspacePin({}, live)).toBe(false)
    expect(isVanishedWorkspacePin({ workspaceId: undefined }, live)).toBe(false)
  })
})

describe('boardTasks / boardGroups', () => {
  it('drops tasks pinned to vanished workspaces and keeps unassigned ones', () => {
    const live = liveWorkspaceIds([{ workspaceId: 'ws-a' }])
    const tasks = [
      task({ id: 'a', workspaceId: 'ws-a' }),
      task({ id: 'gone', workspaceId: 'ws-gone' }),
      task({ id: 'u' }),
    ]
    expect(boardTasks(tasks, live).map(t => t.id)).toEqual(['a', 'u'])
  })

  it('drops groups scoped to vanished workspaces and keeps unassigned-scope ones', () => {
    const live = liveWorkspaceIds([{ workspaceId: 'ws-a' }])
    const groups = [
      group({ id: 'g-a', workspaceId: 'ws-a' }),
      group({ id: 'g-gone', workspaceId: 'ws-gone' }),
      group({ id: 'g-u' }),
    ]
    expect(boardGroups(groups, live).map(g => g.id)).toEqual(['g-a', 'g-u'])
  })
})
