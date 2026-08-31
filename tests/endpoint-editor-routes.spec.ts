import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { makeTaskBoardRoutes } from '../src/host-routes.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import type { EndpointEditorState, EndpointEditorView, EndpointProviderInfo } from '../src/endpoint-editor.ts'
import { DEEPSEEK_PROVIDER } from '../src/model-timeouts.ts'
import type { ModelTimeoutSettingsSeam } from '../src/model-timeouts.ts'
import type { TaskBoardSnapshot } from '../src/protocol.ts'

const snapshot: TaskBoardSnapshot = {
  schemaVersion: 2,
  revision: 0,
  tasks: [],
  groups: [],
  scheduler: { timeZone: 'UTC' },
  power: {
    platform: 'linux', phase: 'unsupported', enabled: false,
    runningSessions: 0, armedSchedules: 0, sessionStateKnown: true,
  },
}

const VIEW: EndpointEditorView = {
  id: 'lm-studio-nas',
  name: 'LM Studio (NAS)',
  provider: 'lm-studio',
  models: ['qwen/qwen3.8-27b'],
  defaultModel: 'qwen/qwen3.8-27b',
  idleSeconds: 300,
  totalSeconds: 0,
}

const STATE: EndpointEditorState = { endpoints: [VIEW], defaultEndpoints: ['lm-studio-nas'] }

const PROVIDERS: EndpointProviderInfo[] = [
  { provider: 'lm-studio', displayName: 'LM Studio', namespace: 'llm-pi-ai', models: ['qwen/qwen3.8-27b'], streamIdleTimeoutMs: 300_000 },
]

