// @vitest-environment jsdom
/**
 * Group banner live-status badges: while a group sequence is active, the
 * banner in every column shows a Running pill (a member's session executes)
 * and/or a Pending pill (members are held before launch — queued for a group
 * slot, the allowed window, or an endpoint). The badges are derived from the
 * member tasks' open executions, so a group that is mid-run or waiting never
 * looks idle from any column.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AllTasks } from '../src/client/board/AllTasks.tsx'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import type { ExecutionRecord, TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  document.documentElement.lang = 'en'
})

afterEach(() => {
  document.documentElement.lang = ''
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-dsh-all-tasks-active')
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    title: 'Task A',
    description: '',
    prompt: 'do it',
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    executions: [],
    ...overrides,
  }
}

function group(overrides: Partial<TaskGroupRecord> = {}): TaskGroupRecord {
  return {
    id: 'g1',
    name: 'Group A',
    mode: 'sequential',
    offPeakOnly: false,
    order: ['t1', 't2'],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

/** An open (unsettled) execution record for a member. */
function openExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'x1',
    sessionId: undefined,
    startedAt: 0,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    ...overrides,
  }
}

function fakeController(snapshot?: Partial<ControllerSnapshot>): BoardController {
  const state: ControllerSnapshot = {
    tasks: [task()],
    groups: [],
    boardOpen: false,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: [], endpoints: [] },
    workspaceDefaults: {},
    workspacePaused: {},
    pendingTaskIds: [],
    ...snapshot,
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    closeTask: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: () => {},
    moveTask: () => {},
    groupMembers: (id: string) => state.tasks.filter(t => t.groupId === id),
    createGroupConfirmed: async () => undefined,
    updateGroup: async () => true,
    deleteGroup: async () => true,
    setGroupOrder: async () => true,
    runTask: async () => true,
    runGroup: async () => true,
    stopTask: async () => true,
    stopGroup: async () => true,
    resumeGroup: async () => true,
    moveGroup: async () => true,
    setApproved: () => {},
    setWorkspaceDefaults: async () => true,
    updateTask: async () => true,
    reorderTask: () => {},
  } as unknown as BoardController
}

/** Mount the board and open the All-tasks kanban (the landing is the list). */
async function mountKanban(controller: BoardController): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<AllTasks controller={controller} />) })
  const wrap = Array.from(container.querySelectorAll('[data-dsh-part="workspace-card"]'))
    .find(card => card.getAttribute('data-workspace') === '') as HTMLElement | undefined
  expect(wrap, 'All-tasks card').toBeDefined()
  await act(async () => { wrap!.querySelector('button[data-dsh-part="workspace-name"]')!.click() })
  return container
}

/** The group's banner header inside its (first) column section. */
function bannerOf(container: HTMLElement, groupId: string): HTMLElement {
  const section = Array.from(container.querySelectorAll('[data-dsh-part="group"]'))
    .find(header => header.closest(`[data-group="${groupId}"]`) !== null) as HTMLElement | undefined
  expect(section, `group banner ${groupId}`).toBeDefined()
  return section!
}

describe('AllTasks group banner status badges', () => {
  it('shows no status pills for an idle group', async () => {
    const controller = fakeController({
      groups: [group()],
      tasks: [
        task({ id: 't1', groupId: 'g1', status: 'todo' }),
        task({ id: 't2', groupId: 'g1', status: 'todo' }),
      ],
    })
    const container = await mountKanban(controller)
    const banner = bannerOf(container, 'g1')
    expect(banner.querySelector('[data-kind="running"]')).toBeNull()
    expect(banner.querySelector('[data-kind="pending"]')).toBeNull()
    // An idle group is draggable and the stop button is disabled.
    expect(banner.getAttribute('draggable')).toBe('true')
    expect((banner.querySelector('button[aria-label="Stop group (cancel all running members)"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a Running pill with a spinner while a member executes', async () => {
    const controller = fakeController({
      groups: [group()],
      tasks: [
        task({ id: 't1', groupId: 'g1', status: 'running', executions: [openExecution({ sessionId: 's1' })] }),
        task({ id: 't2', groupId: 'g1', status: 'todo' }),
      ],
    })
    const container = await mountKanban(controller)
    const banner = bannerOf(container, 'g1')
    const running = banner.querySelector('[data-kind="running"]')
    expect(running).not.toBeNull()
    expect(running!.textContent).toContain('Running')
    expect(running!.querySelector('[class*="groupStatusSpinner"]')).not.toBeNull()
    expect(banner.querySelector('[data-kind="pending"]')).toBeNull()
    // A running group is not draggable and its stop button is live.
    expect(banner.getAttribute('draggable')).toBe('false')
    expect((banner.querySelector('button[aria-label="Stop group (cancel all running members)"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a Pending pill with the wait reason while a member is queued', async () => {
    const controller = fakeController({
      groups: [group()],
      tasks: [
        task({ id: 't1', groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: 0, queuedReason: 'group' })] }),
        task({ id: 't2', groupId: 'g1', status: 'todo' }),
      ],
    })
    const container = await mountKanban(controller)
    const banner = bannerOf(container, 'g1')
    const pending = banner.querySelector('[data-kind="pending"]')
    expect(pending).not.toBeNull()
    expect(pending!.textContent).toContain('Pending')
    expect(pending!.getAttribute('title')).toContain('Waiting for a group slot')
    expect(banner.querySelector('[data-kind="running"]')).toBeNull()
    // A queued member also holds the group: not draggable, stop enabled.
    expect(banner.getAttribute('draggable')).toBe('false')
    expect((banner.querySelector('button[aria-label="Stop group (cancel all running members)"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows both pills and the parallel count when several members run', async () => {
    const controller = fakeController({
      groups: [group({ mode: 'parallel', maxParallel: 4 })],
      tasks: [
        task({ id: 't1', groupId: 'g1', status: 'running', executions: [openExecution({ sessionId: 's1' })] }),
        task({ id: 't2', groupId: 'g1', status: 'running', executions: [openExecution({ sessionId: 's2' })] }),
        task({ id: 't3', groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: 0, queuedReason: 'endpoint' })] }),
      ],
    })
    const container = await mountKanban(controller)
    const banner = bannerOf(container, 'g1')
    const running = banner.querySelector('[data-kind="running"]')
    const pending = banner.querySelector('[data-kind="pending"]')
    expect(running).not.toBeNull()
    expect(running!.textContent).toContain('Running 2')
    expect(pending).not.toBeNull()
    expect(pending!.textContent).toContain('Pending')
    expect(pending!.getAttribute('title')).toContain('Waiting for endpoint')
  })

  it('counts multi-wait reasons in the Pending tooltip', async () => {
    const controller = fakeController({
      groups: [group({ mode: 'parallel' })],
      tasks: [
        task({ id: 't1', groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: 0, queuedReason: 'window' })] }),
        task({ id: 't2', groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: 0, queuedReason: 'endpoint' })] }),
      ],
    })
    const container = await mountKanban(controller)
    const banner = bannerOf(container, 'g1')
    const pending = banner.querySelector('[data-kind="pending"]')
    expect(pending).not.toBeNull()
    expect(pending!.textContent).toContain('Pending 2')
    const title = pending!.getAttribute('title') ?? ''
    expect(title).toContain('Waiting for the allowed window')
    expect(title).toContain('Waiting for endpoint')
  })
})
