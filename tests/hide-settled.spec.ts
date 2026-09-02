/**
 * Hide-settled-tasks end-to-end: the protocol's hide-tasks action archives a
 * whole Done/Failed column in one ledger revision, and — when the browser
 * asked for it — the Host derives the hidden tasks' execution session ids and
 * archives each one in the DSH workspace registry (best-effort, after the
 * commit).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { AllTasksHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()
const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-all-tasks-hide-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

/** A settled task with one recorded execution per given session id. */
function settled(id: string, status: 'done' | 'failed', sessions: (string | undefined)[]): TaskRecord {
  return {
    ...createTask({ title: id, description: '', prompt: id }, NOW - 60_000, id),
    status,
    executions: sessions.map((sessionId, index) => ({
      id: `${id}-e${index}`,
      sessionId,
      startedAt: NOW + index,
      endedAt: NOW + index + 1,
      result: 'succeeded' as const,
      error: undefined,
    })),
  }
}

function seededLedger(): HostTaskLedger {
  const ledger = new HostTaskLedger(root(), () => NOW)
  const done = settled('done-a', 'done', ['session-1', 'session-2'])
  const doneNoSession = settled('done-b', 'done', [undefined])
  const failed = settled('failed-a', 'failed', ['session-2', 'session-3'])
  ledger.applyRequest('seed', { kind: 'import', sourceId: 'seed', tasks: [done, doneNoSession, failed] })
  return ledger
}

describe('hide-tasks ledger action', () => {
  it('archives every requested settled task in one revision (no session archiving)', () => {
    const ledger = seededLedger()
    const before = ledger.state().revision
    const result = ledger.applyRequest('hide', {
      kind: 'hide-tasks',
      taskIds: ['done-a', 'failed-a'],
      archiveSessions: false,
    })
    expect(result.state.revision).toBe(before + 1)
    const tasks = result.state.tasks
    expect(tasks.find(task => task.id === 'done-a')).toMatchObject({ status: 'done', archivedAt: NOW })
    expect(tasks.find(task => task.id === 'failed-a')).toMatchObject({ status: 'failed', archivedAt: NOW })
    expect(tasks.find(task => task.id === 'done-b')?.archivedAt).toBeUndefined()
    expect(result.archiveSessions).toBeUndefined()
  })

  it('derives the distinct execution session ids of the hidden tasks when asked', () => {
    const ledger = seededLedger()
    const result = ledger.applyRequest('hide-with-sessions', {
      kind: 'hide-tasks',
      taskIds: ['done-a', 'failed-a', 'done-b'],
      archiveSessions: true,
    })
    // Distinct ids across the hidden tasks' executions, in first-appearance
    // order; the interrupted (session-less) run contributes nothing.
    expect(result.archiveSessions).toEqual(['session-1', 'session-2', 'session-3'])
    const hidden = result.state.tasks.filter(task => ['done-a', 'failed-a', 'done-b'].includes(task.id))
    expect(hidden.every(task => task.archivedAt !== undefined)).toBe(true)
  })

  it('fails the whole action closed when any requested task is not archivable', () => {
    const ledger = seededLedger()
    // A todo task (or a bogus id) makes the whole hide fail: the column never
    // half-disappears behind one stale card.
    expect(() => ledger.applyRequest('hide-bad', {
      kind: 'hide-tasks',
      taskIds: ['done-a', 'todo-x'],
      archiveSessions: false,
    })).toThrow('task cannot be archived')
    expect(() => ledger.applyRequest('hide-ghost', {
      kind: 'hide-tasks',
      taskIds: ['done-a', 'ghost'],
      archiveSessions: false,
    })).toThrow('task cannot be archived')
    expect(ledger.state().tasks.find(task => task.id === 'done-a')?.archivedAt).toBeUndefined()
  })

  it('refuses to hide an already-archived task', () => {
    const ledger = seededLedger()
    ledger.applyRequest('hide-first', { kind: 'hide-tasks', taskIds: ['done-a'], archiveSessions: false })
    expect(() => ledger.applyRequest('hide-again', {
      kind: 'hide-tasks',
      taskIds: ['done-a', 'failed-a'],
      archiveSessions: false,
    })).toThrow('task cannot be archived')
    expect(ledger.state().tasks.find(task => task.id === 'failed-a')?.archivedAt).toBeUndefined()
  })
})

describe('hide-tasks host side effect', () => {
  function serviceWithLedger(ledger: HostTaskLedger) {
    const archiveSession = vi.fn(async (request: { payload: { sessionId: string } }) =>
      ({ rpcId: '', result: { ok: true as const, value: { archivedSessionIds: [] } } }))
    const api = {
      sessions: {},
      workspace: { archiveSession },
    } as unknown as ApiProxy
    const service = new AllTasksHostService(api, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => NOW,
    })
    return { service, archiveSession }
  }

  it('fires workspace.archiveSession for each hidden execution session after the commit', async () => {
    const ledger = seededLedger()
    const { service, archiveSession } = serviceWithLedger(ledger)
    const snapshot = service.apply('hide', {
      kind: 'hide-tasks',
      taskIds: ['done-a', 'failed-a'],
      archiveSessions: true,
    })
    expect(snapshot.tasks.filter(task => task.id !== 'done-b').every(task => task.archivedAt !== undefined)).toBe(true)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(archiveSession).toHaveBeenCalledTimes(3)
    const ids = archiveSession.mock.calls.map(([request]) => request.payload.sessionId)
    expect(ids).toEqual(['session-1', 'session-2', 'session-3'])
    service.dispose()
  })

  it('does not touch sessions when the flag is off', async () => {
    const ledger = seededLedger()
    const { service, archiveSession } = serviceWithLedger(ledger)
    service.apply('hide', { kind: 'hide-tasks', taskIds: ['done-a'], archiveSessions: false })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(archiveSession).not.toHaveBeenCalled()
    service.dispose()
  })
})
