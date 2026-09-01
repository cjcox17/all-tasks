/**
 * Controller tests: orchestration — persistence, view state, navigation
 * awareness, and the Host run loop (run action → confirmed running state →
 * settled frame).
 */
import { describe, expect, it, vi } from 'vitest'
import { BoardController, type ControllerDeps, type TaskBoardTransport } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import { InMemoryTaskStore } from '../src/core/store.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskBoardAction, TaskBoardEventPayload, TaskBoardSnapshot } from '../src/protocol.ts'

const NOW = 1_700_000_000_000
let nextId = 0
const uuid = (): string => { nextId += 1; return `id-${nextId}` }

/** Flush pending microtasks (async controller paths). */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** Controllable sessions face (selection + open). */
class FakeSessions {
  current: string | undefined = undefined
  openCalls: string[] = []
  private listeners = new Set<() => void>()
  list = {
    getSnapshot: (): { current: string | undefined } => ({ current: this.current }),
    subscribe: (fn: () => void): (() => void) => {
      this.listeners.add(fn)
      return () => { this.listeners.delete(fn) }
    },
  }
  open(id: string): void {
    this.openCalls.push(id)
    this.setCurrent(id)
  }
  setCurrent(id: string | undefined): void {
    this.current = id
    for (const fn of [...this.listeners]) fn()
  }
}

/** Host-like snapshot builder for transport fakes. */
function snapshot(revision: number, tasks: TaskRecord[] = [], ledgerId = 'ledger-a'): TaskBoardSnapshot {
  return {
    schemaVersion: 2,
    revision,
    tasks,
    groups: [],
    workspaceDefaults: {},
    scheduler: { timeZone: 'UTC', ledgerId },
    power: {
      platform: 'linux', phase: 'unsupported', enabled: false,
      runningSessions: 0, armedSchedules: 0, sessionStateKnown: true,
    },
  }
}

function makeController() {
  const sessions = new FakeSessions()
  const store = new InMemoryTaskStore()
  const deps: ControllerDeps = {
    store,
    sessions,
    now: () => NOW,
    uuid,
  }
  const controller = new BoardController(deps)
  controller.start()
  return { controller, sessions, store }
}

function seedTask(store: InMemoryTaskStore, overrides: Partial<Parameters<typeof createTask>[0] & { id: string }> = {}) {
  const task = createTask(
    { title: '任务A', description: '描述', prompt: 'prompt A', ...overrides },
    NOW,
    overrides.id ?? 'task-a',
  )
  store.save([task])
  return task
}

describe('BoardController execution options', () => {
  it('starts with empty picker option sets and merges partial updates', () => {
    const { controller } = makeController()
    expect(controller.getSnapshot().executionOptions).toEqual({ workspaces: [], presets: [], models: [], endpoints: [] })
    controller.setExecutionOptions({ workspaces: [{ workspaceId: 'ws-1', title: 'One' }] })
    expect(controller.getSnapshot().executionOptions.workspaces).toEqual([{ workspaceId: 'ws-1', title: 'One' }])
    expect(controller.getSnapshot().executionOptions.presets).toEqual([])
    controller.setExecutionOptions({ presets: [{ id: 'anchored', isDefault: true }] })
    expect(controller.getSnapshot().executionOptions).toEqual({
      workspaces: [{ workspaceId: 'ws-1', title: 'One' }],
      presets: [{ id: 'anchored', isDefault: true }],
      models: [],
      endpoints: [],
    })
  })

  it('creates tasks carrying execution targets and updates them back', () => {
    const { controller } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '', workspaceId: 'ws-1', mode: 'anchored', permission: 'read-only' })
    expect(task?.workspaceId).toBe('ws-1')
    expect(task?.mode).toBe('anchored')
    expect(task?.permission).toBe('read-only')
    controller.updateTask(task!.id, { workspaceId: undefined, mode: undefined, permission: undefined })
    const after = controller.getSnapshot().tasks[0]
    expect(after.workspaceId).toBeUndefined()
    expect(after.mode).toBeUndefined()
    expect(after.permission).toBeUndefined()
  })
})

