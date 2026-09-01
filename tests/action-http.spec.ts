import { describe, expect, it, vi } from 'vitest'
import { createHttpAction, type HttpActionConfig } from '../src/action-http.ts'
import type { ActionContext } from '../src/core/actions.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

function context(config: HttpActionConfig): ActionContext {
  const task: TaskRecord = createTask({ title: 'T', description: '', prompt: 'p' }, 1, 'task-a')
  return {
    task,
    execution: { id: 'exec-1', sessionId: 's-1', startedAt: 2, endedAt: 3, result: 'succeeded', error: undefined, summary: 'done' },
    sessionId: 's-1',
    config,
  }
}

function okResponse(): Response {
  return { ok: true, status: 200 } as Response
}

describe('action-http', () => {
  it('POSTs the settlement payload with a bearer token', async () => {
    const fetch = vi.fn(async () => okResponse())
    const action = createHttpAction({ fetchFn: fetch as unknown as typeof fetch, env: { OUT_TOKEN: 'secret' } })
    await action.run(context({ url: 'https://example.com/hook', tokenEnv: 'OUT_TOKEN' }))
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toBe('https://example.com/hook')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer secret')
    expect(JSON.parse(init.body)).toMatchObject({
      taskId: 'task-a',
      executionId: 'exec-1',
      status: 'succeeded',
      summary: 'done',
      sessionId: 's-1',
    })
  })

  it('skips blank URLs and rejects unsafe schemes', async () => {
    const fetch = vi.fn(async () => okResponse())
    const action = createHttpAction({ fetchFn: fetch as unknown as typeof fetch })
    await action.run(context({ url: '' }))
    expect(fetch).not.toHaveBeenCalled()
    await expect(action.run(context({ url: 'ftp://example.com/x' }))).rejects.toThrow('unsafe URL')
  })
})
