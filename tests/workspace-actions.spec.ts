/**
 * Workspace run/stop planning: which tasks and groups one workspace's
 * controls act on. Run targets ungrouped `todo` tasks (never backlog) plus
 * non-stopped groups; Stop targets running ungrouped tasks and running
 * groups. Workspace pausing is the board-level soft pause, not a fan-out, so
 * the plan carries no pause set.
 */
import { describe, expect, it } from 'vitest'
import { planWorkspaceActions } from '../src/core/workspace-actions.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'T', description: '', prompt: '' }, 0, `t-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  }
}

const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', workspaceId: 'ws-a', order: ['m1'], createdAt: 0, updatedAt: 0, offPeakOnly: false }

describe('planWorkspaceActions', () => {
  it('runs todo (not backlog) ungrouped tasks and non-stopped groups in scope', () => {
    const plan = planWorkspaceActions([
      task({ id: 'todo', status: 'todo', workspaceId: 'ws-a' }),
      task({ id: 'backlog', status: 'backlog', workspaceId: 'ws-a' }),
      task({ id: 'other', status: 'todo', workspaceId: 'ws-b' }),
      task({ id: 'm1', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
    ], [GROUP], 'ws-a')
    expect(plan.todoTaskIds).toEqual(['todo']) // backlog and other-workspace excluded
    expect(plan.runnableGroupIds).toEqual(['g1'])
  })

  it('does not run unapproved or already-running tasks', () => {
    const plan = planWorkspaceActions([
      task({ id: 'pending', status: 'todo', workspaceId: 'ws-a', approved: false }),
      task({ id: 'running', status: 'running', workspaceId: 'ws-a', executions: [{ id: 'e', sessionId: 's', startedAt: 0, endedAt: undefined, result: undefined, error: undefined }] }),
    ], [], 'ws-a')
    expect(plan.todoTaskIds).toEqual([])
    expect(plan.stoppableTaskIds).toEqual(['running'])
  })

  it('stops only groups with a running member', () => {
    const running = { id: 'e', sessionId: 's', startedAt: 0, endedAt: undefined, result: undefined, error: undefined }
    const plan = planWorkspaceActions([
      task({ id: 'm1', status: 'running', workspaceId: 'ws-a', groupId: 'g1', executions: [running] }),
    ], [{ ...GROUP, stopped: false }], 'ws-a')
    expect(plan.stoppableGroupIds).toEqual(['g1'])
    // A non-stopped group stays in the run set; the Host skips its running member.
    expect(plan.runnableGroupIds).toEqual(['g1'])

    const stopped = planWorkspaceActions([
      task({ id: 'm1', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
    ], [{ ...GROUP, stopped: true }], 'ws-a')
    expect(stopped.runnableGroupIds).toEqual([])
    expect(stopped.stoppableGroupIds).toEqual([])
  })

  it('the All overview (undefined) spans every workspace', () => {
    const plan = planWorkspaceActions([
      task({ id: 'a', status: 'todo', workspaceId: 'ws-a' }),
      task({ id: 'b', status: 'todo', workspaceId: 'ws-b' }),
    ], [], undefined)
    expect(plan.todoTaskIds).toEqual(['a', 'b'])
  })
})
