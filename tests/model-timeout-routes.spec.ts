import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { makeTaskBoardRoutes } from '../src/host-routes.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import type { ModelTimeoutPatch, ModelTimeoutSettingsSeam, ModelTimeoutView } from '../src/model-timeouts.ts'
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

const VIEW: ModelTimeoutView = {
  provider: 'lm-studio',
  displayName: 'LM Studio',
  namespace: 'llm-pi-ai',
  streamIdleTimeoutMs: 900_000,
  timeoutMs: 1_200_000,
}

function sameOriginHeaders(): Record<string, string> {
  return { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
}

describe('model-timeouts HTTP routes', () => {
  let server: Server
  let base: string
  const modelTimeouts = vi.fn(() => [VIEW])
  const applyModelTimeout = vi.fn(async (_patch: ModelTimeoutPatch) => VIEW)

  beforeEach(async () => {
    modelTimeouts.mockClear()
    applyModelTimeout.mockClear()
    const service = {
      snapshot: () => snapshot,
      apply: () => snapshot,
      subscribe: () => () => undefined,
      eventPayload: () => ({ revision: 0, scheduler: snapshot.scheduler, power: snapshot.power }),
      modelTimeouts,
      applyModelTimeout,
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

  it('serves the provider rows to a same-origin GET', async () => {
    const response = await fetch(`${base}/api/task-board/model-timeouts`, { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await response.json()).toEqual({ providers: [VIEW] })
    expect(modelTimeouts).toHaveBeenCalledOnce()
  })

  it('applies one provider patch on POST and returns the updated view', async () => {
    const body = { provider: 'lm-studio', streamIdleTimeoutMs: 900_000, timeoutMs: 1_200_000 }
    const response = await fetch(`${base}/api/task-board/model-timeouts`, {
      method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ provider: VIEW })
    expect(applyModelTimeout).toHaveBeenCalledOnce()
    expect(applyModelTimeout.mock.calls[0][0]).toEqual(body)
  })

  it('rejects writes without the browser same-origin marker', async () => {
    const body = { provider: 'lm-studio', streamIdleTimeoutMs: 900_000 }
    expect((await fetch(`${base}/api/task-board/model-timeouts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).status).toBe(403)
    expect((await fetch(`${base}/api/task-board/model-timeouts`)).status).toBe(403)
    expect(applyModelTimeout).not.toHaveBeenCalled()
  })

  it('rejects malformed patches, non-JSON bodies, and unknown methods', async () => {
    const bad = [
      { provider: '' },
      { provider: 'lm-studio', streamIdleTimeoutMs: 'long' },
      { provider: 'lm-studio', streamIdleTimeoutMs: 0 },
    ]
    for (const body of bad) {
      const response = await fetch(`${base}/api/task-board/model-timeouts`, {
        method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(applyModelTimeout).not.toHaveBeenCalled()
    expect((await fetch(`${base}/api/task-board/model-timeouts`, {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }, body: '{}',
    })).status).toBe(415)
    expect((await fetch(`${base}/api/task-board/model-timeouts`, {
      method: 'PUT', headers: { 'sec-fetch-site': 'same-origin' },
    })).status).toBe(405)
  })

  it('surfaces service failures as 400 responses', async () => {
    applyModelTimeout.mockRejectedValueOnce(new Error('model provider not found: nope'))
    const response = await fetch(`${base}/api/task-board/model-timeouts`, {
      method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify({ provider: 'nope', streamIdleTimeoutMs: 600_000 }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('model provider not found')
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
  const value = mkdtempSync(join(tmpdir(), 'dsh-task-board-timeouts-'))
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

describe('TaskBoardHostService model-timeout write path', () => {
  it('reads effective rows and applies a patch through the settings seam', async () => {
    const settings = fakeSettings({
      'llm-pi-ai': { providers: { 'lm-studio': { displayName: 'LM Studio', streamIdleTimeoutMs: 300_000 } } },
      'llm-deepseek': {},
    })
    const service = serviceWith(settings)

    const before = service.modelTimeouts()
    expect(before.map(view => view.provider).sort()).toEqual(['deepseek-official', 'lm-studio'])
    expect(before.find(view => view.provider === 'lm-studio')).toMatchObject({ streamIdleTimeoutMs: 300_000 })

    const updated = await service.applyModelTimeout({ provider: 'lm-studio', streamIdleTimeoutMs: 900_000, timeoutMs: null })
    expect(updated).toMatchObject({ provider: 'lm-studio', streamIdleTimeoutMs: 900_000 })
    expect(updated.timeoutMs).toBeUndefined()
    expect(settings.applied).toEqual([{
      ns: 'llm-pi-ai',
      ops: [
        { op: 'set', path: ['providers', 'lm-studio', 'streamIdleTimeoutMs'], value: 900_000 },
        { op: 'unset', path: ['providers', 'lm-studio', 'timeoutMs'] },
      ],
    }])
    expect(service.modelTimeouts().find(view => view.provider === 'lm-studio')).toMatchObject({ streamIdleTimeoutMs: 900_000 })
    service.dispose()
  })

  it('writes the deepseek section root and refuses an unknown provider', async () => {
    const settings = fakeSettings({ 'llm-deepseek': {} })
    const service = serviceWith(settings)

    const updated = await service.applyModelTimeout({ provider: 'deepseek-official', streamIdleTimeoutMs: 600_000 })
    expect(updated).toMatchObject({ provider: 'deepseek-official', streamIdleTimeoutMs: 600_000 })
    expect(settings.applied).toEqual([{ ns: 'llm-deepseek', ops: [{ op: 'set', path: ['streamIdleTimeoutMs'], value: 600_000 }] }])

    await expect(service.applyModelTimeout({ provider: 'nope', streamIdleTimeoutMs: 600_000 }))
      .rejects.toThrow(/model provider not found/)
    await expect(service.applyModelTimeout({ provider: 'deepseek-official', streamIdleTimeoutMs: 600_000, timeoutMs: 900_000 }))
      .rejects.toThrow(/only supported for llm-pi-ai/)
    service.dispose()
  })

  it('reports empty rows and refuses writes without a settings seam', async () => {
    const service = serviceWith(undefined)
    expect(service.modelTimeouts()).toEqual([])
    await expect(service.applyModelTimeout({ provider: 'lm-studio', streamIdleTimeoutMs: 600_000 }))
      .rejects.toThrow(/settings service is unavailable/)
    service.dispose()
  })
})
