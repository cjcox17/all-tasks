import { describe, expect, it } from 'vitest'
import { createTask } from '../src/core/tasks.ts'
import { parseActionEnvelope } from '../src/protocol.ts'

describe('task-board action protocol', () => {
  it('accepts the versioned action union and rejects unknown executable fields', () => {
    expect(parseActionEnvelope({
      requestId: 'request-a',
      action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } },
    })?.action.kind).toBe('create')
    expect(parseActionEnvelope({
      requestId: 'request-b',
      action: { kind: 'update', taskId: 'task-a', patch: { command: 'powercfg /x' } },
    })).toBeUndefined()
    expect(parseActionEnvelope({
      requestId: 'request-c',
      action: { kind: 'set-schedule', taskId: 'task-a', patch: { cron: '* * * * *', nextRunAt: 1 } },
    })).toBeUndefined()
  })

  it('accepts a task-content update patch (host rejects the blank title)', () => {
    expect(parseActionEnvelope({
      requestId: 'content-update',
      action: { kind: 'update', taskId: 'task-a', patch: { title: 'B', description: 'd', prompt: 'p' } },
    })?.action.kind).toBe('update')
    expect(parseActionEnvelope({
      requestId: 'content-update-blank',
      action: { kind: 'update', taskId: 'task-a', patch: { title: '' } },
    })?.action.kind).toBe('update')
  })

  it('accepts benign future import fields but rejects executable command fields', () => {
    const valid = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    expect(parseActionEnvelope({ requestId: 'ok', action: { kind: 'import', sourceId: 'browser', tasks: [valid] } })).toBeDefined()
    expect(parseActionEnvelope({ requestId: 'bad', action: {
      kind: 'import', sourceId: 'browser', tasks: [{ ...valid, shell: 'cmd.exe' }],
    } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'future', action: {
      kind: 'import', sourceId: 'browser', tasks: [{ ...valid, futureDisplayHint: 'compact' }],
    } })?.action.kind).toBe('import')
  })

  it('rejects oversized request ids', () => {
    expect(parseActionEnvelope({
      requestId: 'x'.repeat(257),
      action: { kind: 'delete', taskId: 'task-a' },
    })).toBeUndefined()
  })

  it('rejects malformed schedule fields during legacy import', () => {
    const task = createTask({ title: 'legacy', description: '', prompt: '' }, 1, 'legacy')
    expect(parseActionEnvelope({
      requestId: 'import-a',
      action: { kind: 'import', sourceId: 'browser-a', tasks: [{ ...task, schedule: { enabled: true, cron: ['* * * * *'] } }] },
    })).toBeUndefined()
    expect(parseActionEnvelope({
      requestId: 'import-b',
      action: { kind: 'import', sourceId: 'browser-a', tasks: [{ ...task, schedule: { enabled: true, cron: '* * * * *', nextRunAt: Number.NaN } }] },
    })).toBeUndefined()
  })
})

describe('model selection gate', () => {
  const model = { provider: 'deepseek', model: 'deepseek-chat' }

  it('accepts a model selection on create and normalizes it', () => {
    const parsed = parseActionEnvelope({
      requestId: 'create-model',
      action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', model: { provider: ' deepseek ', model: 'deepseek-chat' } } },
    })
    expect(parsed?.action.kind).toBe('create')
    if (parsed?.action.kind !== 'create') throw new Error('expected create')
    expect(parsed.action.input.model).toEqual(model)
  })

  it('rejects malformed model selections on create', () => {
    for (const bad of [
      'deepseek',
      { provider: '', model: 'deepseek-chat' },
      { provider: 'deepseek' },
      { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 5 },
      { provider: 'deepseek', model: 'deepseek-chat', extra: 'x' },
    ]) {
      expect(parseActionEnvelope({
        requestId: 'create-model-bad',
        action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', model: bad } },
      })).toBeUndefined()
    }
  })

  it('accepts setting and clearing the model pin on update', () => {
    const set = parseActionEnvelope({
      requestId: 'update-model',
      action: { kind: 'update', taskId: 'task-a', patch: { model } },
    })
    expect(set?.action.kind).toBe('update')
    if (set?.action.kind !== 'update') throw new Error('expected update')
    expect(set.action.patch.model).toEqual(model)

    const cleared = parseActionEnvelope({
      requestId: 'clear-model',
      action: { kind: 'update', taskId: 'task-a', patch: { model: null } },
    })
    expect(cleared?.action.kind).toBe('update')
    if (cleared?.action.kind !== 'update') throw new Error('expected update')
    expect(cleared.action.patch.model).toBeNull()

    expect(parseActionEnvelope({
      requestId: 'update-model-bad',
      action: { kind: 'update', taskId: 'task-a', patch: { model: { provider: 'deepseek' } } },
    })).toBeUndefined()
  })

  it('carries a model pin through import', () => {
    const task = createTask({ title: 'A', description: '', prompt: '', model }, 1, 'task-a')
    const parsed = parseActionEnvelope({ requestId: 'import-model', action: { kind: 'import', sourceId: 'browser', tasks: [task] } })
    expect(parsed?.action.kind).toBe('import')
    if (parsed?.action.kind !== 'import') throw new Error('expected import')
    expect(parsed.action.tasks[0]?.model).toEqual(model)
  })
})
