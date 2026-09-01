/**
 * Pause / continue at every granularity: the pure execution transitions, the
 * Host ledger actions (task / group / workspace), and the launch gates they
 * feed (manual runs, crons, and the router queue).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGroup } from '../src/core/groups.ts'
import {
  continueExecution,
  createTask,
  isTaskPaused,
  openExecutionOf,
  pauseExecution,
  startExecution,
  type TaskRecord,
} from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import type { AllTasksAction } from '../src/protocol.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

let requestSeq = 0

/** Apply one action with a fresh request id (the ledger cache keys on the id). */
function apply(ledger: HostTaskLedger, action: AllTasksAction) {
  requestSeq += 1
  return ledger.applyRequest(`request-${requestSeq}`, action)
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-all-tasks-pause-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW - 1000, id), ...overrides }
}

describe('pause / continue execution transitions', () => {
  it('pauses an open execution (kept open), then continues it with a fresh boundary', () => {
    const started = startExecution(task('a'), NOW, 'exec-1')
    expect(isTaskPaused(started.task)).toBe(false)
    const paused = pauseExecution(started.task, 'exec-1', NOW + 10)
    expect(paused?.executions[0].pausedAt).toBe(NOW + 10)
    expect(paused?.executions[0].endedAt).toBeUndefined()
    expect(paused?.executions[0].sessionId).toBeUndefined()
    expect(isTaskPaused(paused!)).toBe(true)
    expect(openExecutionOf(paused!)).toMatchObject({ id: 'exec-1', pausedAt: NOW + 10 })
    const continued = continueExecution(paused!, 'exec-1', NOW + 20)
    expect(continued?.executions[0].pausedAt).toBeUndefined()
    expect(continued?.executions[0].watchFromAt).toBe(NOW + 20)
    expect(continued?.status).toBe('running')
    expect(isTaskPaused(continued!)).toBe(false)
  })

  it('refuses to pause an already paused or settled execution, or continue an unpaused one', () => {
    const started = startExecution(task('a'), NOW, 'exec-1')
    const paused = pauseExecution(started.task, 'exec-1', NOW + 10)!
    expect(pauseExecution(paused, 'exec-1', NOW + 20)).toBeUndefined()
    expect(continueExecution(started.task, 'exec-1', NOW + 20)).toBeUndefined()
    const settled: TaskRecord = {
      ...started.task,
      status: 'done',
      executions: [{ ...started.execution, endedAt: NOW + 5, result: 'succeeded' }],
    }
    expect(pauseExecution(settled, 'exec-1', NOW + 10)).toBeUndefined()
  })
})