describe('BoardController lifecycle', () => {
  it('loads the persisted ledger on start', () => {
    const { store } = makeController()
    seedTask(store)
    const reloaded = new BoardController({
      store, sessions: new FakeSessions(), now: () => NOW, uuid,
    })
    reloaded.start()
    expect(reloaded.getSnapshot().tasks.map(task => task.id)).toEqual(['task-a'])
  })

  it('reloadFromStore replaces the in-memory ledger from the persisted store, silently', () => {
    const { controller, store } = makeController()
    controller.createTask({ title: 'a', description: '', prompt: '' })
    // A sibling tab deletes the task behind this controller's back (the
    // persisted store is rewritten); the scheduler-facing reload must pick
    // the freshest truth up without re-rendering UI subscribers.
    store.save([])
    let notified = 0
    controller.subscribe(() => { notified += 1 })
    controller.reloadFromStore()
    expect(controller.getSnapshot().tasks).toEqual([])
    expect(notified).toBe(0)
  })

  it('dispose unsubscribes (no more notifications)', () => {
    const { controller, sessions } = makeController()
    let count = 0
    controller.subscribe(() => { count += 1 })
    controller.dispose()
    sessions.setCurrent('s-1')
    expect(count).toBe(0)
  })
})

describe('task mutations', () => {
  it('creates, persists, and rejects blank titles', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: ' 新任务 ', description: '', prompt: '' })
    expect(task).toBeDefined()
    expect(controller.getSnapshot().tasks).toHaveLength(1)
    expect(store.load()[0].title).toBe('新任务')
    expect(controller.createTask({ title: '   ', description: '', prompt: '' })).toBeUndefined()
  })

  it('uses the default uuid path to mint UUIDv4 task ids', () => {
    const controller = new BoardController({
      store: new InMemoryTaskStore(),
      sessions: new FakeSessions(),
      now: () => NOW,
    })
    controller.start()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    // crypto.randomUUID is available under node, so the result is provider-agnostic.
    expect(task.id).not.toMatch(/^t-/)
  })

  it('deletes and clears the selection when the selected task is removed', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    controller.openTask(task.id)
    controller.deleteTask(task.id)
    expect(controller.getSnapshot().tasks).toHaveLength(0)
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined()
    expect(store.load()).toEqual([])
  })

  it('updates and moves tasks with persistence', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    controller.updateTask(task.id, { title: 'y' })
    controller.moveTask(task.id, 'backlog')
    const persisted = store.load()[0]
    expect(persisted.title).toBe('y')
    expect(persisted.status).toBe('backlog')
  })
})

describe('view state', () => {
  it('toggles the board and reflects it in the snapshot', () => {
    const { controller } = makeController()
    expect(controller.getSnapshot().boardOpen).toBe(false)
    controller.openBoard()
    expect(controller.getSnapshot().boardOpen).toBe(true)
    controller.openBoard() // idempotent
    expect(controller.getSnapshot().boardOpen).toBe(true)
    controller.closeBoard()
    expect(controller.getSnapshot().boardOpen).toBe(false)
    controller.toggleBoard()
    expect(controller.getSnapshot().boardOpen).toBe(true)
  })

  it('stays open when the current selection changes without user navigation', () => {
    const { controller, sessions } = makeController()
    sessions.setCurrent('s-1')
    controller.openBoard()
    expect(controller.getSnapshot().boardOpen).toBe(true)
    // The Host runner selecting a fresh execution session is session-list
    // churn, not user navigation: the board must stay open.
    sessions.setCurrent('s-2')
    expect(controller.getSnapshot().boardOpen).toBe(true)
  })

  it('stays open during transient undefined session list jitter (#1182)', () => {
    const { controller, sessions } = makeController()
    sessions.setCurrent('s-1')
    controller.openBoard()
    // Transient undefined blip (e.g. list refresh / subagent chain reload) must not close the board
    sessions.setCurrent(undefined)
    expect(controller.getSnapshot().boardOpen).toBe(true)
    // Resolving back to the current session stays open
    sessions.setCurrent('s-1')
    expect(controller.getSnapshot().boardOpen).toBe(true)
    // Any further selection change is churn as well, not user navigation
    sessions.setCurrent('s-2')
    expect(controller.getSnapshot().boardOpen).toBe(true)
  })

  it('stays open when opened before any session is selected (#1182)', () => {
    const { controller, sessions } = makeController()
    sessions.setCurrent(undefined)
    controller.openBoard()
    expect(controller.getSnapshot().boardOpen).toBe(true)
    // First session selection is churn, not navigation: stay open
    sessions.setCurrent('s-1')
    expect(controller.getSnapshot().boardOpen).toBe(true)
    // And so is any later selection change
    sessions.setCurrent('s-2')
    expect(controller.getSnapshot().boardOpen).toBe(true)
  })

  it('stays open on unrelated session-list changes (status updates of the same selection)', () => {
    const { controller, sessions } = makeController()
    sessions.setCurrent('s-1')
    controller.openBoard()
    // A notification with an unchanged selection must not close the board.
    for (const fn of [...(sessions as unknown as { listeners: Set<() => void> }).listeners]) fn()
    expect(controller.getSnapshot().boardOpen).toBe(true)
  })

  it('openTask/closeTask manage the selection', () => {
    const { controller } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    controller.openTask(task.id)
    expect(controller.getSnapshot().selectedTaskId).toBe(task.id)
    controller.closeTask()
    expect(controller.getSnapshot().selectedTaskId).toBeUndefined()
  })

  it('openSession selects the session on the runtime', () => {
    const { controller, sessions } = makeController()
    controller.openSession('exec-session')
    expect(sessions.openCalls).toEqual(['exec-session'])
  })
})

