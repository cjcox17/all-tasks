import { describe, expect, it, vi } from 'vitest'
import { createGithubAction, type GithubActionConfig } from '../src/action-github.ts'
import type { ActionContext } from '../src/core/actions.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

function context(config: GithubActionConfig): ActionContext {
  const task: TaskRecord = createTask({ title: 'T', description: '', prompt: 'p' }, 1, 'task-a')
  return {
    task,
    execution: { id: 'e', sessionId: 's', startedAt: 2, endedAt: 3, result: 'succeeded', error: undefined, summary: 'fixed' },
    sessionId: 's',
    config,
  }
}

function okResponse(): Response {
  return { ok: true, status: 201 } as Response
}

describe('action-github', () => {
  it('POSTs a comment to the issue', async () => {
    const fetch = vi.fn(async () => okResponse())
    const action = createGithubAction({ fetchFn: fetch as unknown as typeof fetch, env: { GH_TOKEN: 'tok' } })
    await action.run(context({ tokenEnv: 'GH_TOKEN', repo: 'cjcox17/wyx', issueNumber: 42 }))
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.github.com/repos/cjcox17/wyx/issues/42/comments')
    expect(init.headers.authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body).body).toContain('fixed')
  })

  it('requires a token and is a no-op without a target', async () => {
    const fetch = vi.fn(async () => okResponse())
    const noToken = createGithubAction({ fetchFn: fetch as unknown as typeof fetch })
    await expect(noToken.run(context({ repo: 'cjcox17/wyx', issueNumber: 1 }))).rejects.toThrow('token is required')

    const withToken = createGithubAction({ fetchFn: fetch as unknown as typeof fetch, env: { GH_TOKEN: 'tok' } })
    await withToken.run(context({ tokenEnv: 'GH_TOKEN' })) // no repo/issue → returns
    expect(fetch).not.toHaveBeenCalled()
  })

  it('is a silent no-op on the schema-default empty config (no repo configured)', async () => {
    // The settings schema defaults an absent `actions` block to an all-empty
    // config ({ tokenEnv: '', repo: '', apiBase: '', issueNumber: 0 }), so an
    // unconfigured github action runs on every settlement. It must return
    // without fetching and without a "token is required" error — the action
    // simply has no target, exactly like the http action's empty-URL no-op.
    const fetch = vi.fn(async () => okResponse())
    const action = createGithubAction({ fetchFn: fetch as unknown as typeof fetch })
    await expect(action.run(context({ tokenEnv: '', repo: '', apiBase: '', issueNumber: 0 }))).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})
