import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEEPSEEK_OFF_PEAK, type EndpointConfig, type EndpointRouterConfig } from '../src/core/endpoints.ts'
import { createTask } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-router-'))
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
    id: 'deepseek-official',
    name: 'DeepSeek Official',
    provider: 'deepseek',
    models: [],
    maxConcurrency: 1,
    offPeakOnly: false,
    ...overrides,
  }
}

function routerConfig(endpoints: readonly EndpointConfig[], overrides: Partial<EndpointRouterConfig> = {}): EndpointRouterConfig {
  return { offPeak: { ...DEEPSEEK_OFF_PEAK }, endpointMaxWaitHours: 24, defaultEndpoints: [], endpoints: [...endpoints], ...overrides }
}

function launchApi(create: ReturnType<typeof vi.fn>, selectModel?: ReturnType<typeof vi.fn>) {
  return {
    sessions: {
      create,
      ...(selectModel === undefined ? {} : { selectModel }),
      rename: async (request: { rpcId: unknown }) => ok(request, { title: 'Task', seq: 1 }),
      prompt: async (request: { rpcId: unknown }) => ok(request, { accepted: true }),
    },
  } as unknown as ApiProxy
}

interface ServiceHarness {
  service: TaskBoardHostService
  ledger: HostTaskLedger
  create: ReturnType<typeof vi.fn>
  selectModel: ReturnType<typeof vi.fn>
  setNow: (value: number) => void
  routeQueued: () => Promise<void>
}

function harness(dir: string, config: EndpointRouterConfig, now: () => number): ServiceHarness {
  const create = vi.fn(async (request) => ok(request, { sessionId: 'session-x' }))
  const selectModel = vi.fn(async (request: { rpcId: unknown; payload?: { model?: unknown } }) => ok(request, {
    selected: { provider: 'deepseek', model: request.payload?.model ?? 'deepseek-chat' },
  }))
  const ledger = new HostTaskLedger(dir, now)
  const service = new TaskBoardHostService(launchApi(create, selectModel), {
    ledger,
    power: new PowerInhibitor({ platform: 'linux' }),
    now,
    routerConfig: config,
  })
  return {
    service,
    ledger,
    create,
    selectModel,
    setNow: value => { /* no-op; caller owns the mutable clock */ },
    routeQueued: () => (service as unknown as { routeQueued(): Promise<void> }).routeQueued(),
  }
}