describe('run loop', () => {
  it('requests a Host run and applies the confirmed running state', async () => {
    const initial = createTask({ title: '任务A', description: '', prompt: '干活' }, NOW, 'task-a')
    const running = { ...initial, status: 'running' as const, updatedAt: NOW + 1 }
    const actions: TaskBoardAction[] = []
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(1, [initial]),
      state: async () => snapshot(1, [initial]),
      action: async action => { actions.push(action); return snapshot(2, [running]) },
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport, now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()

    expect(await controller.runTask('task-a')).toBe(true)
    expect(actions).toEqual([{ kind: 'run', taskId: 'task-a' }])
    expect(controller.getSnapshot().tasks[0].status).toBe('running')
    // A second run while the task is already running is ignored locally.
    expect(await controller.runTask('task-a')).toBe(false)
    expect(actions).toHaveLength(1)
    controller.dispose()
  })

  it('applies Host settlement through an SSE frame', async () => {
    const initial = createTask({ title: '任务A', description: '', prompt: '干活' }, NOW, 'task-a')
    const running: TaskRecord = {
      ...initial, status: 'running', updatedAt: NOW + 1,
      executions: [{ id: 'e1', sessionId: 's-9', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }],
    }
    const done: TaskRecord = {
      ...running, status: 'done', updatedAt: NOW + 2,
      executions: [{ id: 'e1', sessionId: 's-9', startedAt: NOW, endedAt: NOW + 5, result: 'succeeded', error: undefined }],
    }
    let onEvent: ((event?: TaskBoardEventPayload) => void) | undefined
    let remote = snapshot(2, [running])
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(1, [initial]),
      state: async () => remote,
      action: async () => { remote = snapshot(2, [running]); return remote },
      subscribe: listener => { onEvent = listener; return () => undefined },
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport, now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()
    await controller.runTask('task-a')
    expect(controller.getSnapshot().tasks[0].status).toBe('running')

    // The Host settles the execution and broadcasts the frame.
    remote = snapshot(3, [done])
    onEvent?.({ revision: 3, scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' }, power: snapshot(3).power })
    await flush()
    expect(controller.getSnapshot().tasks[0].status).toBe('done')
    expect(controller.getSnapshot().tasks[0].executions[0].result).toBe('succeeded')
    controller.dispose()
  })

  it('rerunTask requests a Host rerun and applies the replanned running state', async () => {
    const initial = createTask({ title: '任务A', description: '', prompt: '干活' }, NOW, 'task-a')
    const failed: TaskRecord = {
      ...initial, status: 'failed', updatedAt: NOW + 1,
      executions: [{ id: 'e1', sessionId: 's-9', startedAt: NOW, endedAt: NOW + 5, result: 'failed', error: 'boom' }],
    }
    const rerunning: TaskRecord = { ...failed, status: 'running', updatedAt: NOW + 2 }
    const actions: TaskBoardAction[] = []
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(2, [failed]),
      state: async () => snapshot(2, [failed]),
      action: async action => { actions.push(action); return snapshot(3, [rerunning]) },
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport, now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()

    expect(controller.getSnapshot().tasks[0].status).toBe('failed')
    await controller.rerunTask('task-a')
    expect(actions).toEqual([{ kind: 'rerun', taskId: 'task-a' }])
    expect(controller.getSnapshot().tasks[0].status).toBe('running')
    controller.dispose()
  })

  it('runGroup requests a Host group run', async () => {
    const initial = createTask({ title: '任务A', description: '', prompt: '干活' }, NOW, 'task-a')
    const group: TaskGroupRecord = {
      id: 'g1', name: 'G', mode: 'sequential', offPeakOnly: false,
      order: ['task-a'], createdAt: NOW, updatedAt: NOW,
    }
    const running = { ...initial, status: 'running' as const, updatedAt: NOW + 1 }
    const actions: TaskBoardAction[] = []
    const withGroup = (tasks: TaskRecord[]): TaskBoardSnapshot => ({
      schemaVersion: 2, revision: 1, tasks, groups: [group], workspaceDefaults: {},
      scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
    })
    const transport: TaskBoardTransport = {
      bootstrap: async () => withGroup([initial]),
      state: async () => withGroup([initial]),
      action: async action => { actions.push(action); return withGroup([running]) },
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport, now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()

    expect(await controller.runGroup('g1')).toBe(true)
    expect(actions).toEqual([{ kind: 'run-group', groupId: 'g1' }])
    expect(controller.getSnapshot().tasks[0].status).toBe('running')
    controller.dispose()
  })

  it('runGroup refuses unknown or stopped groups and refuses without a Host transport', async () => {
    const initial = createTask({ title: '任务A', description: '', prompt: '干活' }, NOW, 'task-a')
    const group: TaskGroupRecord = {
      id: 'g1', name: 'G', mode: 'sequential', offPeakOnly: false, stopped: true,
      order: ['task-a'], createdAt: NOW, updatedAt: NOW,
    }
    const actions: TaskBoardAction[] = []
    const withGroup = (tasks: TaskRecord[]): TaskBoardSnapshot => ({
      schemaVersion: 2, revision: 1, tasks, groups: [group], workspaceDefaults: {},
      scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
    })
    const transport: TaskBoardTransport = {
      bootstrap: async () => withGroup([initial]),
      state: async () => withGroup([initial]),
      action: async action => { actions.push(action); return withGroup([initial]) },
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport, now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()

    // Unknown group: refused locally, the Host is never contacted.
    expect(await controller.runGroup('missing')).toBe(false)
    // Stopped group: refused locally.
    expect(await controller.runGroup('g1')).toBe(false)
    expect(actions).toHaveLength(0)

    // Without a Host transport the run is refused too.
    const { controller: legacy } = makeController()
    expect(await legacy.runGroup('g1')).toBe(false)
    controller.dispose()
    legacy.dispose()
  })

  it('refuses runs and reruns of archived tasks without contacting the Host', async () => {
    const archived = {
      ...createTask({ title: '归档任务', description: '', prompt: '干活' }, NOW, 'task-a'),
      status: 'done' as const,
      archivedAt: NOW,
    }
    const action = vi.fn(async () => snapshot(1, [archived]))
    const transport: TaskBoardTransport = {
      bootstrap: async () => snapshot(1, [archived]),
      state: async () => snapshot(1, [archived]),
      action,
      subscribe: () => () => undefined,
    }
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport, now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()

    expect(await controller.runTask('task-a')).toBe(false)
    await controller.rerunTask('task-a')
    expect(action).not.toHaveBeenCalled()
    expect(controller.getSnapshot().tasks[0]).toMatchObject({ status: 'done', archivedAt: NOW })
    controller.dispose()
  })

  it('refuses to run without a Host transport (legacy client execution removed)', async () => {
    const { controller } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    expect(await controller.runTask(task.id)).toBe(false)
    await controller.rerunTask(task.id)
    expect(controller.getSnapshot().tasks[0].status).toBe('todo')
  })
})

describe('scheduling', () => {
  it('setSchedule enables a rule and computes the next run instant', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    expect(controller.setSchedule(task.id, { enabled: true, cron: '* * * * *' })).toBe(true)
    const persisted = store.load()[0]
    expect(persisted.schedule?.enabled).toBe(true)
    expect(persisted.schedule?.cron).toBe('* * * * *')
    expect(persisted.schedule?.nextRunAt).toBeDefined()
  })

  it('does not let archived tasks re-enable their schedules', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    expect(controller.setSchedule(task.id, { enabled: true, cron: '* * * * *' })).toBe(true)
    controller.moveTask(task.id, 'done')
    expect(controller.archiveTask(task.id)).toBe(true)
    expect(store.load()[0].schedule).toMatchObject({ enabled: false, nextRunAt: undefined })
    expect(controller.setSchedule(task.id, { enabled: true, cron: '* * * * *' })).toBe(false)
  })

  it('rejects blank or invalid cron expressions without touching state', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    expect(controller.setSchedule(task.id, { enabled: true, cron: 'not a cron' })).toBe(false)
    expect(controller.setSchedule(task.id, { enabled: true, cron: '   ' })).toBe(false)
    expect(controller.setSchedule(task.id, { enabled: true })).toBe(false) // no existing cron → blank → rejected
    expect(store.load()[0].schedule).toBeUndefined()
  })

  it('disabling a rule clears the next run instant but keeps the cron', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    controller.setSchedule(task.id, { enabled: true, cron: '* * * * *' })
    expect(controller.setSchedule(task.id, { enabled: false })).toBe(true)
    const persisted = store.load()[0]
    expect(persisted.schedule?.enabled).toBe(false)
    expect(persisted.schedule?.cron).toBe('* * * * *')
    expect(persisted.schedule?.nextRunAt).toBeUndefined()
  })

  it('recomputes the next run when the cron changes while enabled', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    controller.setSchedule(task.id, { enabled: true, cron: '* * * * *' })
    const first = store.load()[0].schedule?.nextRunAt
    controller.setSchedule(task.id, { cron: '*/5 * * * *' })
    const second = store.load()[0].schedule?.nextRunAt
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
  })

  it('applyScheduleNextRun rolls the schedule forward for the scheduler', () => {
    const { controller, store } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    controller.setSchedule(task.id, { enabled: true, cron: '* * * * *' })
    controller.applyScheduleNextRun(task.id, 1_234_567_890, 1_234_500_000)
    const persisted = store.load()[0]
    expect(persisted.schedule?.nextRunAt).toBe(1_234_567_890)
    expect(persisted.schedule?.lastTriggeredAt).toBe(1_234_500_000)
  })

  it('applyScheduleNextRun is a no-op for tasks without a schedule rule', () => {
    const { controller } = makeController()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    expect(() => controller.applyScheduleNextRun(task.id, 1, 2)).not.toThrow()
    expect(controller.getSnapshot().tasks[0].schedule).toBeUndefined()
  })
})

