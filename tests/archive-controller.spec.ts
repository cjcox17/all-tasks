/**
 * Controller archive behavior: archive only settles settled tasks, restore
 * brings them back, the archive view toggles, and leaving the view with an
 * archived selection closes the selection. Plus the bulk hide of a settled
 * column (hideSettledTasks), legacy and Host-backed.
 */
import { describe, expect, it, vi } from 'vitest'
import { BoardController, type ControllerDeps, type AllTasksTransport } from '../src/core/controller.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { AllTasksAction, AllTasksSnapshot } from '../src/protocol.ts'

const NOW = 1_700_000_000_000
let nextId = 0
const uuid = (): string => { nextId += 1; return 'id-' + nextId }

class FakeSessions {
  current: string | undefined = undefined
  private listeners = new Set<() => void>()
  list = {
    getSnapshot: (): { current: string | undefined } => ({ current: this.current }),
    subscribe: (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } },
  }
  open(id: string): void { this.current = id }
}

function makeController(seed: TaskRecord[] = []) {
  const store = new InMemoryTaskStore()
  store.save(seed)
  const deps: ControllerDeps = {
    store,
    sessions: new FakeSessions() as never,
    now: () => NOW,
    uuid,
  }
  const controller = new BoardController(deps)
  controller.start()
  return { controller, store }
}

function task(id: string, status: TaskRecord['status']): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW, id), status }
}

/** A settled task carrying one execution with the given session id. */
function settledWithSession(id: string, status: 'done' | 'failed', sessionId: string): TaskRecord {
  return {
    ...task(id, status),
    executions: [{
      id: `${id}-e1`, sessionId, startedAt: NOW - 10, endedAt: NOW - 5, result: 'succeeded' as const, error: undefined,
    }],
  }
}

/** Host-like snapshot builder for transport fakes. */
function snapshot(revision: number, tasks: TaskRecord[]): AllTasksSnapshot {
  return {
    schemaVersion: 2,
    revision,
    tasks,
    groups: [],
    workspaceDefaults: {},
    scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' },
    power: {
      platform: 'linux', phase: 'unsupported', enabled: false,
      runningSessions: 0, armedSchedules: 0, sessionStateKnown: true,
    },
  }
}

describe('BoardController archive', () => {
  it('archives done/failed tasks and refuses running ones', () => {
    const done = task('done', 'done')
    const failed = task('failed', 'failed')
    const running = task('running', 'running')
    const { controller, store } = makeController([done, failed, running])
    expect(controller.archiveTask('done')).toBe(true)
    expect(controller.archiveTask('failed')).toBe(true)
    expect(controller.archiveTask('running')).toBe(false)
    const persisted = store.load()
    expect(persisted.find(item => item.id === 'done')?.archivedAt).toBe(NOW)
    expect(persisted.find(item => item.id === 'running')?.archivedAt).toBeUndefined()
  })

  it('restores an archived task back to its column', () => {
    const done = { ...task('done', 'done'), archivedAt: NOW }
    const { controller, store } = makeController([done])
    controller.openTask('done')
    expect(controller.restoreTask('done')).toBe(true)
    expect(store.load()[0]).toMatchObject({ id: 'done', status: 'done' })
    expect(store.load()[0].archivedAt).toBeUndefined()
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined()
    expect(controller.restoreTask('done')).toBe(false)
  })

  it('toggles the archive view and closes an archived selection on exit', () => {
    const done = { ...task('done', 'done'), archivedAt: NOW }
    const { controller } = makeController([done])
    expect(controller.getSnapshot().archiveView).toBe(false)
    controller.openTask('done')
    controller.toggleArchiveView()
    expect(controller.getSnapshot().archiveView).toBe(true)
    expect(controller.getSnapshot().selectedTaskId).toBe('done')
    controller.toggleArchiveView()
    expect(controller.getSnapshot().archiveView).toBe(false)
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined()
  })
})

describe('BoardController hideSettledTasks (legacy in-memory path)', () => {
  it('hides every requested settled task and persists the archive markers', async () => {
    const done = settledWithSession('done', 'done', 'session-1')
    const failed = task('failed', 'failed')
    const running = task('running', 'running')
    const { controller, store } = makeController([done, failed, running])
    expect(await controller.hideSettledTasks(['done', 'failed'], false)).toBe(true)
    const persisted = store.load()
    expect(persisted.find(item => item.id === 'done')?.archivedAt).toBe(NOW)
    expect(persisted.find(item => item.id === 'failed')?.archivedAt).toBe(NOW)
    expect(persisted.find(item => item.id === 'running')?.archivedAt).toBeUndefined()
  })

  it('refuses the whole hide when any requested task is not archivable', async () => {
    const done = task('done', 'done')
    const { controller, store } = makeController([done])
    expect(await controller.hideSettledTasks(['done', 'running'], false)).toBe(false)
    expect(await controller.hideSettledTasks(['ghost'], false)).toBe(false)
    expect(store.load().find(item => item.id === 'done')?.archivedAt).toBeUndefined()
  })

  it('returns true for an empty request without touching the board', async () => {
    const { controller, store } = makeController([task('done', 'done')])
    expect(await controller.hideSettledTasks([], true)).toBe(true)
    expect(store.load()[0].archivedAt).toBeUndefined()
  })
})

describe('BoardController hideSettledTasks (Host-backed)', () => {
  it('sends one hide-tasks action per slice and adopts the confirmed snapshot', async () => {
    const done = settledWithSession('done', 'done', 'session-1')
    const failed = task('failed', 'failed')
    const actions: AllTasksAction[] = []
    const archivedDone = { ...done, archivedAt: NOW }
    const archivedFailed = { ...failed, archivedAt: NOW }
    let remote = snapshot(1, [done, failed])
    const transport: AllTasksTransport = {
      bootstrap: async () => remote,
      state: async () => remote,
      action: async action => {
        actions.push(action)
        remote = snapshot(2, [archivedDone, archivedFailed])
        return remote
      },
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({
      store: new InMemoryTaskStore(),
      sessions: new FakeSessions() as never,
      transport,
      now: () => NOW,
      uuid,
    })
    controller.start()
    expect(await controller.hideSettledTasks(['done', 'failed'], true)).toBe(true)
    expect(actions).toEqual([{ kind: 'hide-tasks', taskIds: ['done', 'failed'], archiveSessions: true }])
    // The board follows the Host snapshot, never a local guess.
    expect(controller.getSnapshot().tasks.find(task => task.id === 'done')?.archivedAt).toBe(NOW)
    expect(controller.getSnapshot().tasks.find(task => task.id === 'failed')?.archivedAt).toBe(NOW)
  })

  it('reports a Host refusal as false without adopting local state', async () => {
    const done = task('done', 'done')
    const transport: AllTasksTransport = {
      bootstrap: async () => snapshot(1, [done]),
      state: async () => snapshot(1, [done]),
      action: async () => { throw new Error('task cannot be archived') },
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({
      store: new InMemoryTaskStore(),
      sessions: new FakeSessions() as never,
      transport,
      now: () => NOW,
      uuid,
    })
    controller.start()
    expect(await controller.hideSettledTasks(['done'], false)).toBe(false)
    expect(controller.getSnapshot().transportError).toBe('task cannot be archived')
    expect(controller.getSnapshot().tasks[0].archivedAt).toBeUndefined()
  })
})
