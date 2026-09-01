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

describe('endpoint pin gate', () => {
  it('accepts an endpoint list on create and normalizes it', () => {
    const parsed = parseActionEnvelope({
      requestId: 'create-endpoints',
      action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', endpoints: [' cloud ', 'local'] } },
    })
    expect(parsed?.action.kind).toBe('create')
    if (parsed?.action.kind !== 'create') throw new Error('expected create')
    expect(parsed.action.input.endpoints).toEqual(['cloud', 'local'])
  })

  it('rejects non-array endpoint pins on create', () => {
    for (const bad of ['cloud', 5, { id: 'cloud' }]) {
      expect(parseActionEnvelope({
        requestId: 'create-endpoints-bad',
        action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', endpoints: bad } },
      })).toBeUndefined()
    }
  })

  it('normalizes malformed arrays on create to no pin (never stores them)', () => {
    for (const bad of [['', '  '], [5], ['x'.repeat(300)]]) {
      const parsed = parseActionEnvelope({
        requestId: 'create-endpoints-clean',
        action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', endpoints: bad } },
      })
      expect(parsed?.action.kind).toBe('create')
      if (parsed?.action.kind !== 'create') throw new Error('expected create')
      expect(parsed.action.input.endpoints).toBeUndefined()
    }
  })

  it('accepts setting and clearing the endpoint pin on update', () => {
    const set = parseActionEnvelope({
      requestId: 'update-endpoints',
      action: { kind: 'update', taskId: 'task-a', patch: { endpoints: ['cloud'] } },
    })
    expect(set?.action.kind).toBe('update')
    if (set?.action.kind !== 'update') throw new Error('expected update')
    expect(set.action.patch.endpoints).toEqual(['cloud'])

    const cleared = parseActionEnvelope({
      requestId: 'clear-endpoints',
      action: { kind: 'update', taskId: 'task-a', patch: { endpoints: null } },
    })
    expect(cleared?.action.kind).toBe('update')
    if (cleared?.action.kind !== 'update') throw new Error('expected update')
    expect(cleared.action.patch.endpoints).toBeNull()

    const empty = parseActionEnvelope({
      requestId: 'empty-endpoints',
      action: { kind: 'update', taskId: 'task-a', patch: { endpoints: [] } },
    })
    expect(empty?.action.kind).toBe('update')
    if (empty?.action.kind !== 'update') throw new Error('expected update')
    // An empty array normalizes to an explicit clear (the key is present).
    expect('endpoints' in empty.action.patch).toBe(true)
    expect(empty.action.patch.endpoints).toBeUndefined()

    expect(parseActionEnvelope({
      requestId: 'update-endpoints-bad',
      action: { kind: 'update', taskId: 'task-a', patch: { endpoints: 'cloud' } },
    })).toBeUndefined()
  })

  it('carries an endpoint pin through import', () => {
    const task = createTask({ title: 'A', description: '', prompt: '', endpoints: ['cloud'] }, 1, 'task-a')
    const parsed = parseActionEnvelope({ requestId: 'import-endpoints', action: { kind: 'import', sourceId: 'browser', tasks: [task] } })
    expect(parsed?.action.kind).toBe('import')
    if (parsed?.action.kind !== 'import') throw new Error('expected import')
    expect(parsed.action.tasks[0]?.endpoints).toEqual(['cloud'])
  })
})