/** Store that can simulate a sibling tab writing the ledger. */
class ExternalAwareStore extends InMemoryTaskStore {
  listeners = new Set<() => void>()
  subscribeExternal(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** Simulate another tab persisting a new ledger document. */
  writeFromElsewhere(tasks: readonly TaskRecord[]): void {
    this.save(tasks)
    for (const listener of [...this.listeners]) listener()
  }
}

describe('external (cross-tab) ledger changes', () => {
  function makeWithExternalStore() {
    const sessions = new FakeSessions()
    const store = new ExternalAwareStore()
    const controller = new BoardController({
      store,
      sessions,
      now: () => NOW,
      uuid,
    })
    controller.start()
    return { controller, sessions, store }
  }

  it('reloads the ledger when a sibling tab deletes a task', () => {
    const { controller, store } = makeWithExternalStore()
    const task = controller.createTask({ title: 'x', description: '', prompt: '' })!
    expect(controller.getSnapshot().tasks.map(t => t.id)).toEqual([task.id])
    // Another tab deletes the task and persists; this tab must drop it too,
    // so its scheduler can never fire (or write back) the deleted task.
    store.writeFromElsewhere([])
    expect(controller.getSnapshot().tasks).toHaveLength(0)
    expect(store.load()).toEqual([])
  })

  it('reloads a task created in a sibling tab', () => {
    const { controller, store } = makeWithExternalStore()
    expect(controller.getSnapshot().tasks).toHaveLength(0)
    const task = createTask({ title: '从别的标签页创建', description: '', prompt: '' }, NOW, 'other-tab')
    store.writeFromElsewhere([task])
    expect(controller.getSnapshot().tasks.map(t => t.id)).toEqual(['other-tab'])
  })

  it('stops reacting to external changes after dispose', () => {
    const { controller, store } = makeWithExternalStore()
    let notified = 0
    controller.subscribe(() => { notified += 1 })
    controller.dispose()
    store.writeFromElsewhere([])
    expect(notified).toBe(0)
  })
})

describe('BoardController legacy group transitions', () => {
  it('creates, joins, orders, and deletes groups in the legacy (non-Host) path', async () => {
    const { controller } = makeController()
    const group = await controller.createGroupConfirmed({ name: 'Nightly', mode: 'parallel', maxParallel: 2 })
    expect(group?.id).toBeDefined()
    expect(controller.getSnapshot().groups[0]).toMatchObject({ name: 'Nightly', mode: 'parallel', maxParallel: 2 })

    controller.createTask({ title: 'A', description: '', prompt: '', groupId: group!.id })
    controller.createTask({ title: 'B', description: '', prompt: '', groupId: group!.id })
    const [a, b] = controller.groupMembers(group!.id)
    expect([a!.title, b!.title]).toEqual(['A', 'B'])

    expect(await controller.setGroupOrder(group!.id, [b!.id, a!.id])).toBe(true)
    expect(controller.groupMembers(group!.id).map(t => t.title)).toEqual(['B', 'A'])
    // A prefix order is accepted (unlisted members appended)…
    expect(await controller.setGroupOrder(group!.id, [a!.id])).toBe(true)
    expect(controller.groupMembers(group!.id).map(t => t.title)).toEqual(['A', 'B'])
    // …but a duplicate or non-member is rejected.
    expect(await controller.setGroupOrder(group!.id, [a!.id, a!.id])).toBe(false)
    expect(await controller.setGroupOrder(group!.id, ['unknown'])).toBe(false)

    await controller.updateTask(a!.id, { groupId: null })
    expect(controller.groupMembers(group!.id).map(t => t.title)).toEqual(['B'])

    expect(await controller.deleteGroup(group!.id)).toBe(true)
    expect(controller.getSnapshot().groups).toHaveLength(0)
    expect(controller.getSnapshot().tasks.find(t => t.title === 'B')?.groupId).toBeUndefined()
  })

  it('refuses to move a running member out of its group (the slot must not leak)', async () => {
    const { store, sessions } = makeController()
    const controller = new BoardController({ store, sessions, now: () => NOW, uuid })
    controller.start()
    // The group must exist before the member is seeded (the legacy path now
    // validates membership against the group roster like the Host).
    const group = await controller.createGroupConfirmed({ name: 'G' })
    const running = {
      ...createTask({ title: 'A', description: '', prompt: '' }, NOW, 'task-a'),
      status: 'running' as const,
      groupId: group!.id,
      executions: [{ id: 'e1', sessionId: 's-1', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }],
    }
    store.save([running])
    controller.reloadFromStore()

    expect(await controller.updateTask('task-a', { groupId: null })).toBe(false)
    expect(controller.getSnapshot().tasks[0].groupId).toBe(group!.id)
    // Re-setting the same membership is not a move and stays allowed.
    expect(await controller.updateTask('task-a', { groupId: group!.id })).toBe(true)
    controller.dispose()
  })

  it('enforces workspace scoping in the legacy path: mismatched joins are refused, workspace moves ungroup', async () => {
    const { controller } = makeController()
    const wsA = await controller.createGroupConfirmed({ name: 'A', workspaceId: 'ws-a' })
    const wsB = await controller.createGroupConfirmed({ name: 'B', workspaceId: 'ws-b' })
    expect(wsA?.workspaceId).toBe('ws-a')
    expect(wsB?.workspaceId).toBe('ws-b')

    // A matching-scope task joins fine.
    const joined = controller.createTask({ title: 'Joined', description: '', prompt: '', workspaceId: 'ws-a', groupId: wsA!.id })
    expect(joined?.groupId).toBe(wsA!.id)

    // Mismatched creates are refused outright (leave the ledger untouched).
    expect(controller.createTask({ title: 'Bad ws', description: '', prompt: '', workspaceId: 'ws-b', groupId: wsA!.id })).toBeUndefined()
    expect(controller.createTask({ title: 'Unassigned', description: '', prompt: '', groupId: wsA!.id })).toBeUndefined()
    expect(controller.getSnapshot().tasks).toHaveLength(1)

    // An explicit mismatched join through update is refused.
    expect(await controller.updateTask(joined!.id, { groupId: wsB!.id })).toBe(false)

    // Moving the task to another workspace auto-ungroups it.
    expect(await controller.updateTask(joined!.id, { workspaceId: 'ws-b' })).toBe(true)
    const after = controller.getSnapshot().tasks.find(t => t.id === joined!.id)!
    expect(after.workspaceId).toBe('ws-b')
    expect(after.groupId).toBeUndefined()
    expect(controller.groupMembers(wsA!.id)).toHaveLength(0)
    controller.dispose()
  })

  it('editing a group member preserves the group member order', async () => {
    const { controller } = makeController()
    const group = await controller.createGroupConfirmed({ name: 'Nightly', mode: 'sequential' })
    controller.createTask({ title: 'A', description: '', prompt: '', groupId: group!.id })
    controller.createTask({ title: 'B', description: '', prompt: '', groupId: group!.id })
    const [a, b] = controller.groupMembers(group!.id)
    expect(await controller.setGroupOrder(group!.id, [b!.id, a!.id])).toBe(true)
    expect(controller.groupMembers(group!.id).map(t => t.title)).toEqual(['B', 'A'])

    // Editing one member (content + execution targets, no group change) must
    // not reshuffle the group's member order. (A workspace move would ungroup
    // the member from this workspace-less group, so the execution-target edit
    // uses the agent preset instead.)
    expect(await controller.updateTask(b!.id, { title: 'B edited', description: '', prompt: 'p' })).toBe(true)
    expect(await controller.updateTask(b!.id, { mode: 'planner' })).toBe(true)
    expect(controller.groupMembers(group!.id).map(t => t.title)).toEqual(['B edited', 'A'])
    expect(controller.getSnapshot().groups[0]!.order).toEqual([b!.id, a!.id])
  })
})

describe('BoardController workspace defaults', () => {
  it('sets, merges, and clears per-workspace defaults in the legacy (non-Host) path', async () => {
    const { controller } = makeController()
    expect(controller.getSnapshot().workspaceDefaults).toEqual({})

    expect(await controller.setWorkspaceDefaults('ws-a', { mode: 'planner', approved: false })).toBe(true)
    expect(controller.getSnapshot().workspaceDefaults).toEqual({ 'ws-a': { mode: 'planner', approved: false } })

    // A second edit merges: mode cleared, model set.
    expect(await controller.setWorkspaceDefaults('ws-a', { mode: null, model: { provider: 'deepseek', model: 'chat' } })).toBe(true)
    expect(controller.getSnapshot().workspaceDefaults).toEqual({
      'ws-a': { model: { provider: 'deepseek', model: 'chat' }, approved: false },
    })

    // Clearing every field drops the entry.
    expect(await controller.setWorkspaceDefaults('ws-a', { model: null, approved: null })).toBe(true)
    expect(controller.getSnapshot().workspaceDefaults).toEqual({})
    // An all-clear edit on a missing entry is a no-op success.
    expect(await controller.setWorkspaceDefaults('ws-a', { mode: null })).toBe(true)
  })

  it('notifies subscribers on a workspace-defaults change', async () => {
    const { controller } = makeController()
    let notified = 0
    controller.subscribe(() => { notified += 1 })
    await controller.setWorkspaceDefaults('ws-a', { mode: 'planner' })
    expect(notified).toBe(1)
  })
})

describe('BoardController reorder', () => {
  it('reorders the ledger array through the legacy path and persists', () => {
    const { controller, store } = makeController()
    const ids = ['a', 'b', 'c'].map(title =>
      controller.createTask({ title, description: '', prompt: '' })!.id)
    expect(controller.getSnapshot().tasks.map(t => t.id)).toEqual(ids)
    // Move the first task below the others (end of the array).
    controller.reorderTask(ids[0]!, undefined)
    expect(controller.getSnapshot().tasks.map(t => t.id)).toEqual([ids[1], ids[2], ids[0]])
    expect(store.load().map(t => t.id)).toEqual([ids[1], ids[2], ids[0]])
  })

  it('is a no-op when the task is already in place — nothing is persisted', () => {
    const { controller, store } = makeController()
    const ids = ['a', 'b', 'c'].map(title =>
      controller.createTask({ title, description: '', prompt: '' })!.id)
    const save = vi.spyOn(store, 'save')
    controller.reorderTask(ids[0]!, ids[1])
    expect(controller.getSnapshot().tasks.map(t => t.id)).toEqual(ids)
    expect(save).not.toHaveBeenCalled()
  })

  it('editing a task never changes its position (edit ≠ reorder)', async () => {
    const { controller, store } = makeController()
    const ids = ['alpha', 'beta', 'gamma'].map(title =>
      controller.createTask({ title, description: '', prompt: '' })!.id)
    const before = controller.getSnapshot().tasks.map(t => t.id)
    // Edit the middle task's content, schedule, approval, and targets —
    // every editable surface — and the ledger order must stay identical.
    expect(await controller.updateTask(ids[1]!, { title: 'beta edited', description: 'd', prompt: 'p' })).toBe(true)
    expect(await controller.updateTask(ids[1]!, { workspaceId: 'ws-1', mode: 'anchored' })).toBe(true)
    controller.setApproved(ids[1]!, true)
    expect(controller.getSnapshot().tasks.map(t => t.id)).toEqual(before)
    expect(store.load().map(t => t.id)).toEqual(before)
  })
})

describe('BoardController workspace fan-out', () => {
  const OPEN = { id: 'e', sessionId: 's', startedAt: 0, endedAt: undefined, result: undefined, error: undefined }

  function hostTransport(seedTasks: TaskRecord[], seedGroups: TaskGroupRecord[], actions: TaskBoardAction[]): TaskBoardTransport {
    const snap = (): TaskBoardSnapshot => ({
      schemaVersion: 2, revision: 1, tasks: seedTasks, groups: seedGroups, workspaceDefaults: {},
      scheduler: { timeZone: 'UTC', ledgerId: 'ledger-a' },
      power: { platform: 'linux', phase: 'unsupported', enabled: false, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
    })
    return {
      bootstrap: async () => snap(),
      state: async () => snap(),
      action: async action => { actions.push(action); return snap() },
      subscribe: () => () => undefined,
    }
  }

  it('runWorkspace starts todo (never backlog) ungrouped tasks plus non-stopped groups', async () => {
    const todo = createTask({ title: 'todo', description: '', prompt: '', workspaceId: 'ws-a' }, NOW, 't-todo')
    const backlog = { ...createTask({ title: 'backlog', description: '', prompt: '', workspaceId: 'ws-a' }, NOW, 't-backlog'), status: 'backlog' as const }
    const group: TaskGroupRecord = { id: 'g1', name: 'G', mode: 'sequential', workspaceId: 'ws-a', offPeakOnly: false, order: ['m1'], createdAt: NOW, updatedAt: NOW }
    const member = createTask({ title: 'member', description: '', prompt: '', workspaceId: 'ws-a', groupId: 'g1' }, NOW, 'm1')
    const actions: TaskBoardAction[] = []
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport: hostTransport([todo, backlog, member], [group], actions), now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()

    await controller.runWorkspace('ws-a')
    expect(actions.map(action => action.kind === 'run' ? `run:${(action as Extract<TaskBoardAction, { kind: 'run' }>).taskId}` : action.kind === 'run-group' ? `run-group:${(action as Extract<TaskBoardAction, { kind: 'run-group' }>).groupId}` : action.kind))
      .toEqual(['run:t-todo', 'run-group:g1'])
    controller.dispose()
  })

  it('pauseWorkspaceGroups stops running groups; stopWorkspace cancels running ungrouped tasks and groups', async () => {
    const runTask = { ...createTask({ title: 'run', description: '', prompt: '', workspaceId: 'ws-a' }, NOW, 't-run'), status: 'running' as const, executions: [OPEN] }
    const group: TaskGroupRecord = { id: 'g1', name: 'G', mode: 'sequential', workspaceId: 'ws-a', offPeakOnly: false, order: ['m1'], createdAt: NOW, updatedAt: NOW }
    const member = { ...createTask({ title: 'member', description: '', prompt: '', workspaceId: 'ws-a', groupId: 'g1' }, NOW, 'm1'), status: 'running' as const, executions: [OPEN] }
    const actions: TaskBoardAction[] = []
    const controller = new BoardController({ store: new InMemoryTaskStore(), sessions: new FakeSessions(), transport: hostTransport([runTask, member], [group], actions), now: () => NOW, uuid })
    controller.start()
    await controller.retryHostSync()

    await controller.pauseWorkspaceGroups('ws-a')
    expect(actions).toEqual([{ kind: 'stop-group', groupId: 'g1' }])

    actions.length = 0
    await controller.stopWorkspace('ws-a')
    expect(actions).toEqual([{ kind: 'stop', taskId: 't-run' }, { kind: 'stop-group', groupId: 'g1' }])
    controller.dispose()
  })
})
