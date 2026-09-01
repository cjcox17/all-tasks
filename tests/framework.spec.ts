import { describe, expect, it, vi } from 'vitest'
import { ActionDispatcher } from '../src/action-dispatcher.ts'
import { ActionRegistry, type Action } from '../src/core/actions.ts'
import { EventSourceRegistry, type EventSource } from '../src/core/events.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { SettlementEvent } from '../src/host-ledger.ts'

function eventSource(id: string, path = `/api/all-tasks/events/${id}`): EventSource {
  return {
    id,
    method: 'POST',
    path,
    verify: () => true,
    map: () => ({ input: { title: id, description: '', prompt: id }, autoRun: false }),
  }
}

describe('EventSourceRegistry', () => {
  it('registers, lists, and looks up sources', () => {
    const registry = new EventSourceRegistry()
    registry.register(eventSource('github'))
    registry.register(eventSource('http'))
    expect(registry.get('github')?.id).toBe('github')
    expect(registry.all().map(source => source.id)).toEqual(['github', 'http'])
  })

  it('rejects duplicate ids and duplicate routes', () => {
    const registry = new EventSourceRegistry()
    registry.register(eventSource('github'))
    expect(() => registry.register(eventSource('github'))).toThrow('already registered')
    expect(() => registry.register(eventSource('other', '/api/all-tasks/events/github'))).toThrow('already registered')
  })
})

describe('ActionRegistry', () => {
  it('registers and rejects duplicates', () => {
    const registry = new ActionRegistry()
    const action: Action = { id: 'http', when: ['always'], run: () => {} }
    registry.register(action)
    expect(registry.get('http')).toBe(action)
    expect(registry.all()).toEqual([action])
    expect(() => registry.register(action)).toThrow('already registered')
  })
})

describe('ActionDispatcher', () => {
  function settledTask(): TaskRecord {
    return {
      ...createTask({ title: 'T', description: '', prompt: 'p' }, 1, 'task-a'),
      executions: [{ id: 'exec-1', sessionId: 's-1', startedAt: 2, endedAt: 3, result: 'succeeded', error: undefined }],
    }
  }

  it('runs matching, configured actions and isolates per-action errors', async () => {
    const ledger = { onSettled: vi.fn(() => () => {}), taskById: vi.fn(() => settledTask()) }
    const ran: string[] = []
    const registry = new ActionRegistry()
    registry.register({ id: 'only-success', when: ['succeeded'], run: async () => { ran.push('only-success') } })
    registry.register({ id: 'only-failure', when: ['failed'], run: async () => { ran.push('only-failure') } })
    registry.register({ id: 'always', when: ['always'], run: async () => { ran.push('always') } })
    registry.register({ id: 'disabled', when: ['always'], run: async () => { ran.push('disabled') } })
    registry.register({ id: 'throws', when: ['always'], run: async () => { ran.push('throws'); throw new Error('boom') } })

    const dispatcher = new ActionDispatcher(ledger as never, registry, {
      get: (id: string) => (id === 'disabled' ? undefined : { url: `http://x/${id}` }),
    })
    await dispatcher.dispatch({ taskId: 'task-a', executionId: 'exec-1', outcome: 'succeeded' })

    expect(ran).toEqual(['only-success', 'always', 'throws'])
    expect(ledger.taskById).toHaveBeenCalledWith('task-a')
  })

  it('skips when the task or execution is gone', async () => {
    const registry = new ActionRegistry()
    const run = vi.fn()
    registry.register({ id: 'a', when: ['always'], run })
    const dispatcher = new ActionDispatcher(
      { onSettled: () => () => {}, taskById: () => undefined } as never,
      registry,
      { get: () => ({}) },
    )
    await dispatcher.dispatch({ taskId: 'nope', executionId: 'exec-1', outcome: 'succeeded' } as SettlementEvent)
    expect(run).not.toHaveBeenCalled()
  })

  it('start wires onSettled and stop unwires', () => {
    const ledger = { onSettled: vi.fn(() => () => {}), taskById: vi.fn(() => settledTask()) }
    const dispatcher = new ActionDispatcher(ledger as never, new ActionRegistry(), { get: () => ({}) })
    dispatcher.start()
    expect(ledger.onSettled).toHaveBeenCalledOnce()
    dispatcher.stop()
    dispatcher.stop() // idempotent
  })
})
