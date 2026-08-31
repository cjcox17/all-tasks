/**
 * Unit tests for the board's workspace scoping helpers.
 */
import { describe, expect, it } from 'vitest'
import { matchesWorkspace, splitWorkspaceTasks } from '../src/client/board/workspace-filter.ts'
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
