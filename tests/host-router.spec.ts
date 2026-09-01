import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EndpointConfig, EndpointRouterConfig } from '../src/core/endpoints.ts'
import { createTask } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { AllTasksHostService } from '../src/host-service.ts'
import { PowerInhibitor } from '../src/power-inhibitor.ts'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-all-tasks-router-'))
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
    ...overrides,
  }
}

function routerConfig(endpoints: readonly EndpointConfig[], overrides: Partial<EndpointRouterConfig> = {}): EndpointRouterConfig {
  return { endpointMaxWaitHours: 24, defaultEndpoints: [], endpoints: [...endpoints], ...overrides }
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
  service: AllTasksHostService
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
  const service = new AllTasksHostService(launchApi(create, selectModel), {
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

describe('AllTasksHostService endpoint routing', () => {
  it('routes through the pinned endpoint and applies its default model', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, create, selectModel } = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: { title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'] },
    })

    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()

    const execution = ledger.state().tasks[0]!.executions[0]!
    expect(execution.queuedAt).toBeUndefined()
    expect(execution.endpointId).toBe('cloud')
    expect(execution.sessionId).toBe('session-x')
    expect(create).toHaveBeenCalledOnce()
    expect(selectModel).toHaveBeenCalledOnce()
    expect(selectModel.mock.calls[0][0].payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    service.dispose()
  })

  it('queues a run when no candidate endpoint can serve the task model', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, create, selectModel } = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-reasoner'] }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'],
        model: { provider: 'deepseek', model: 'deepseek-chat' },
      },
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

  it('falls back to the endpoint default model when the pinned model is not served', async () => {
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

  it('falls back to the next endpoint when the preferred one cannot serve the task', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, selectModel } = harness(dir, routerConfig([
      endpoint({ id: 'local', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'] }),
      endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' }),
    ]), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work', endpoints: ['local', 'cloud'],
        model: { provider: 'deepseek', model: 'deepseek-chat' },
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

  it('fails a queued run that never becomes eligible within the max-wait', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const { service, ledger, create, routeQueued } = harness(dir, routerConfig(
      [endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-reasoner'] })],
      { endpointMaxWaitHours: 2 },
    ), () => now)
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'],
        model: { provider: 'deepseek', model: 'deepseek-chat' },
      },
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
    expect(settled.error).toContain('never became eligible to launch within the max-wait window')
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

  it('keeps a queued run waiting across a Host restart and resumes it when the config can serve it', async () => {
    let now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    // First host: the endpoint cannot serve the pinned model yet.
    const blockedConfig = routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', models: ['deepseek-reasoner'] }),
    ])
    {
      const first = harness(dir, blockedConfig, () => now)
      first.ledger.applyRequest('create', {
        kind: 'create', id: 't1', input: {
          title: 'Task', description: '', prompt: 'work', endpoints: ['cloud'],
          model: { provider: 'deepseek', model: 'deepseek-chat' },
        },
      })
      first.service.apply('run-1', { kind: 'run', taskId: 't1' })
      await flush()
      expect(first.ledger.state().tasks[0]!.executions[0]!.queuedAt).toBeDefined()
      first.service.dispose()
    }
    // A fresh ledger on the same directory must not cancel the queued run.
    now = new Date(2026, 7, 16, 13, 0, 0).getTime()
    const second = harness(dir, routerConfig([
      endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' }),
    ]), () => now)
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

  it('uses the workspace default execution targets when the task sets none', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const ledger = new HostTaskLedger(dir, () => now)
    ledger.applyRequest('set-defaults', {
      kind: 'set-workspace-defaults',
      workspaceId: 'ws-a',
      patch: {
        mode: 'planner',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        endpoints: ['cloud'],
        permission: 'read-only',
      },
    })
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work', workspaceId: 'ws-a',
      },
    })
    const create = vi.fn(async (request) => ok(request, { sessionId: 'session-x' }))
    const selectModel = vi.fn(async (request: { rpcId: unknown; payload?: { model?: unknown } }) => ok(request, {
      selected: { provider: 'deepseek', model: request.payload?.model ?? 'deepseek-chat' },
    }))
    const commands = {
      execute: vi.fn(async (_sessionId: string, line: string) => {
        expect(line).toBe('/permission read-only')
        return { kind: 'success' as const }
      }),
    }
    const api = {
      workspace: { list: async (request: { rpcId: unknown }) => ok(request, { items: [{ workspaceId: 'ws-a' }] }) },
      agentPresets: { list: async (request: { rpcId: unknown }) => ok(request, { presets: [{ id: 'planner', isDefault: false }] }) },
      sessions: {
        create,
        selectModel,
        rename: async (request: { rpcId: unknown }) => ok(request, { title: 'Task', seq: 1 }),
        prompt: async (request: { rpcId: unknown }) => ok(request, { accepted: true }),
      },
    }
    const service = new AllTasksHostService(api as unknown as ApiProxy, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
      commandDispatcher: commands,
      routerConfig: routerConfig([endpoint({ id: 'cloud', provider: 'deepseek', defaultModel: 'deepseek-chat' })]),
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()

    // The workspace defaults filled the blank mode/model/permission and the
    // blank endpoint list routed through the workspace default endpoint.
    expect(create.mock.calls[0][0].payload).toMatchObject({ workspaceId: 'ws-a', agentPreset: 'planner' })
    expect(selectModel).toHaveBeenCalledOnce()
    expect(selectModel.mock.calls[0][0].payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(commands.execute).toHaveBeenCalledOnce()
    const execution = ledger.state().tasks[0]!.executions[0]!
    expect(execution.endpointId).toBe('cloud')
    expect(execution.sessionId).toBe('session-x')
    service.dispose()
  })

  it('prefers the task own execution targets over the workspace defaults', async () => {
    const now = new Date(2026, 7, 16, 10, 0, 0).getTime()
    const dir = root()
    const ledger = new HostTaskLedger(dir, () => now)
    ledger.applyRequest('set-defaults', {
      kind: 'set-workspace-defaults',
      workspaceId: 'ws-a',
      patch: {
        mode: 'planner',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        endpoints: ['cloud'],
        permission: 'read-only',
      },
    })
    ledger.applyRequest('create', {
      kind: 'create', id: 't1', input: {
        title: 'Task', description: '', prompt: 'work', workspaceId: 'ws-a',
        mode: 'coder',
        model: { provider: 'deepseek', model: 'deepseek-reasoner' },
        endpoints: ['local'],
        permission: 'workspace-write',
      },
    })
    const create = vi.fn(async (request) => ok(request, { sessionId: 'session-x' }))
    const selectModel = vi.fn(async (request: { rpcId: unknown; payload?: { model?: unknown } }) => ok(request, {
      selected: { provider: 'deepseek', model: request.payload?.model ?? 'deepseek-reasoner' },
    }))
    const commands = {
      execute: vi.fn(async (_sessionId: string, line: string) => {
        expect(line).toBe('/permission workspace-write')
        return { kind: 'success' as const }
      }),
    }
    const api = {
      workspace: { list: async (request: { rpcId: unknown }) => ok(request, { items: [{ workspaceId: 'ws-a' }] }) },
      agentPresets: { list: async (request: { rpcId: unknown }) => ok(request, { presets: [{ id: 'coder', isDefault: false }] }) },
      sessions: {
        create,
        selectModel,
        rename: async (request: { rpcId: unknown }) => ok(request, { title: 'Task', seq: 1 }),
        prompt: async (request: { rpcId: unknown }) => ok(request, { accepted: true }),
      },
    }
    const service = new AllTasksHostService(api as unknown as ApiProxy, {
      ledger,
      power: new PowerInhibitor({ platform: 'linux' }),
      now: () => now,
      commandDispatcher: commands,
      routerConfig: routerConfig([endpoint({ id: 'local', provider: 'deepseek', defaultModel: 'deepseek-reasoner' })]),
    })
    service.apply('run-1', { kind: 'run', taskId: 't1' })
    await flush()

    // The task's own pins win over the workspace defaults in every field.
    expect(create.mock.calls[0][0].payload).toMatchObject({ workspaceId: 'ws-a', agentPreset: 'coder' })
    expect(selectModel.mock.calls[0][0].payload).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(commands.execute).toHaveBeenCalledOnce()
    const execution = ledger.state().tasks[0]!.executions[0]!
    expect(execution.endpointId).toBe('local')
    expect(execution.sessionId).toBe('session-x')
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
