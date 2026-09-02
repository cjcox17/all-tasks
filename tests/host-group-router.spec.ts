import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EndpointConfig, EndpointRouterConfig } from '../src/core/endpoints.ts'
import { nextRunAtMs } from '../src/core/schedule.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { AllTasksHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-all-tasks-group-'))
  roots.push(value)
  return value
}

function ok<T>(request: { rpcId: unknown }, value: T) {
  return { rpcId: request.rpcId, result: { ok: true as const, value } }
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function endpoint(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    id: 'cloud',
    name: 'Cloud',
    provider: 'deepseek',
    models: [],
    ...overrides,
  }
}

function routerConfig(endpoints: readonly EndpointConfig[], overrides: Partial<EndpointRouterConfig> = {}): EndpointRouterConfig {
  return { endpointMaxWaitHours: 24, defaultEndpoints: [], endpoints: [...endpoints], ...overrides }
}

function launchApi(create: ReturnType<typeof vi.fn>) {
  return {
    sessions: {
      create,
      selectModel: async (request: { rpcId: unknown; payload?: { model?: unknown } }) => ok(request, {
        selected: { provider: 'deepseek', model: request.payload?.model ?? 'deepseek-chat' },
      }),
      rename: async (request: { rpcId: unknown }) => ok(request, { title: 'Task', seq: 1 }),
      prompt: async (request: { rpcId: unknown }) => ok(request, { accepted: true }),
      cancel: async (request: { rpcId: unknown }) => ok(request, { accepted: true }),
    },
  } as unknown as ApiProxy
}

interface ServiceHarness {
  service: AllTasksHostService
  ledger: HostTaskLedger
  create: ReturnType<typeof vi.fn>
  routeQueued: () => Promise<void>
  advanceGroups: () => void
  tickSchedule: (first: boolean) => Promise<void>
}

function harness(dir: string, config: EndpointRouterConfig, now: () => number): ServiceHarness {
  const create = vi.fn(async (request) => ok(request, { sessionId: 'session-x' }))
  const ledger = new HostTaskLedger(dir, now)
  const service = new AllTasksHostService(launchApi(create), {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now,
    routerConfig: config,
  })
  const untyped = service as unknown as {
    routeQueued(): Promise<void>
    advanceGroups(): void
    tickSchedule(first: boolean): Promise<void>
  }
  return {
    service,
    ledger,
    create,
    routeQueued: () => untyped.routeQueued(),
    advanceGroups: () => untyped.advanceGroups(),
    tickSchedule: first => untyped.tickSchedule(first),
  }
}

/** Create a group + N member tasks pinned to it (through the Host actions). */
function seedGroup(h: ServiceHarness, groupId: string, name: string, taskIds: string[], input: Record<string, unknown> = {}): void {
  h.ledger.applyRequest('group-' + groupId, {
    kind: 'create-group', id: groupId, input: { name, mode: 'sequential', ...input },
  })
  for (const taskId of taskIds) {
    h.ledger.applyRequest('create-' + taskId, {
      kind: 'create', id: taskId, input: { title: taskId, description: '', prompt: 'work', groupId },
    })
  }
}

