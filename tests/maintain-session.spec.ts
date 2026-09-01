/**
 * Maintain-session sequential groups: the shared-session execution path.
 *
 * A sequential group with `maintainSession` runs every member in one DSH
 * session — the first member creates it, every later member continues it — so
 * the conversation context carries across tasks. With `compactBetween` the
 * runner dispatches `/compact` on the shared session before each member's
 * prompt, keeping the context bounded without losing it.
 *
 * These tests drive the real Host service (AllTasksHostService + ledger +
 * runner) against a fake DSH api, so they cover the full launch/settle/advance
 * wiring: the first member creates the session, the auto-advance chain reuses
 * it, /compact is dispatched between members, a parallel group never shares,
 * and a member pinned to a different workspace/preset fails closed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { AllTasksHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-maintain-session-'))
  roots.push(value)
  return value
}

function ok<T>(request: { rpcId: unknown }, value: T) {
  return { rpcId: request.rpcId, result: { ok: true as const, value } }
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

/** Let the service's async launch/route passes settle (microtasks + one tick). */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/** Fake DSH api with a session counter plus shared-session RPCs. */
function harness(ledger: HostTaskLedger, commands?: { execute: ReturnType<typeof vi.fn> }) {
  let sessionCounter = 0
  /** The fake DSH session table; tests may remove sessions to simulate deletion. */
  const liveSessions = new Set<string>()
  const create = vi.fn(async (request: { rpcId: unknown }) => {
    sessionCounter += 1
    const sessionId = `session-${sessionCounter}`
    liveSessions.add(sessionId)
    return ok(request, { sessionId })
  })
  const prompt = vi.fn(async (request: { rpcId: unknown }) => ok(request, { accepted: true }))
  const sessions = {
    create,
    prompt,
    rename: async (request: { rpcId: unknown }) => ok(request, { title: 'x', seq: 1 }),
    cancel: async (request: { rpcId: unknown }) => ok(request, { cancelled: true }),
    selectModel: async (request: { rpcId: unknown }) => ok(request, { selected: true }),
    list: async (request: { rpcId: unknown }) => ok(request, {
      items: [...liveSessions].map(sessionId => ({ sessionId, running: false })),
    }),
  }
  const service = new AllTasksHostService({ sessions } as unknown as ApiProxy, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    ...(commands === undefined ? {} : { commandDispatcher: commands }),
  })
  return { service, create, prompt, sessions, liveSessions }
}

/** A sequential group g1 with members a, b (create+membership through Host actions). */
function seedGroup(ledger: HostTaskLedger, groupId = 'g1', mode: 'sequential' | 'parallel' = 'sequential', extra: Record<string, unknown> = {}): void {
  ledger.applyRequest('create-group', {
    kind: 'create-group', id: groupId, input: { name: 'Seq', mode, ...extra },
  })
  for (const id of ['a', 'b']) {
    ledger.applyRequest(`create-${id}`, {
      kind: 'create', id, input: { title: `Member ${id}`, description: '', prompt: `work ${id}`, groupId },
    })
  }
}

function executionOf(ledger: HostTaskLedger, taskId: string) {
  const task = ledger.state().tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new Error(`task ${taskId} not found`)
  return task.executions[0]
}

describe('maintain-session sequential groups', () => {
  it('reuses the first member\'s session for the auto-advance chain', async () => {
    const ledger = new HostTaskLedger(root())
    seedGroup(ledger, 'g1', 'sequential', { maintainSession: true })
    const { service, create } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(executionOf(ledger, 'a').sessionId).toBe('session-1')

    // When a settles, the chain launches b into the same session (no create).
    ledger.settle('a', executionOf(ledger, 'a').id, 'succeeded')
    await flush()
    expect(executionOf(ledger, 'b').sessionId).toBe('session-1')
    expect(create).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('runs /compact on the shared session between members when compactBetween is on', async () => {
    const ledger = new HostTaskLedger(root())
    seedGroup(ledger, 'g1', 'sequential', { maintainSession: true, compactBetween: true })
    const execute = vi.fn(async (_sessionId: string, _line: string) => ({ kind: 'success' as const }))
    const { service, create } = harness(ledger, { execute })

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(execute).not.toHaveBeenCalled() // nothing to compact before the first member

    ledger.settle('a', executionOf(ledger, 'a').id, 'succeeded')
    await flush()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe('session-1')
    expect(execute.mock.calls[0][1]).toBe('/compact')
    expect(executionOf(ledger, 'b').sessionId).toBe('session-1')
    expect(create).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('keeps the shared session when compactBetween is off (no /compact dispatched)', async () => {
    const ledger = new HostTaskLedger(root())
    seedGroup(ledger, 'g1', 'sequential', { maintainSession: true })
    const execute = vi.fn(async () => ({ kind: 'success' as const }))
    const { service } = harness(ledger, { execute })

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    ledger.settle('a', executionOf(ledger, 'a').id, 'succeeded')
    await flush()
    expect(execute).not.toHaveBeenCalled()
    expect(executionOf(ledger, 'b').sessionId).toBe('session-1')
    service.dispose()
  })

  it('never shares a session across a parallel group, even with the flag stored', async () => {
    const ledger = new HostTaskLedger(root())
    seedGroup(ledger, 'g1', 'parallel', { maintainSession: true, maxParallel: 2 })
    const { service, create } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    service.apply('run-b', { kind: 'run', taskId: 'b' })
    await flush()
    // Parallel: both launch at once, each in its own fresh session.
    expect(create).toHaveBeenCalledTimes(2)
    expect(executionOf(ledger, 'a').sessionId).toBe('session-1')
    expect(executionOf(ledger, 'b').sessionId).toBe('session-2')
    service.dispose()
  })

  it('fails closed when a maintain-session member pins a different workspace/preset', async () => {
    const ledger = new HostTaskLedger(root())
    seedGroup(ledger, 'g1', 'sequential', { maintainSession: true })
    // Member b pins a different agent preset than the shared session's creator
    // (a different workspace would remove it from the workspace-scoped group,
    // so the preset is what trips the shared-session composition check).
    ledger.applyRequest('update-b', { kind: 'update', taskId: 'b', patch: { mode: 'different-preset' } })
    const { service, create } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(executionOf(ledger, 'a').sessionId).toBe('session-1')

    ledger.settle('a', executionOf(ledger, 'a').id, 'succeeded')
    await flush()
    const b = executionOf(ledger, 'b')
    expect(b.result).toBe('failed')
    expect(b.error).toContain('must share the same workspace and agent preset')
    expect(create).toHaveBeenCalledTimes(1) // never launched a fresh session for b
    service.dispose()
  })

  it('starts a fresh session when the shared session no longer exists', async () => {
    const ledger = new HostTaskLedger(root())
    seedGroup(ledger, 'g1', 'sequential', { maintainSession: true })
    const { service, create, liveSessions } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(executionOf(ledger, 'a').sessionId).toBe('session-1')

    // The shared session is deleted out-of-band; the next member gets a fresh one.
    liveSessions.delete('session-1')
    ledger.settle('a', executionOf(ledger, 'a').id, 'succeeded')
    await flush()
    expect(executionOf(ledger, 'b').sessionId).toBe('session-2')
    expect(create).toHaveBeenCalledTimes(2)
    service.dispose()
  })
})
