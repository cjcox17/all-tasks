import { createServer, request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActionRegistry } from '../src/core/actions.ts'
import { EventSourceRegistry } from '../src/core/events.ts'
import { makeIntegrationsRoutes } from '../src/host-routes.ts'

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'GET', headers }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, text }) })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

function post(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'POST' }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, text }) })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

describe('integrations status route', () => {
  let server: Server
  let base: string
  let getConfigCalls: number

  beforeEach(async () => {
    getConfigCalls = 0
    const events = new EventSourceRegistry()
    events.register({
      id: 'http',
      method: 'POST',
      path: '/api/all-tasks/events/http',
      verify: () => true,
      map: () => ({ input: { title: 't', description: '', prompt: 'p' }, autoRun: false }),
    })
    events.register({
      id: 'github',
      method: 'POST',
      path: '/api/all-tasks/events/github',
      verify: () => true,
      map: () => ({ input: { title: 't', description: '', prompt: 'p' }, autoRun: false }),
    })
    const actions = new ActionRegistry()
    actions.register({ id: 'http', when: ['always'], run: () => {} })
    actions.register({ id: 'spawn', when: ['succeeded'], run: () => {} })

    const routes = makeIntegrationsRoutes(events, actions, () => {
      getConfigCalls += 1
      return {
        events: { http: { tokenEnv: 'DSH_EVENTS_TOKEN', autoRun: true } },
        actions: { spawn: {} },
      }
    })
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

  it('returns every registered event source and action with their config', async () => {
    const result = await get(`${base}/api/all-tasks/integrations`, { origin: base })
    expect(result.status).toBe(200)
    const snapshot = JSON.parse(result.text) as { events: Array<{ id: string; method: string; path: string; config: Record<string, unknown> }>; actions: Array<{ id: string; when: string[]; config: Record<string, unknown> }> }
    expect(snapshot.events.map(event => event.id)).toEqual(['http', 'github'])
    expect(snapshot.events[0]).toMatchObject({
      id: 'http',
      method: 'POST',
      path: '/api/all-tasks/events/http',
      config: { tokenEnv: 'DSH_EVENTS_TOKEN', autoRun: true },
    })
    // The github source has no config slice.
    expect(snapshot.events[1]!.config).toEqual({})
    expect(snapshot.actions.map(action => action.id)).toEqual(['http', 'spawn'])
    expect(snapshot.actions[0]!.when).toEqual(['always'])
    expect(snapshot.actions[1]!.when).toEqual(['succeeded'])
    expect(getConfigCalls).toBe(1)
  })

  it('reads the config fresh on every request', async () => {
    await get(`${base}/api/all-tasks/integrations`, { origin: base })
    await get(`${base}/api/all-tasks/integrations`, { origin: base })
    expect(getConfigCalls).toBe(2)
  })

  it('rejects a request without the browser same-origin marker', async () => {
    const result = await get(`${base}/api/all-tasks/integrations`)
    expect(result.status).toBe(403)
    expect(JSON.parse(result.text)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('rejects non-GET methods', async () => {
    const result = await post(`${base}/api/all-tasks/integrations`)
    expect(result.status).toBe(405)
  })
})