describe('group action gate', () => {
  it('accepts a group create and normalizes its optional fields', () => {
    const parsed = parseActionEnvelope({
      requestId: 'create-group',
      action: {
        kind: 'create-group', id: 'g1',
        input: { name: ' Nightly ', mode: 'parallel', maxParallel: 2, endpoints: [' cloud ', 'local'], allowedHours: { start: '22:00', end: '06:00' }, offPeakOnly: true, schedule: { enabled: true, cron: '0 2 * * *' } },
      },
    })
    expect(parsed?.action.kind).toBe('create-group')
    if (parsed?.action.kind !== 'create-group') throw new Error('expected create-group')
    expect(parsed.action.input).toMatchObject({
      name: ' Nightly ', mode: 'parallel', maxParallel: 2, endpoints: ['cloud', 'local'],
      allowedHours: { start: '22:00', end: '06:00' }, offPeakOnly: true, schedule: { enabled: true, cron: '0 2 * * *' },
    })
  })

  it('rejects malformed group creates', () => {
    const cases: unknown[] = [
      { kind: 'create-group', id: 'g1', input: { name: '   ' } },
      { kind: 'create-group', id: 'g1', input: { name: 'A', mode: 'sideways' } },
      { kind: 'create-group', id: 'g1', input: { name: 'A', maxParallel: 0 } },
      { kind: 'create-group', id: 'g1', input: { name: 'A', endpoints: 'cloud' } },
      { kind: 'create-group', id: 'g1', input: { name: 'A', allowedHours: { start: '99:99', end: '00:00' } } },
      { kind: 'create-group', id: 'g1', input: { name: 'A', offPeakOnly: 'yes' } },
      { kind: 'create-group', id: 'g1', input: { name: 'A', schedule: { enabled: 'yes', cron: '0 9 * * *' } } },
      { kind: 'create-group', id: 'g1', input: { name: 'A', extra: 1 } },
      { kind: 'create-group', id: 'g1' },
    ]
    for (const action of cases) {
      expect(parseActionEnvelope({ requestId: 'create-group-bad', action })).toBeUndefined()
    }
  })

  it('accepts a group update patch and clears fields with null', () => {
    const parsed = parseActionEnvelope({
      requestId: 'update-group',
      action: { kind: 'update-group', groupId: 'g1', patch: { name: 'Renamed', maxParallel: null, endpoints: null, allowedHours: null, schedule: null, offPeakOnly: false } },
    })
    expect(parsed?.action.kind).toBe('update-group')
    if (parsed?.action.kind !== 'update-group') throw new Error('expected update-group')
    expect(parsed.action.patch.maxParallel).toBeNull()
    expect(parsed.action.patch.schedule).toBeNull()
  })

  it('rejects malformed group update patches', () => {
    for (const patch of [
      { name: '' },
      { mode: 'nope' },
      { maxParallel: 'three' },
      { endpoints: 5 },
      { allowedHours: { start: '24:00', end: '00:00' } },
      { schedule: { enabled: 'yes', cron: '0 9 * * *' } },
      { unknown: 1 },
    ]) {
      expect(parseActionEnvelope({ requestId: 'update-group-bad', action: { kind: 'update-group', groupId: 'g1', patch } })).toBeUndefined()
    }
  })

  it('gates delete-group and set-group-order', () => {
    expect(parseActionEnvelope({ requestId: 'del', action: { kind: 'delete-group', groupId: 'g1' } })).toMatchObject({ action: { kind: 'delete-group', groupId: 'g1' } })
    expect(parseActionEnvelope({ requestId: 'del', action: { kind: 'delete-group' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'order', action: { kind: 'set-group-order', groupId: 'g1', order: ['a', 'b'] } })).toMatchObject({ action: { kind: 'set-group-order', order: ['a', 'b'] } })
    expect(parseActionEnvelope({ requestId: 'order', action: { kind: 'set-group-order', groupId: 'g1', order: 'a' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'order', action: { kind: 'set-group-order', groupId: 'g1', order: ['a', 5] } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'order', action: { kind: 'set-group-order', groupId: 'g1', order: Array.from({ length: 513 }, (_, i) => `t${i}`) } })).toBeUndefined()
  })

  it('gates stop, stop-group, run-group, and move-group', () => {
    expect(parseActionEnvelope({ requestId: 'stop', action: { kind: 'stop', taskId: 't1' } })).toMatchObject({ action: { kind: 'stop', taskId: 't1' } })
    expect(parseActionEnvelope({ requestId: 'stop-bad', action: { kind: 'stop' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'stop-group', action: { kind: 'stop-group', groupId: 'g1' } })).toMatchObject({ action: { kind: 'stop-group', groupId: 'g1' } })
    expect(parseActionEnvelope({ requestId: 'stop-group-bad', action: { kind: 'stop-group' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'run-group', action: { kind: 'run-group', groupId: 'g1' } })).toMatchObject({ action: { kind: 'run-group', groupId: 'g1' } })
    expect(parseActionEnvelope({ requestId: 'run-group-bad', action: { kind: 'run-group' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'run-group-bad2', action: { kind: 'run-group', groupId: '' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'move-group', action: { kind: 'move-group', groupId: 'g1', status: 'todo' } })).toMatchObject({ action: { kind: 'move-group', groupId: 'g1', status: 'todo' } })
    expect(parseActionEnvelope({ requestId: 'move-group-bad', action: { kind: 'move-group', groupId: 'g1', status: 'nope' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'move-group-bad2', action: { kind: 'move-group', groupId: 'g1' } })).toBeUndefined()
  })

  it('gates set-approved and the create approved flag', () => {
    expect(parseActionEnvelope({ requestId: 'approve', action: { kind: 'set-approved', taskId: 't1', approved: true } })).toMatchObject({ action: { kind: 'set-approved', taskId: 't1', approved: true } })
    expect(parseActionEnvelope({ requestId: 'unapprove', action: { kind: 'set-approved', taskId: 't1', approved: false } })).toMatchObject({ action: { kind: 'set-approved', taskId: 't1', approved: false } })
    expect(parseActionEnvelope({ requestId: 'approve-bad', action: { kind: 'set-approved', taskId: 't1', approved: 'yes' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'approve-bad2', action: { kind: 'set-approved', taskId: 't1' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'approve-bad3', action: { kind: 'set-approved', approved: true } })).toBeUndefined()
    const unapproved = parseActionEnvelope({
      requestId: 'create-unapproved',
      action: { kind: 'create', id: 'task-u', input: { title: 'U', description: '', prompt: '', approved: false } },
    })
    expect(unapproved?.action.kind).toBe('create')
    if (unapproved?.action.kind !== 'create') throw new Error('expected create')
    expect(unapproved.action.input.approved).toBe(false)
    expect(parseActionEnvelope({
      requestId: 'create-unapproved-bad',
      action: { kind: 'create', id: 'task-u', input: { title: 'U', description: '', prompt: '', approved: 'yes' } },
    })).toBeUndefined()
  })

  it('carries the unapproved state through import', () => {
    const task = createTask({ title: 'U', description: '', prompt: '', approved: false }, 1, 'task-u')
    const parsed = parseActionEnvelope({ requestId: 'import-approval', action: { kind: 'import', sourceId: 'browser', tasks: [task] } })
    expect(parsed?.action.kind).toBe('import')
    if (parsed?.action.kind !== 'import') throw new Error('expected import')
    expect(parsed.action.tasks[0]?.approved).toBe(false)
  })

  it('gates set-workspace-defaults: bounded workspace id and normalized patch', () => {
    const set = parseActionEnvelope({
      requestId: 'ws-defaults',
      action: { kind: 'set-workspace-defaults', workspaceId: 'ws-a', patch: { mode: ' planner ', approved: false } },
    })
    expect(set?.action.kind).toBe('set-workspace-defaults')
    if (set?.action.kind !== 'set-workspace-defaults') throw new Error('expected set-workspace-defaults')
    expect(set.action.workspaceId).toBe('ws-a')
    expect(set.action.patch).toEqual({ mode: 'planner', approved: false })

    // Nulls clear fields and are accepted (the editor sends the full state).
    const clear = parseActionEnvelope({
      requestId: 'ws-defaults-clear',
      action: { kind: 'set-workspace-defaults', workspaceId: 'ws-a', patch: { mode: null, model: null, endpoints: null, permission: null, approved: null } },
    })
    expect(clear?.action.kind).toBe('set-workspace-defaults')

    // Rejections: blank/oversized workspace id, empty or malformed patches.
    expect(parseActionEnvelope({ requestId: 'ws-bad', action: { kind: 'set-workspace-defaults', workspaceId: ' ', patch: { mode: 'x' } } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'ws-bad2', action: { kind: 'set-workspace-defaults', workspaceId: 'ws-a', patch: {} } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'ws-bad3', action: { kind: 'set-workspace-defaults', workspaceId: 'ws-a', patch: { mode: 5 } } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'ws-bad4', action: { kind: 'set-workspace-defaults', workspaceId: 'ws-a', patch: { permission: 'sudo' } } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'ws-bad5', action: { kind: 'set-workspace-defaults', workspaceId: 'ws-a', patch: { approved: 'yes' } } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'ws-bad6', action: { kind: 'set-workspace-defaults', workspaceId: 'ws-a' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'ws-bad7', action: { kind: 'set-workspace-defaults', patch: { mode: 'x' } } })).toBeUndefined()
  })

  it('accepts the stopped flag on a group update patch', () => {
    const stop = parseActionEnvelope({ requestId: 'stop-g', action: { kind: 'update-group', groupId: 'g1', patch: { stopped: true } } })
    expect(stop?.action.kind).toBe('update-group')
    if (stop?.action.kind !== 'update-group') throw new Error('expected update-group')
    expect(stop.action.patch.stopped).toBe(true)
    expect(parseActionEnvelope({ requestId: 'stop-g-bad', action: { kind: 'update-group', groupId: 'g1', patch: { stopped: 'yes' } } })).toBeUndefined()
  })

  it('accepts and normalizes a groupId on create', () => {
    const parsed = parseActionEnvelope({
      requestId: 'create-grouped',
      action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', groupId: ' g1 ' } },
    })
    expect(parsed?.action.kind).toBe('create')
    if (parsed?.action.kind !== 'create') throw new Error('expected create')
    expect(parsed.action.input.groupId).toBe('g1')
    expect(parseActionEnvelope({
      requestId: 'create-grouped-bad',
      action: { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', groupId: 5 } },
    })).toBeUndefined()
  })

  it('accepts setting and clearing the groupId on update', () => {
    const set = parseActionEnvelope({ requestId: 'set-group', action: { kind: 'update', taskId: 'task-a', patch: { groupId: 'g1' } } })
    expect(set?.action.kind).toBe('update')
    if (set?.action.kind !== 'update') throw new Error('expected update')
    expect(set.action.patch.groupId).toBe('g1')
    const cleared = parseActionEnvelope({ requestId: 'clear-group', action: { kind: 'update', taskId: 'task-a', patch: { groupId: null } } })
    expect(cleared?.action.kind).toBe('update')
    if (cleared?.action.kind !== 'update') throw new Error('expected update')
    expect(cleared.action.patch.groupId).toBeNull()
    expect(parseActionEnvelope({ requestId: 'set-group-bad', action: { kind: 'update', taskId: 'task-a', patch: { groupId: 5 } } })).toBeUndefined()
  })
})

describe('reorder action gate', () => {
  it('accepts a reorder with a bounded target task id', () => {
    const parsed = parseActionEnvelope({
      requestId: 'reorder-a',
      action: { kind: 'reorder', taskId: 'task-a', beforeTaskId: 'task-b' },
    })
    expect(parsed?.action).toEqual({ kind: 'reorder', taskId: 'task-a', beforeTaskId: 'task-b' })
  })

  it('accepts a reorder to the end of the array (null target)', () => {
    const parsed = parseActionEnvelope({
      requestId: 'reorder-b',
      action: { kind: 'reorder', taskId: 'task-a', beforeTaskId: null },
    })
    expect(parsed?.action).toEqual({ kind: 'reorder', taskId: 'task-a', beforeTaskId: null })
  })

  it('rejects reorders with missing, extra, or malformed fields', () => {
    expect(parseActionEnvelope({ requestId: 'r1', action: { kind: 'reorder', taskId: 'task-a' } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r2', action: { kind: 'reorder', taskId: '', beforeTaskId: null } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r3', action: { kind: 'reorder', taskId: 'task-a', beforeTaskId: 5 } })).toBeUndefined()
    expect(parseActionEnvelope({ requestId: 'r4', action: { kind: 'reorder', taskId: 'task-a', beforeTaskId: 'task-b', extra: 1 } })).toBeUndefined()
  })
})