describe('endpoints HTTP routes', () => {
  let server: Server
  let base: string
  const endpoints = vi.fn(() => STATE)
  const applyEndpoints = vi.fn(async (state: EndpointEditorState) => state)
  const endpointProviders = vi.fn(() => PROVIDERS)

  beforeEach(async () => {
    endpoints.mockClear()
    applyEndpoints.mockClear()
    endpointProviders.mockClear()
    const service = {
      snapshot: () => snapshot,
      apply: () => snapshot,
      subscribe: () => () => undefined,
      eventPayload: () => ({ revision: 0, scheduler: snapshot.scheduler, power: snapshot.power }),
      endpointProviders,
      endpoints,
      applyEndpoints,
    } as unknown as TaskBoardHostService
    const routes = makeTaskBoardRoutes(service)
    server = createServer((req, res) => {
      const route = routes.find(candidate => candidate.path === new URL(req.url ?? '/', 'http://local').pathname)
      if (route === undefined) { res.writeHead(404); res.end(); return }
      void route.handler(req, res)
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
  })

  it('serves the endpoint state plus the provider catalog to a same-origin GET', async () => {
    const response = await fetch(`${base}/api/task-board/endpoints`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ...STATE, providers: PROVIDERS })
    expect(endpoints).toHaveBeenCalledOnce()
    expect(endpointProviders).toHaveBeenCalledOnce()
  })

  it('applies a full replacement on POST and returns the stored state', async () => {
    const body = { endpoints: [VIEW], defaultEndpoints: ['lm-studio-nas'] }
    const response = await fetch(`${base}/api/task-board/endpoints`, {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(STATE)
    expect(applyEndpoints).toHaveBeenCalledOnce()
    expect(applyEndpoints.mock.calls[0][0]).toEqual(STATE)
  })

  it('rejects writes without the browser same-origin marker', async () => {
    expect((await fetch(`${base}/api/task-board/endpoints`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoints: [VIEW] }),
    })).status).toBe(403)
    expect((await fetch(`${base}/api/task-board/endpoints`)).status).toBe(403)
    expect(applyEndpoints).not.toHaveBeenCalled()
  })

  it('rejects malformed patches, non-JSON bodies, and unknown methods', async () => {
    const bad = [
      { endpoints: [{ provider: 'p' }] },
      { endpoints: 'nope' },
      { endpoints: [{ id: 'a', provider: 'p' }], defaultEndpoints: ['missing'] },
    ]
    for (const body of bad) {
      const response = await fetch(`${base}/api/task-board/endpoints`, {
        method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(applyEndpoints).not.toHaveBeenCalled()
    expect((await fetch(`${base}/api/task-board/endpoints`, {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }, body: '{}',
    })).status).toBe(415)
    expect((await fetch(`${base}/api/task-board/endpoints`, {
      method: 'PUT', headers: { 'sec-fetch-site': 'same-origin' },
    })).status).toBe(405)
  })

  it('surfaces service failures as 400 responses', async () => {
    applyEndpoints.mockRejectedValueOnce(new Error('settings service is unavailable'))
    const response = await fetch(`${base}/api/task-board/endpoints`, {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ endpoints: [VIEW] }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('settings service is unavailable')
  })
})

/** A stateful fake of the cordis settings seam with DSH-like mutate semantics. */
function fakeSettings(initial: Record<string, unknown>): ModelTimeoutSettingsSeam & { applied: Array<{ ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }> } {
  const state: Record<string, unknown> = { ...initial }
  const applied: Array<{ ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }> = []
  return {
    get: ns => state[ns],
    mutate: async (ns, ops) => {
      applied.push({ ns, ops })
      const section = (state[ns] ?? {}) as Record<string, unknown>
      for (const op of ops) {
        let cursor: Record<string, unknown> = section
        for (let i = 0; i < op.path.length - 1; i += 1) {
          const key = op.path[i]
          if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {}
          cursor = cursor[key] as Record<string, unknown>
        }
        const last = op.path[op.path.length - 1]
        if (op.op === 'set') cursor[last] = op.value
        else delete cursor[last]
      }
      state[ns] = section
    },
    applied,
  }
}

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-endpoints-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function serviceWith(settings: ModelTimeoutSettingsSeam | undefined): TaskBoardHostService {
  return new TaskBoardHostService({} as unknown as ApiProxy, {
    ledger: new HostTaskLedger(root(), () => 0),
    settings,
  })
}

describe('TaskBoardHostService endpoint write path', () => {
  it('reads the namespace, applies a full replacement, and writes timeouts through to the provider route', async () => {
    const settings = fakeSettings({
      'task-board': { endpoints: [{ id: 'lm-studio-nas', provider: 'lm-studio' }], defaultEndpoints: ['lm-studio-nas'] },
      'llm-pi-ai': { providers: { 'lm-studio': { displayName: 'LM Studio', models: [{ id: 'qwen/qwen3.8-27b' }] } } },
      'llm-deepseek': {},
    })
    const service = serviceWith(settings)

    const before = service.endpoints()
    expect(before.endpoints.map(endpoint => endpoint.id)).toEqual(['lm-studio-nas'])
    expect(before.endpoints[0]).toMatchObject({ idleSeconds: 300, totalSeconds: 0 })
    expect(service.endpointProviders().map(info => info.provider).sort()).toEqual([DEEPSEEK_PROVIDER, 'lm-studio'])
    expect(service.endpointProviders().find(info => info.provider === 'lm-studio')).toMatchObject({
      models: ['qwen/qwen3.8-27b'],
      streamIdleTimeoutMs: 300_000,
    })

    const next: EndpointEditorState = {
      endpoints: [
        { ...VIEW, idleSeconds: 900, totalSeconds: 3600 },
        { id: 'deepseek', name: '', provider: DEEPSEEK_PROVIDER, models: [], defaultModel: '', idleSeconds: 600, totalSeconds: 0 },
      ],
      defaultEndpoints: ['lm-studio-nas', 'deepseek'],
    }
    const stored = await service.applyEndpoints(next)
    expect(stored.endpoints).toHaveLength(2)
    // One task-board write + one per-provider timeout write.
    expect(settings.applied).toHaveLength(3)
    expect(settings.applied[0]?.ns).toBe('task-board')
    expect(settings.applied[0]?.ops[0]).toMatchObject({ op: 'set', path: ['endpoints'] })
    expect(settings.applied[0]?.ops[1]).toEqual({ op: 'set', path: ['defaultEndpoints'], value: ['lm-studio-nas', 'deepseek'] })
    // lm-studio idle + total land in llm-pi-ai.
    expect(settings.applied[1]?.ns).toBe('llm-pi-ai')
    expect(settings.applied[1]?.ops).toContainEqual({ op: 'set', path: ['providers', 'lm-studio', 'streamIdleTimeoutMs'], value: 900_000 })
    expect(settings.applied[1]?.ops).toContainEqual({ op: 'set', path: ['providers', 'lm-studio', 'timeoutMs'], value: 3_600_000 })
    // deepseek idle lands in llm-deepseek (no total).
    expect(settings.applied[2]?.ns).toBe('llm-deepseek')
    expect(settings.applied[2]?.ops).toEqual([{ op: 'set', path: ['streamIdleTimeoutMs'], value: 600_000 }])
    service.dispose()
  })

  it('reports empty state and refuses writes without a settings seam', async () => {
    const service = serviceWith(undefined)
    expect(service.endpoints()).toEqual({ endpoints: [], defaultEndpoints: [] })
    expect(service.endpointProviders()).toEqual([])
    await expect(service.applyEndpoints({ endpoints: [VIEW], defaultEndpoints: [] }))
      .rejects.toThrow(/settings service is unavailable/)
    service.dispose()
  })
})
