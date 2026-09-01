/**
 * Sequential-group launch guarantees (reproduction suite for the "second task
 * started while the first was still running" incident):
 *
 *  1. A manual run of a later member is queued while an earlier member runs.
 *  2. When the running member settles with several members queued, exactly one
 *     slot is released (never two).
 *  3. Moving a running member out of its group must not free the group's
 *     capacity slot (the slot-leak that lets a second member launch early).
 *  4. An ungrouped task runs freely (the intended bypass — it is not a member).
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
  const value = mkdtempSync(join(tmpdir(), 'dsh-seq-group-'))
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

/** A sequential group g1 with members a, b, c and a fake DSH api. */
function setup(ledger: HostTaskLedger): void {
  ledger.applyRequest('create-group', { kind: 'create-group', id: 'g1', input: { name: 'Seq', mode: 'sequential' } })
  for (const [id, title] of [['a', 'Member A'], ['b', 'Member B'], ['c', 'Member C']] as const) {
    ledger.applyRequest(`create-${id}`, {
      kind: 'create', id, input: { title, description: '', prompt: 'work', groupId: 'g1' },
    })
  }
}

function harness(ledger: HostTaskLedger): { service: AllTasksHostService; create: ReturnType<typeof vi.fn> } {
  let sessionCounter = 0
  const create = vi.fn(async (request: { rpcId: unknown }) => {
    sessionCounter += 1
    return ok(request, { sessionId: `session-${sessionCounter}` })
  })
  const api = {
    sessions: {
      create,
      rename: async (request: { rpcId: unknown }) => ok(request, { title: 'x', seq: 1 }),
      prompt: async (request: { rpcId: unknown }) => ok(request, { accepted: true }),
      cancel: async (request: { rpcId: unknown }) => ok(request, { cancelled: true }),
    },
  } as unknown as ApiProxy
  const service = new AllTasksHostService(api, {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
  })
  return { service, create }
}

function executionOf(ledger: HostTaskLedger, taskId: string) {
  const task = ledger.state().tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new Error(`task ${taskId} not found`)
  return task.executions[0]
}

describe('sequential group launch guarantees', () => {
  it('queues a manual run of a later member while an earlier member is running', async () => {
    const ledger = new HostTaskLedger(root())
    setup(ledger)
    const { service, create } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(executionOf(ledger, 'a').sessionId).toBe('session-1')

    service.apply('run-c', { kind: 'run', taskId: 'c' })
    await flush()
    expect(create).toHaveBeenCalledTimes(1) // no second session
    expect(executionOf(ledger, 'c').queuedAt).toBeDefined() // queued, not launched
    expect(executionOf(ledger, 'c').sessionId).toBeUndefined()
    service.dispose()
  })

  it('releases exactly one slot when the running member settles with several queued', async () => {
    const ledger = new HostTaskLedger(root())
    setup(ledger)
    const { service, create } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    service.apply('run-b', { kind: 'run', taskId: 'b' })
    service.apply('run-c', { kind: 'run', taskId: 'c' })
    await flush()
    expect(executionOf(ledger, 'b').queuedAt).toBeDefined()
    expect(executionOf(ledger, 'c').queuedAt).toBeDefined()

    service.apply('stop-a', { kind: 'stop', taskId: 'a' })
    await flush(6)
    const launched = ['b', 'c'].filter(taskId => executionOf(ledger, taskId).sessionId !== undefined)
    expect(launched).toHaveLength(1) // sequential: one member at a time
    expect(create).toHaveBeenCalledTimes(2) // a + exactly one of b/c
    service.dispose()
  })

  it('refuses to move a running member out of its group (its slot must not leak)', async () => {
    const ledger = new HostTaskLedger(root())
    setup(ledger)
    const { service, create } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(executionOf(ledger, 'a').sessionId).toBe('session-1')

    // Moving the running member out of the group must be refused; otherwise
    // its capacity slot vanishes and the next member launches early.
    expect(() => {
      ledger.applyRequest('ungroup-a', { kind: 'update', taskId: 'a', patch: { groupId: null } })
    }).toThrow(/running task cannot be moved between groups/)

    service.apply('run-b', { kind: 'run', taskId: 'b' })
    await flush()
    expect(create).toHaveBeenCalledTimes(1) // b must stay queued behind a
    expect(executionOf(ledger, 'b').queuedAt).toBeDefined()
    expect(executionOf(ledger, 'b').sessionId).toBeUndefined()
    service.dispose()
  })

  it('an ungrouped task is not a member and runs freely (intended bypass)', async () => {
    const ledger = new HostTaskLedger(root())
    setup(ledger)
    ledger.applyRequest('create-standalone', {
      kind: 'create', id: 'standalone', input: { title: 'Lone', description: '', prompt: 'work' },
    })
    const { service, create } = harness(ledger)

    service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    service.apply('run-standalone', { kind: 'run', taskId: 'standalone' })
    await flush()
    expect(executionOf(ledger, 'standalone').sessionId).toBeDefined() // ungrouped: no gate
    expect(create).toHaveBeenCalledTimes(2)
    service.dispose()
  })
})
