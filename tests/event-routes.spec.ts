import { createServer, request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventSourceRegistry } from '../src/core/events.ts'
import { createHttpEventSource } from '../src/event-http.ts'
import { makeEventRoutes } from '../src/host-routes.ts'
import type { TaskBoardHostService } from '../src/host-service.ts'

function post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: 'POST', headers }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, text }) })
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

describe('event routes', () => {
  let server: Server
  let base: string
  const apply = vi.fn((_requestId: string, _action: unknown) => ({ revision: 0 }))

  beforeEach(async () => {
    apply.mockClear()
    const registry = new EventSourceRegistry()
    registry.register(createHttpEventSource({ autoRun: false }))
    const service = {
      apply,
      snapshot: () => ({}),
      subscribe: () => () => undefined,
    } as unknown as TaskBoardHostService
    const routes = makeEventRoutes(registry, service)
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

  it('creates a task from a verified loopback event', async () => {
    const result = await post(
      `${base}/api/task-board/events/http`,
      { 'content-type': 'application/json', origin: base },
      JSON.stringify({ event: 'build failed' }),
    )
    expect(result.status).toBe(200)
    const createCall = apply.mock.calls.find(call => (call[1] as { kind?: string }).kind === 'create')
    expect(createCall).toBeDefined()
    const input = (createCall?.[1] as { input: { prompt: string; source: string; approved: boolean } }).input
    expect(input.prompt).toContain('build failed')
    // autoRun is off: the event-created task is event-origin and unapproved.
    expect(input.source).toBe('event')
    expect(input.approved).toBe(false)
  })

  it('rejects a request without the browser same-origin marker', async () => {
    const result = await post(`${base}/api/task-board/events/http`, { 'content-type': 'application/json' }, '{}')
    expect(result.status).toBe(403)
    expect(apply).not.toHaveBeenCalled()
  })
})
