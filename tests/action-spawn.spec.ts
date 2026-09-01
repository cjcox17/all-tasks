import { describe, expect, it, vi } from 'vitest'
import { createSpawnAction, parseSpawnDirective } from '../src/action-spawn.ts'
import type { ActionContext } from '../src/core/actions.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

describe('parseSpawnDirective', () => {
  it('parses a full directive', () => {
    const d = parseSpawnDirective('{"workspace":"ws-1","title":"Fix","prompt":"do it","autoRun":true}')
    expect(d).toEqual({
      input: { title: 'Fix', description: '', prompt: 'do it', workspaceId: 'ws-1' },
      autoRun: true,
    })
  })

  it('skips a skip directive, non-JSON, and empty summaries', () => {
    expect(parseSpawnDirective('{"skip":true}')).toBeUndefined()
    expect(parseSpawnDirective('no json here')).toBeUndefined()
    expect(parseSpawnDirective(undefined)).toBeUndefined()
    expect(parseSpawnDirective('')).toBeUndefined()
  })

  it('extracts JSON embedded in prose', () => {
    const d = parseSpawnDirective('Done. Result: {"title":"T","prompt":"P"} thanks')
    expect(d?.input.title).toBe('T')
    expect(d?.input.prompt).toBe('P')
    expect(d?.input.workspaceId).toBeUndefined()
  })
})

describe('createSpawnAction', () => {
  it('spawns a task from the summary', () => {
    const spawn = vi.fn(() => 'new-task')
    const task: TaskRecord = createTask({ title: 'T', description: '', prompt: 'p' }, 1, 'task-a')
    const ctx: ActionContext = {
      task,
      execution: { id: 'e', sessionId: 's', startedAt: 2, endedAt: 3, result: 'succeeded', error: undefined, summary: '{"title":"N","prompt":"np","autoRun":true}' },
      sessionId: 's',
      config: {},
      spawn,
    }
    createSpawnAction().run(ctx)
    expect(spawn).toHaveBeenCalledWith({ title: 'N', description: '', prompt: 'np' }, { autoRun: true })
  })

  it('is a no-op without a spawn capability or directive', () => {
    const task: TaskRecord = createTask({ title: 'T', description: '', prompt: 'p' }, 1, 'task-a')
    const ctx: ActionContext = {
      task,
      execution: { id: 'e', sessionId: 's', startedAt: 2, endedAt: 3, result: 'succeeded', error: undefined, summary: 'no directive' },
      sessionId: 's',
      config: {},
    }
    expect(() => createSpawnAction().run(ctx)).not.toThrow()
  })
})