describe('AllTasksHostService group routing', () => {
  it('queues a second member of a sequential group while the first runs, then launches it after a settle', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Seq', ['a', 'b'])

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()

    h.service.apply('run-b', { kind: 'run', taskId: 'b' })
    await flush()
    const b = h.ledger.state().tasks.find(task => task.id === 'b')!
    expect(b.executions[0]!.queuedAt).toBeDefined()
    expect(b.executions[0]!.queuedReason).toBe('group')
    expect(b.executions[0]!.sessionId).toBeUndefined()
    expect(h.create).toHaveBeenCalledOnce()

    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    await h.routeQueued()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions[0]!.sessionId).toBe('session-x')
    h.service.dispose()
  })

  it('holds a parallel group at maxParallel and releases a slot on settle', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Par', ['a', 'b', 'c'], { mode: 'parallel', maxParallel: 2 })

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    h.service.apply('run-b', { kind: 'run', taskId: 'b' })
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)

    h.service.apply('run-c', { kind: 'run', taskId: 'c' })
    await flush()
    const c = h.ledger.state().tasks.find(task => task.id === 'c')!
    expect(c.executions[0]!.queuedReason).toBe('group')
    expect(h.create).toHaveBeenCalledTimes(2)

    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    await h.routeQueued()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(3)
    expect(h.ledger.state().tasks.find(task => task.id === 'c')!.executions[0]!.sessionId).toBe('session-x')
    h.service.dispose()
  })

  it('waits outside the group allowed window and auto-starts inside it', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime() // host-local 10:00
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Window', ['a'], { allowedHours: { start: '12:00', end: '14:00' } })

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    expect(a.executions[0]!.queuedAt).toBeDefined()
    expect(a.executions[0]!.queuedReason).toBe('window')
    expect(h.create).not.toHaveBeenCalled()

    now = new Date(2026, 7, 16, 13, 0, 0).getTime()
    await h.routeQueued()
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.executions[0]!.sessionId).toBe('session-x')
    h.service.dispose()
  })

  it('holds an off-peak-only group during peak and launches inside the DeepSeek window', async () => {
    let now = Date.UTC(2026, 6, 16, 2, 0, 0) // Thu 02:00 UTC — inside peak block 1
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'OffPeak', ['a'], { offPeakOnly: true })

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.executions[0]!.queuedReason).toBe('window')
    expect(h.create).not.toHaveBeenCalled()

    now = Date.UTC(2026, 6, 16, 12, 0, 0) // 12:00 UTC — off-peak
    await h.routeQueued()
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    h.service.dispose()
  })

  it('prefers the task endpoint pin over the group list, then the group list over the global default', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const config = routerConfig([
      endpoint({ id: 'local', provider: 'lm-studio', defaultModel: 'qwen/qwen3.8-27b' }),
      endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' }),
    ])
    const h = harness(dir, config, () => now)
    seedGroup(h, 'g1', 'Endpoints', ['a'], { endpoints: ['local'] })

    // Task pin wins over the group list.
    h.ledger.applyRequest('pin', { kind: 'update', taskId: 'a', patch: { endpoints: ['cloud'] } })
    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.executions[0]!.endpointId).toBe('cloud')

    // Clear the pin: the group list applies.
    h.ledger.applyRequest('unpin', { kind: 'update', taskId: 'a', patch: { endpoints: null } })
    h.ledger.settle('a', h.ledger.state().tasks.find(task => task.id === 'a')!.executions[0]!.id, 'succeeded')
    h.service.apply('run-a2', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.executions[1]!.endpointId).toBe('local')
    h.service.dispose()
  })

  it('auto-advances a sequential group to the next member when the previous one settles', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Chain', ['a', 'b'])

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)
    const b = h.ledger.state().tasks.find(task => task.id === 'b')!
    expect(b.status).toBe('running')
    expect(b.executions[0]!.sessionId).toBe('session-x')
    h.service.dispose()
  })

  it('never auto-starts an idle group (no runs, no schedule)', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Idle', ['a', 'b'])
    h.advanceGroups()
    await flush()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.executions).toHaveLength(0)
    h.service.dispose()
  })

  it('the auto-advance chain skips a member that joined after the sequence started', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Chain', ['a', 'b'])

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()

    // A member joins while the sequence is running: it is held from the chain.
    h.ledger.applyRequest('create-c', { kind: 'create', id: 'c', input: { title: 'C', description: '', prompt: 'work', groupId: 'g1' } })
    const c = h.ledger.state().tasks.find(task => task.id === 'c')!
    expect(c.deferAutoStart).toBe(true)
    expect(c.executions).toHaveLength(0)

    // Settling the running member advances the chain into b (an original
    // member) — never into the held c.
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')
    expect(h.ledger.state().tasks.find(task => task.id === 'c')!.executions).toHaveLength(0)

    // Settling b leaves the held c untouched: the chain never starts it.
    const b = h.ledger.state().tasks.find(task => task.id === 'b')!
    h.ledger.settle('b', b.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.ledger.state().tasks.find(task => task.id === 'c')!.status).toBe('todo')
    expect(h.ledger.state().tasks.find(task => task.id === 'c')!.executions).toHaveLength(0)
    h.service.dispose()
  })

  it('a member joining a scheduled group mid-run is not launched by the chain', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([]), () => now)
    seedGroup(h, 'g1', 'Scheduled', ['a'], {
      mode: 'parallel', maxParallel: 2, schedule: { enabled: true, cron: '0 9 * * *' },
    })
    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()

    // The group cron is armed, so every ledger mutation runs the advance
    // pass — but the held member must never be launched by it.
    h.ledger.applyRequest('create-b', { kind: 'create', id: 'b', input: { title: 'B', description: '', prompt: 'work', groupId: 'g1' } })
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(1)
    const b = h.ledger.state().tasks.find(task => task.id === 'b')!
    expect(b.deferAutoStart).toBe(true)
    expect(b.executions).toHaveLength(0)
    h.service.dispose()
  })

  it('a due group schedule starts the sequence (first runnable member)', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Scheduled', ['a', 'b'], { schedule: { enabled: true, cron: '0 9 * * *' } })
    // Roll the rule into the past so it is due at the next tick.
    h.ledger.rollGroupSchedule('g1', now - 1000, now - 1000)

    await h.tickSchedule(false)
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    expect(a.status).toBe('running')
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)
    h.service.dispose()
  })

  it('a parallel group with a final step never runs it in the burst, then auto-launches it after all members settle', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'FanIn', ['a', 'b'], { mode: 'parallel', maxParallel: 2 })
    h.ledger.applyRequest('designate', { kind: 'update-group', groupId: 'g1', patch: { finalStepTaskId: 'b' } })

    // The burst opens only the parallel member — the final step stays put.
    h.service.apply('run-group', { kind: 'run-group', groupId: 'g1' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.status).toBe('running')
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    // A settles: the advance pass launches the final step (its gate just opened).
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)
    const b = h.ledger.state().tasks.find(task => task.id === 'b')!
    expect(b.status).toBe('running')
    expect(b.executions[0]!.sessionId).toBe('session-x')
    h.service.dispose()
  })

  it('a never-run member blocks the final step until it settles', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'FanIn', ['a', 'c', 'b'], { mode: 'parallel', maxParallel: 2 })
    h.ledger.applyRequest('designate', { kind: 'update-group', groupId: 'g1', patch: { finalStepTaskId: 'b' } })

    // a and c run in parallel; the final step b is never part of the burst.
    h.service.apply('run-group', { kind: 'run-group', groupId: 'g1' })
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    // a settles but c is still running: the final step stays gated.
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    // c settles: the gate opens and the final step launches.
    const c = h.ledger.state().tasks.find(task => task.id === 'c')!
    h.ledger.settle('c', c.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(3)
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')
    h.service.dispose()
  })

  it('refuses a manual run of a gated final step and launches it once the members settle', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'FanIn', ['a', 'b'], { mode: 'parallel', maxParallel: 2 })
    h.ledger.applyRequest('designate', { kind: 'update-group', groupId: 'g1', patch: { finalStepTaskId: 'b' } })

    expect(() => h.ledger.applyRequest('run-b', { kind: 'run', taskId: 'b' })).toThrow('final step waits for all group members to settle')

    // run-group while the gate is closed opens only the parallel member —
    // never the gated final step.
    h.service.apply('run-group-2', { kind: 'run-group', groupId: 'g1' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.status).toBe('running')
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    // Once the parallel member settles, the advance pass starts the final step.
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    const b = h.ledger.state().tasks.find(task => task.id === 'b')!
    expect(b.status).toBe('running')
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.executions).toHaveLength(1)
    h.service.dispose()
  })

  it('a failed member opens the gate by default but blocks it under finalStepRequireSuccess', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Lenient', ['a', 'b'], { mode: 'parallel', maxParallel: 2 })
    h.ledger.applyRequest('designate', { kind: 'update-group', groupId: 'g1', patch: { finalStepTaskId: 'b' } })

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'failed')
    h.advanceGroups()
    await flush()
    // Default: any settled outcome opens the gate.
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')
    h.service.dispose()
  })

  it('a failed member blocks the final step under finalStepRequireSuccess until it succeeds', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Strict', ['a', 'b'], { mode: 'parallel', maxParallel: 2 })
    h.ledger.applyRequest('designate', { kind: 'update-group', groupId: 'g1', patch: { finalStepTaskId: 'b', finalStepRequireSuccess: true } })

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'failed')
    h.advanceGroups()
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    // A successful rerun of a opens the gate; the final step launches.
    h.service.apply('rerun-a', { kind: 'rerun', taskId: 'a' })
    await flush()
    const rerun = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', rerun.executions.at(-1)!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')
    h.service.dispose()
  })

  it('keeps the final-step designation across a Host restart', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const config = routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })])
    {
      const first = harness(dir, config, () => now)
      seedGroup(first, 'g1', 'Persist', ['a', 'b'], { mode: 'parallel', maxParallel: 2 })
      first.ledger.applyRequest('designate', { kind: 'update-group', groupId: 'g1', patch: { finalStepTaskId: 'b', finalStepRequireSuccess: true } })
      first.service.dispose()
    }
    const second = harness(dir, config, () => now)
    expect(second.ledger.state().groups[0]).toMatchObject({ id: 'g1', finalStepTaskId: 'b', finalStepRequireSuccess: true })
    second.service.dispose()
  })

  it('skips a member own cron while its group schedule is armed, and resumes it after', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([]), () => now)
    const next = nextRunAtMs('0 9 * * *', now)!
    h.ledger.applyRequest('create-a', {
      kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'work', schedule: { enabled: true, cron: '0 9 * * *' } },
    })
    // Ungrouped: the task's own cron opens a run.
    expect(h.ledger.openScheduled('a', next, now)).toBeDefined()
    h.ledger.settle('a', h.ledger.state().tasks.find(task => task.id === 'a')!.executions[0]!.id, 'succeeded')

    h.ledger.applyRequest('group-g1', { kind: 'create-group', id: 'g1', input: { name: 'Scheduled', schedule: { enabled: true, cron: '30 8 * * *' } } })
    h.ledger.applyRequest('join', { kind: 'update', taskId: 'a', patch: { groupId: 'g1' } })
    // While the group cron is armed the member's own cron is ignored.
    expect(h.ledger.openScheduled('a', next, now)).toBeUndefined()

    h.ledger.applyRequest('leave', { kind: 'update', taskId: 'a', patch: { groupId: null } })
    expect(h.ledger.openScheduled('a', next, now)).toBeDefined()
    h.service.dispose()
  })

  it('refreshes the waiting reason when the block moves from a group slot to the endpoint', async () => {
    const now = new Date(2026, 7, 16, 13, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig(
      [endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-reasoner'] })],
    ), () => now)
    seedGroup(h, 'g1', 'Seq', ['a', 'b'], { endpoints: ['cloud'] })
    h.ledger.applyRequest('pin-a', { kind: 'update', taskId: 'a', patch: { model: { provider: 'deepseek', model: 'deepseek-reasoner' } } })
    h.ledger.applyRequest('pin-b', { kind: 'update', taskId: 'b', patch: { model: { provider: 'deepseek', model: 'deepseek-chat' } } })

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    h.service.apply('run-b', { kind: 'run', taskId: 'b' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions[0]!.queuedReason).toBe('group')

    // A settles but the endpoint still cannot serve B's pinned model: B's wait
    // becomes an endpoint wait (same queuedAt, refreshed reason).
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    const queuedAt = h.ledger.state().tasks.find(task => task.id === 'b')!.executions[0]!.queuedAt!
    await h.routeQueued()
    const b = h.ledger.state().tasks.find(task => task.id === 'b')!
    expect(b.executions[0]!.queuedReason).toBe('endpoint')
    expect(b.executions[0]!.queuedAt).toBe(queuedAt)
    expect(h.create).toHaveBeenCalledOnce()
    h.service.dispose()
  })

  it('keeps groups and membership across a Host restart', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const config = routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })])
    {
      const first = harness(dir, config, () => now)
      seedGroup(first, 'g1', 'Persist', ['a', 'b'], { mode: 'parallel', maxParallel: 2 })
      first.ledger.applyRequest('reorder', { kind: 'set-group-order', groupId: 'g1', order: ['b', 'a'] })
      first.service.dispose()
    }
    const second = harness(dir, config, () => now)
    const state = second.ledger.state()
    expect(state.groups).toHaveLength(1)
    expect(state.groups[0]).toMatchObject({ id: 'g1', name: 'Persist', mode: 'parallel', maxParallel: 2 })
    expect(state.groups[0]!.order).toEqual(['b', 'a'])
    expect(state.tasks.filter(task => task.groupId === 'g1')).toHaveLength(2)
    second.service.dispose()
  })

  it('deletes a group and ungroups its members; refuses while a member runs', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([]), () => now)
    seedGroup(h, 'g1', 'Del', ['a'])

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(() => h.ledger.applyRequest('del-1', { kind: 'delete-group', groupId: 'g1' })).toThrow('group has running tasks')

    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    h.ledger.applyRequest('del-2', { kind: 'delete-group', groupId: 'g1' })
    const state = h.ledger.state()
    expect(state.groups).toHaveLength(0)
    expect(state.tasks.find(task => task.id === 'a')!.groupId).toBeUndefined()
    h.service.dispose()
  })

  it('accepts a prefix group-order and rejects non-members or duplicates', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([]), () => now)
    seedGroup(h, 'g1', 'Order', ['a', 'b'])
    // A prefix is fine: unlisted members are appended.
    h.ledger.applyRequest('prefix', { kind: 'set-group-order', groupId: 'g1', order: ['b'] })
    expect(h.ledger.state().groups[0]!.order).toEqual(['b', 'a'])
    expect(() => h.ledger.applyRequest('bad', { kind: 'set-group-order', groupId: 'g1', order: ['a', 'a'] })).toThrow('order does not match group members')
    expect(() => h.ledger.applyRequest('bad2', { kind: 'set-group-order', groupId: 'g1', order: ['unknown'] })).toThrow('order does not match group members')
    h.ledger.applyRequest('good', { kind: 'set-group-order', groupId: 'g1', order: ['b', 'a'] })
    expect(h.ledger.state().groups[0]!.order).toEqual(['b', 'a'])
    h.service.dispose()
  })

  it('expires a window-queued run after the max-wait window', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig(
      [endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })],
      { endpointMaxWaitHours: 2 },
    ), () => now)
    seedGroup(h, 'g1', 'Window', ['a'], { allowedHours: { start: '12:00', end: '14:00' } })

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    const queuedAt = h.ledger.state().tasks.find(task => task.id === 'a')!.executions[0]!.queuedAt!

    now = queuedAt + 2 * 3_600_000 + 1
    await h.routeQueued()
    await flush()
    const settled = h.ledger.state().tasks.find(task => task.id === 'a')!.executions[0]!
    expect(settled.result).toBe('failed')
    expect(settled.error).toContain('never became eligible to launch within the max-wait window')
    expect(h.create).not.toHaveBeenCalled()
    h.service.dispose()
  })

  it('a stopped group launches nothing: cancels members, blocks runs, and skips auto-advance until resumed', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Stop', ['a', 'b'])

    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    const aExec = a.executions[0]!.id

    // Stop the group: A is cancelled (failed), the group is marked stopped,
    // and B must not auto-start.
    h.service.apply('stop-group', { kind: 'stop-group', groupId: 'g1' })
    await flush()
    const afterStop = h.ledger.state()
    expect(afterStop.tasks.find(task => task.id === 'a')!.executions[0]!.result).toBe('cancelled')
    expect(afterStop.tasks.find(task => task.id === 'a')!.status).toBe('failed')
    expect(afterStop.groups[0]!.stopped).toBe(true)
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(1)
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    // Manual runs of a stopped-group member are refused; resume re-enables.
    expect(() => h.ledger.applyRequest('run-b', { kind: 'run', taskId: 'b' })).toThrow('group is stopped')
    h.service.apply('resume', { kind: 'update-group', groupId: 'g1', patch: { stopped: false } })
    // Resume lets the sequence advance: A is settled (failed), so B auto-starts.
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')
    h.service.dispose()
  })

  it('moves a whole group to a manual column through the service', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([]), () => now)
    seedGroup(h, 'g1', 'Move', ['a', 'b'])

    h.service.apply('move-group', { kind: 'move-group', groupId: 'g1', status: 'backlog' })
    const state = h.ledger.state()
    expect(state.tasks.find(task => task.id === 'a')!.status).toBe('backlog')
    expect(state.tasks.find(task => task.id === 'b')!.status).toBe('backlog')
    h.service.dispose()
  })

  it('moving a completed group back to a manual column never auto-starts it; an explicit Start-group does', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'Rerun', ['a', 'b'])

    // Complete one full sequential cycle: a runs, settles, then b runs and settles.
    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    const a1 = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a1.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')
    const b1 = h.ledger.state().tasks.find(task => task.id === 'b')!
    h.ledger.settle('b', b1.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    const launchesBefore = h.create.mock.calls.length
    expect(launchesBefore).toBe(2)

    // Drag the completed group back to To Do: every member lands in To Do held
    // (deferAutoStart), so the move itself — and any advance pass afterwards —
    // starts nothing.
    h.service.apply('move-group', { kind: 'move-group', groupId: 'g1', status: 'todo' })
    await flush()
    let state = h.ledger.state()
    expect(state.tasks.find(task => task.id === 'a')!.status).toBe('todo')
    expect(state.tasks.find(task => task.id === 'b')!.status).toBe('todo')
    expect(state.tasks.find(task => task.id === 'a')!.deferAutoStart).toBe(true)
    expect(state.tasks.find(task => task.id === 'b')!.deferAutoStart).toBe(true)
    expect(h.create.mock.calls.length).toBe(launchesBefore)
    h.advanceGroups()
    await flush()
    expect(h.create.mock.calls.length).toBe(launchesBefore)
    expect(h.ledger.state().tasks.find(task => task.id === 'a')!.executions).toHaveLength(1)

    // The banner's ▶ (Start group) is the explicit start: holds clear and the
    // new cycle opens from the top of the group order.
    h.service.apply('run-group', { kind: 'run-group', groupId: 'g1' })
    await flush()
    state = h.ledger.state()
    expect(state.tasks.find(task => task.id === 'a')!.status).toBe('running')
    expect(state.tasks.find(task => task.id === 'a')!.deferAutoStart).toBeUndefined()
    expect(state.tasks.find(task => task.id === 'b')!.deferAutoStart).toBeUndefined()
    expect(h.create.mock.calls.length).toBe(launchesBefore + 1)
    h.service.dispose()
  })

  it('resuming a stopped group releases held members so one ▶ press restarts the whole group', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    seedGroup(h, 'g1', 'StopResume', ['a'])
    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()

    // b joins while the group is running: held, waiting in To Do.
    h.ledger.applyRequest('create-b', { kind: 'create', id: 'b', input: { title: 'B', description: '', prompt: 'work', groupId: 'g1' } })
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.deferAutoStart).toBe(true)

    // Stop the group: a is cancelled (failed), the group is stopped, b stays
    // in To Do held.
    h.service.apply('stop-group', { kind: 'stop-group', groupId: 'g1' })
    await flush()
    expect(h.ledger.state().groups[0]!.stopped).toBe(true)

    // The re-run flow: drag the group back to To Do (all members held).
    h.service.apply('move-group', { kind: 'move-group', groupId: 'g1', status: 'todo' })
    await flush()
    expect(h.create.mock.calls.length).toBe(1)

    // One press on the banner ▶ (Resume): the stopped flag AND every hold
    // clear in the same commit, and the settle-triggered chain that fires on
    // it restarts the sequence — no second press is needed.
    h.service.apply('resume', { kind: 'update-group', groupId: 'g1', patch: { stopped: false } })
    await flush()
    const state = h.ledger.state()
    expect(state.groups[0]!.stopped).toBeUndefined()
    expect(state.tasks.find(task => task.id === 'a')!.deferAutoStart).toBeUndefined()
    expect(state.tasks.find(task => task.id === 'b')!.deferAutoStart).toBeUndefined()
    expect(state.tasks.find(task => task.id === 'a')!.status).toBe('running')
    expect(h.create.mock.calls.length).toBe(2)
    h.service.dispose()
  })

  it('auto-advance and the group cron skip unapproved members until they are approved', async () => {    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const h = harness(dir, routerConfig([endpoint({ id: 'cloud', defaultModel: 'deepseek-chat' })]), () => now)
    h.ledger.applyRequest('group', { kind: 'create-group', id: 'g1', input: { name: 'Approval', mode: 'sequential' } })
    h.ledger.applyRequest('create-a', { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: 'work', groupId: 'g1' } })
    h.ledger.applyRequest('create-b', { kind: 'create', id: 'b', input: { title: 'B', description: '', prompt: 'work', groupId: 'g1', approved: false } })
    h.ledger.applyRequest('create-c', { kind: 'create', id: 'c', input: { title: 'C', description: '', prompt: 'work', groupId: 'g1' } })

    // A runs; when it settles, the sequence skips the unapproved B and starts C.
    h.service.apply('run-a', { kind: 'run', taskId: 'a' })
    await flush()
    expect(h.create).toHaveBeenCalledOnce()
    const a = h.ledger.state().tasks.find(task => task.id === 'a')!
    h.ledger.settle('a', a.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.ledger.state().tasks.find(task => task.id === 'c')!.status).toBe('running')
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.executions).toHaveLength(0)

    // A due group cron likewise skips the unapproved member.
    h.ledger.applyRequest('schedule', { kind: 'update-group', groupId: 'g1', patch: { schedule: { enabled: true, cron: '0 9 * * *' } } })
    h.ledger.settle('c', h.ledger.state().tasks.find(task => task.id === 'c')!.executions[0]!.id, 'succeeded')
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(2)

    // Approving B lets the sequence pick it up next.
    h.ledger.applyRequest('approve', { kind: 'set-approved', taskId: 'b', approved: true })
    h.advanceGroups()
    await flush()
    expect(h.create).toHaveBeenCalledTimes(3)
    expect(h.ledger.state().tasks.find(task => task.id === 'b')!.status).toBe('running')
    h.service.dispose()
  })
})