describe('TaskBoardHostService endpoint routing', () => {
  it('queues a run when its endpoint is outside allowed hours (no session, nothing billed)', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime() // host-local 10:00
    const dir = root()
    const { service, ledger, create, selectModel } = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', allowedHours: { start: '12:00', end: '14:00' }, defaultModel: 'deepseek-chat' }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: { title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'] },
    })

    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()

    const execution = ledger.state().tasks[0]!.executions[0]!
    expect(execution.queuedAt).toBeDefined()
    expect(execution.endpointId).toBe('cloud')
    expect(execution.sessionId).toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(selectModel).not.toHaveBeenCalled()
    expect(ledger.state().tasks[0]!.status).toBe('running')
    service.dispose()
  })

  it('auto-starts a queued run the moment the window opens', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, create, selectModel, routeQueued } = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', allowedHours: { start: '12:00', end: '14:00' }, defaultModel: 'deepseek-chat' }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: { title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'] },
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()
    expect(ledger.state().tasks[0]!.executions[0]!.queuedAt).toBeDefined()

    now = new Date(2026, 7, 16, 13, 0, 0).getTime()
    await routeQueued()
    await flush()

    const execution = ledger.state().tasks[0]!.executions[0]!
    expect(execution.sessionId).toBe('session-x')
    expect(create).toHaveBeenCalledOnce()
    // The endpoint's default model is applied through session.selectModel.
    expect(selectModel).toHaveBeenCalledOnce()
    expect(selectModel.mock.calls[0][0].payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    service.dispose()
  })

  it('waits when off-peak-only and starts inside the DeepSeek off-peak window', async () => {
    let now = Date.UTC(2026, 6, 16, 12, 0, 0) // 12:00 UTC — peak
    const dir = root()
    const { service, ledger, create, routeQueued } = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', offPeakOnly: true, defaultModel: 'deepseek-chat' }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: { title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'] },
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()
    expect(ledger.state().tasks[0]!.executions[0]!.queuedAt).toBeDefined()
    expect(create).not.toHaveBeenCalled()

    now = Date.UTC(2026, 6, 16, 18, 0, 0) // 18:00 UTC — off-peak
    await routeQueued()
    await flush()
    expect(create).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('falls back to the next endpoint when the preferred one is blocked', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, selectModel } = harness(dir, routerConfig([
      endpoint({ id: 'local', provider: 'lm-studio', allowedHours: { start: '12:00', end: '14:00' }, defaultModel: 'qwen/qwen3.8-27b' }),
      endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work', endpoints: ['local', 'cloud'],
      },
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()

    const execution = ledger.state().tasks[0]!.executions[0]!
    expect(execution.endpointId).toBe('cloud')
    expect(execution.queuedAt).toBeUndefined()
    expect(selectModel.mock.calls[0][0].payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    service.dispose()
  })

  it('queues a second run when the endpoint concurrency is full, then launches after a settle', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, create, routeQueued } = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', maxConcurrency: 1, defaultModel: 'deepseek-chat' }),
    ]), () => now)
    ledger.applyRequest('create-a', {
      kind: 'create', id: 't1', input: { title: 'A', description: '', prompt: 'work', endpoints: ['cloud'] },
    })
    ledger.applyRequest('create-b', {
      kind: 'create', id: 't2', input: { title: 'B', description: '', prompt: 'work', endpoints: ['cloud'] },
    })
    service.apply('run-a', { kind: 'run', taskId: 't1' })
    await flush()
    expect(create).toHaveBeenCalledOnce()

    service.apply('run-b', { kind: 'run', taskId: 't2' })
    await flush()
    const b = ledger.state().tasks.find(task => task.id === 't2')!
    expect(b.executions[0]!.queuedAt).toBeDefined()
    expect(create).toHaveBeenCalledOnce()

    // Settle A: the slot frees and the queued B launches.
    ledger.settle('t1', ledger.state().tasks.find(task => task.id === 't1')!.executions[0]!.id, 'succeeded')
    await routeQueued()
    await flush()
    expect(create).toHaveBeenCalledTimes(2)
    const bAfter = ledger.state().tasks.find(task => task.id === 't2')!
    expect(bAfter.executions[0]!.sessionId).toBe('session-x')
    service.dispose()
  })

  it('fails a queued run that never becomes eligible within the max-wait', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, create, routeQueued } = harness(dir, routerConfig(
      [endpoint({ id: 'cloud', provider: 'deepseek', allowedHours: { start: '12:00', end: '14:00' }, defaultModel: 'deepseek-chat' })],
      { endpointMaxWaitHours: 2 },
    ), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: { title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'] },
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()
    const queuedAt = ledger.state().tasks[0]!.executions[0]!.queuedAt!
    expect(queuedAt).toBeDefined()

    now = queuedAt + 2 * 3_600_000 + 1
    await routeQueued()
    await flush()
    const settled = ledger.state().tasks[0]!.executions[0]!
    expect(settled.result).toBe('failed')
    expect(settled.endedAt).toBeDefined()
    expect(settled.error).toContain('endpoint never became eligible')
    expect(create).not.toHaveBeenCalled()
    service.dispose()
  })

  it('routes through the global default endpoints when the task pins none', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, selectModel } = harness(dir, routerConfig(
      [endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' })],
      { defaultEndpoints: ['cloud'] },
    ), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: { title: 'Task', description: '', prompt: 'work' },
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()
    expect(ledger.state().tasks[0]!.executions[0]!.endpointId).toBe('cloud')
    expect(selectModel).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('keeps a queued run waiting across a Host restart and resumes it', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const config = routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', allowedHours: { start: '12:00', end: '14:00' }, defaultModel: 'deepseek-chat' }),
    ])
    {
      const first = harness(dir, config, () => now)
      first.ledger.applyRequest('create', {
        kind: 'create', id: 't1', input: { title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'] },
      })
      first.service.apply('run-1', { kind: 'run', taskId: 't1' })
      await flush()
      expect(first.ledger.state().tasks[0]!.executions[0]!.queuedAt).toBeDefined()
      first.service.dispose()
    }
    // A fresh ledger on the same directory must not cancel the queued run.
    now = new Date(2026, 7, 16, 13, 0, 0).getTime()
    const second = harness(dir, config, () => now)
    const before = second.ledger.state().tasks[0]!.executions[0]!
    expect(before.result).toBeUndefined()
    expect(before.queuedAt).toBeDefined()
    expect(before.sessionId).toBeUndefined()
    expect(second.ledger.state().tasks[0]!.status).toBe('running')

    await second.routeQueued()
    await flush()
    const after = second.ledger.state().tasks[0]!.executions[0]!
    expect(after.sessionId).toBe('session-x')
    expect(second.create).toHaveBeenCalledOnce()
    second.service.dispose()
  })

  it('does not route (direct model pin) when no endpoints are configured', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, selectModel } = harness(dir, routerConfig([]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
      },
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()
    const execution = ledger.state().tasks[0]!.executions[0]!
    expect(execution.endpointId).toBeUndefined()
    expect(execution.queuedAt).toBeUndefined()
    expect(selectModel).toHaveBeenCalledOnce()
    expect(selectModel.mock.calls[0][0].payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    service.dispose()
  })
})

describe('endpoint router with a pinned model the endpoint cannot serve', () => {
  it('falls back to the endpoint default model', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, selectModel } = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-reasoner'], defaultModel: 'deepseek-reasoner' }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        endpoints: ['cloud'],
      },
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()
    expect(selectModel.mock.calls[0][0].payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
    service.dispose()
  })
})

describe('ledger queued-run bookkeeping', () => {
  it('markQueued / attachEndpoint / queuedRuns round-trip', () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const ledger = new HostTaskLedger(root(), () => now)
    const base = createTask({ title: 'Task', description: '', prompt: 'work' }, now, 't1')
    ledger.applyRequest('create', { kind: 'create', id: 't1', input: base })

    // Reuse the ledger's own open path: start an execution, then queue it.
    ledger.applyRequest('run-1', { kind: 'run', taskId: 't1' })
    const opened = ledger.state().tasks[0]!.executions[0]!
    ledger.markQueued('t1', opened.id, 'cloud', now)
    expect(ledger.queuedRuns()).toHaveLength(1)
    expect(ledger.queuedRuns()[0]).toMatchObject({ taskId: 't1', executionId: opened.id, queuedAt: now })

    ledger.attachEndpoint('t1', opened.id, 'cloud-2')
    expect(ledger.state().tasks[0]!.executions[0]!.endpointId).toBe('cloud-2')

    ledger.settle('t1', opened.id, 'failed', 'boom')
    expect(ledger.queuedRuns()).toHaveLength(0)
  })
})