describe('HostTaskLedger pause/continue actions', () => {
  it('pauses a running task: keeps the execution open, cancels the session, and blocks new runs', () => {
    const now = NOW
    const ledger = new HostTaskLedger(tempRoot(), () => now)
    apply(ledger, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'work' } })
    apply(ledger, { kind: 'run', taskId: 'a' })
    const executionId = ledger.state().tasks[0].executions[0].id
    ledger.attachSession('a', executionId, 'session-a')
    const result = apply(ledger, { kind: 'pause', taskId: 'a' })
    expect(result.stopSessions).toEqual(['session-a'])
    const execution = ledger.state().tasks[0].executions[0]
    expect(execution.pausedAt).toBe(now)
    expect(execution.endedAt).toBeUndefined()
    expect(ledger.state().tasks[0].status).toBe('running')
    expect(() => apply(ledger, { kind: 'run', taskId: 'a' })).toThrow('already running')
  })

  it('continues a paused task: clears the pause, advances the boundary, and re-prompts the session', () => {
    const now = NOW
    const ledger = new HostTaskLedger(tempRoot(), () => now)
    apply(ledger, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'work' } })
    apply(ledger, { kind: 'run', taskId: 'a' })
    const executionId = ledger.state().tasks[0].executions[0].id
    ledger.attachSession('a', executionId, 'session-a')
    apply(ledger, { kind: 'pause', taskId: 'a' })
    const result = apply(ledger, { kind: 'continue', taskId: 'a' })
    expect(result.resumeRuns).toEqual([{ sessionId: 'session-a', task: expect.objectContaining({ id: 'a', prompt: 'work' }) }])
    const execution = ledger.state().tasks[0].executions[0]
    expect(execution.pausedAt).toBeUndefined()
    expect(execution.watchFromAt).toBe(now)
    expect(execution.endedAt).toBeUndefined()
  })

  it('refuses to pause a non-running task, pause twice, or continue an unpaused task', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'work' } })
    expect(() => apply(ledger, { kind: 'pause', taskId: 'a' })).toThrow('task is not running')
    apply(ledger, { kind: 'run', taskId: 'a' })
    expect(() => apply(ledger, { kind: 'continue', taskId: 'a' })).toThrow('task is not paused')
    apply(ledger, { kind: 'pause', taskId: 'a' })
    expect(() => apply(ledger, { kind: 'pause', taskId: 'a' })).toThrow('already paused')
    expect(() => apply(ledger, { kind: 'stop', taskId: 'a' })).not.toThrow()
  })

  it('pauses a queued run (no session yet) and holds it without cancelling anything', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'work' } })
    apply(ledger, { kind: 'run', taskId: 'a' })
    const executionId = ledger.state().tasks[0].executions[0].id
    ledger.markQueued('a', executionId, 'endpoint-1', NOW, 'endpoint')
    const result = apply(ledger, { kind: 'pause', taskId: 'a' })
    expect(result.stopSessions).toBeUndefined()
    const execution = ledger.state().tasks[0].executions[0]
    expect(execution.pausedAt).toBe(NOW)
    expect(execution.queuedAt).toBe(NOW)
    expect(execution.sessionId).toBeUndefined()
    // Continue clears the pause and leaves the queued run to the router.
    const resumed = apply(ledger, { kind: 'continue', taskId: 'a' })
    expect(resumed.resumeRuns).toBeUndefined()
    expect(ledger.state().tasks[0].executions[0].pausedAt).toBeUndefined()
  })

  it('pause-group pauses every open member and blocks launches; continue-group resumes them', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create-group', id: 'g1', input: { name: 'G' } })
    for (const id of ['a', 'b']) {
      apply(ledger, { kind: 'create', id, input: { title: id, description: '', prompt: id } })
      apply(ledger, { kind: 'update', taskId: id, patch: { groupId: 'g1' } })
      apply(ledger, { kind: 'run', taskId: id })
      ledger.attachSession(id, ledger.state().tasks.find(t => t.id === id)!.executions[0].id, `session-${id}`)
    }
    const result = apply(ledger, { kind: 'pause-group', groupId: 'g1' })
    expect(result.stopSessions?.sort()).toEqual(['session-a', 'session-b'])
    expect(ledger.state().groups[0].paused).toBe(true)
    for (const id of ['a', 'b']) {
      expect(ledger.state().tasks.find(t => t.id === id)!.executions[0].pausedAt).toBe(NOW)
    }
    expect(() => apply(ledger, { kind: 'run-group', groupId: 'g1' })).toThrow('group is paused')
    const resumed = apply(ledger, { kind: 'continue-group', groupId: 'g1' })
    expect(resumed.resumeRuns?.map(run => run.sessionId).sort()).toEqual(['session-a', 'session-b'])
    expect(ledger.state().groups[0].paused).toBeUndefined()
    for (const id of ['a', 'b']) {
      const execution = ledger.state().tasks.find(t => t.id === id)!.executions[0]
      expect(execution.pausedAt).toBeUndefined()
      expect(execution.watchFromAt).toBe(NOW)
    }
  })

  it('pause-group refuses a stopped or already paused group', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create-group', id: 'g1', input: { name: 'G' } })
    apply(ledger, { kind: 'stop-group', groupId: 'g1' })
    expect(() => apply(ledger, { kind: 'pause-group', groupId: 'g1' })).toThrow('group is stopped')
    apply(ledger, { kind: 'update-group', groupId: 'g1', patch: { stopped: false } })
    apply(ledger, { kind: 'pause-group', groupId: 'g1' })
    expect(() => apply(ledger, { kind: 'pause-group', groupId: 'g1' })).toThrow('already paused')
    expect(() => apply(ledger, { kind: 'continue-group', groupId: 'g1' })).not.toThrow()
    expect(() => apply(ledger, { kind: 'continue-group', groupId: 'g1' })).toThrow('group is not paused')
  })

  it('pause-workspace pauses every open execution pinned to the workspace and blocks new runs', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    for (const [id, workspaceId] of [['a', 'w1'], ['b', 'w1'], ['c', 'w2']] as const) {
      apply(ledger, { kind: 'create', id, input: { title: id, description: '', prompt: id, workspaceId } })
      apply(ledger, { kind: 'run', taskId: id })
      ledger.attachSession(id, ledger.state().tasks.find(t => t.id === id)!.executions[0].id, `session-${id}`)
    }
    const result = apply(ledger, { kind: 'pause-workspace', workspaceId: 'w1' })
    expect(result.stopSessions?.sort()).toEqual(['session-a', 'session-b'])
    expect(ledger.state().workspacePaused).toEqual({ w1: NOW })
    expect(ledger.state().tasks.find(t => t.id === 'a')!.executions[0].pausedAt).toBe(NOW)
    expect(ledger.state().tasks.find(t => t.id === 'b')!.executions[0].pausedAt).toBe(NOW)
    expect(ledger.state().tasks.find(t => t.id === 'c')!.executions[0].pausedAt).toBeUndefined()
    // A task pinned to the paused workspace cannot launch by any means.
    apply(ledger, { kind: 'create', id: 'd', input: { title: 'D', description: '', prompt: 'd', workspaceId: 'w1' } })
    expect(() => apply(ledger, { kind: 'run', taskId: 'd' })).toThrow('workspace is paused')
    const resumed = apply(ledger, { kind: 'continue-workspace', workspaceId: 'w1' })
    expect(resumed.resumeRuns?.map(run => run.sessionId).sort()).toEqual(['session-a', 'session-b'])
    expect(ledger.state().workspacePaused).toEqual({})
    expect(() => apply(ledger, { kind: 'run', taskId: 'd' })).not.toThrow()
    expect(() => apply(ledger, { kind: 'continue-workspace', workspaceId: 'w1' })).toThrow('workspace is not paused')
  })

  it("pausing the whole board (the empty string) covers unassigned tasks and every workspace", () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'a' } })
    apply(ledger, { kind: 'create', id: 'b', input: { title: 'B', description: '', prompt: 'b', workspaceId: 'w1' } })
    apply(ledger, { kind: 'run', taskId: 'a' })
    ledger.attachSession('a', ledger.state().tasks[0].executions[0].id, 'session-a')
    const result = apply(ledger, { kind: 'pause-workspace', workspaceId: '' })
    expect(result.stopSessions).toEqual(['session-a'])
    expect(ledger.state().workspacePaused).toEqual({ '': NOW })
    // A todo task in any workspace is blocked by the whole-board pause.
    expect(() => apply(ledger, { kind: 'run', taskId: 'b' })).toThrow('workspace is paused')
    apply(ledger, { kind: 'continue-workspace', workspaceId: '' })
    expect(ledger.state().workspacePaused).toEqual({})
    expect(() => apply(ledger, { kind: 'run', taskId: 'b' })).not.toThrow()
  })

  it('holds a paused workspace task cron (rolls forward)', () => {
    const now = NOW
    const ledger = new HostTaskLedger(tempRoot(), () => now)
    apply(ledger, {
      kind: 'create', id: 'a', input: {
        title: 'A', description: '', prompt: 'a', workspaceId: 'w1',
        schedule: { enabled: true, cron: '* * * * *' },
      },
    })
    expect(ledger.state().tasks[0].schedule?.enabled).toBe(true)
    apply(ledger, { kind: 'pause-workspace', workspaceId: 'w1' })
    // The due occurrence is held: no execution opens and the schedule rolls forward.
    const opened = ledger.openScheduled('a', now + 60_000, now)
    expect(opened).toBeUndefined()
    const after = ledger.state().tasks[0]
    expect(after.schedule?.nextRunAt).toBe(now + 60_000)
    expect(after.executions).toHaveLength(0)
  })

  it('persists paused state, group paused flags, and workspace pauses across a restart', () => {
    const root = tempRoot()
    const first = new HostTaskLedger(root, () => NOW)
    apply(first, { kind: 'create-group', id: 'g1', input: { name: 'G', workspaceId: 'w1' } })
    apply(first, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'a', workspaceId: 'w1', groupId: 'g1' } })
    apply(first, { kind: 'run', taskId: 'a' })
    const executionId = first.state().tasks[0].executions[0].id
    first.attachSession('a', executionId, 'session-a')
    apply(first, { kind: 'pause', taskId: 'a' })
    apply(first, { kind: 'pause-group', groupId: 'g1' })
    apply(first, { kind: 'pause-workspace', workspaceId: 'w1' })
    first.dispose()

    const restarted = new HostTaskLedger(root, () => NOW)
    expect(restarted.state().tasks[0].executions[0].pausedAt).toBe(NOW)
    expect(restarted.state().workspacePaused).toEqual({ w1: NOW })
    expect(restarted.state().groups[0].paused).toBe(true)
    // A paused run with a session survives the restart reconciliation untouched.
    expect(restarted.state().tasks[0].status).toBe('running')
    expect(restarted.state().tasks[0].executions[0].endedAt).toBeUndefined()
  })

  it('stop-group clears a stale paused flag while settling members cancelled', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create-group', id: 'g1', input: { name: 'G' } })
    apply(ledger, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'a', groupId: 'g1' } })
    apply(ledger, { kind: 'run', taskId: 'a' })
    ledger.attachSession('a', ledger.state().tasks[0].executions[0].id, 'session-a')
    apply(ledger, { kind: 'pause-group', groupId: 'g1' })
    apply(ledger, { kind: 'stop-group', groupId: 'g1' })
    const group = ledger.state().groups[0]
    expect(group.stopped).toBe(true)
    expect(group.paused).toBeUndefined()
    expect(ledger.state().tasks[0].executions[0].result).toBe('cancelled')
  })

  it('keeps paused executions out of the runnable member set of their group', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create-group', id: 'g1', input: { name: 'G' } })
    for (const id of ['a', 'b']) {
      apply(ledger, { kind: 'create', id, input: { title: id, description: '', prompt: id, groupId: 'g1' } })
    }
    // A paused member keeps its launched slot: the sequence sees it launched
    // (so a second member never auto-starts over it) and the group capacity
    // is full.
    apply(ledger, { kind: 'run', taskId: 'a' })
    ledger.attachSession('a', ledger.state().tasks[0].executions[0].id, 'session-a')
    apply(ledger, { kind: 'pause', taskId: 'a' })
    let view = ledger.groupRuntimeViews().find(view => view.id === 'g1')!
    const memberA = view.members.find(member => member.taskId === 'a')!
    const memberB = view.members.find(member => member.taskId === 'b')!
    expect(memberA.launched).toBe(true)
    expect(memberA.runnable).toBe(false)
    expect(memberB.runnable).toBe(true)
    // A manual run of the second member still queues behind the paused member.
    apply(ledger, { kind: 'run', taskId: 'b' })
    const bExecution = ledger.state().tasks.find(t => t.id === 'b')!.executions[0]
    expect(bExecution.endedAt).toBeUndefined()
    expect(bExecution.sessionId).toBeUndefined()
    // Continue re-prompts a, which is running again; b still holds its queued
    // run behind the occupied slot.
    apply(ledger, { kind: 'continue', taskId: 'a' })
    view = ledger.groupRuntimeViews().find(view => view.id === 'g1')!
    expect(view.members.find(member => member.taskId === 'a')!.launched).toBe(true)
    expect(view.members.find(member => member.taskId === 'b')!.queued).toBe(true)
    expect(view.members.find(member => member.taskId === 'b')!.runnable).toBe(false)
  })

  it('a paused workspace removes its members from the group runnable set', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, { kind: 'create-group', id: 'g1', input: { name: 'G', workspaceId: 'w1' } })
    for (const id of ['a', 'b']) {
      apply(ledger, { kind: 'create', id, input: { title: id, description: '', prompt: id, groupId: 'g1', workspaceId: 'w1' } })
    }
    apply(ledger, { kind: 'pause-workspace', workspaceId: 'w1' })
    expect(() => apply(ledger, { kind: 'run-group', groupId: 'g1' })).toThrow('no runnable members')
    const view = ledger.groupRuntimeViews().find(view => view.id === 'g1')!
    expect(view.members.every(member => !member.runnable)).toBe(true)
    apply(ledger, { kind: 'continue-workspace', workspaceId: 'w1' })
    expect(() => apply(ledger, { kind: 'run-group', groupId: 'g1' })).not.toThrow()
  })

  it('skips a paused group cron and a paused group member cron', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    apply(ledger, {
      kind: 'create-group', id: 'g1', input: { name: 'G', schedule: { enabled: true, cron: '* * * * *' } },
    })
    apply(ledger, { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'a', groupId: 'g1' } })
    // Due at the top of the next minute (the armed next-run instant).
    const dueAt = NOW + 60_000
    expect(ledger.dueGroupSchedules(dueAt)).toHaveLength(1)
    // Pausing the group holds the group cron and the member's own cron.
    apply(ledger, { kind: 'pause-group', groupId: 'g1' })
    expect(ledger.dueGroupSchedules(dueAt)).toEqual([])
    expect(ledger.dueSchedules(dueAt)).toEqual([])
    apply(ledger, { kind: 'continue-group', groupId: 'g1' })
    expect(ledger.dueGroupSchedules(dueAt)).toHaveLength(1)
  })

  it('group helper createGroup still normalizes a paused flag into the record', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    expect(group.paused).toBeUndefined()
  })
})
