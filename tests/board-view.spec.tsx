// @vitest-environment jsdom
/**
 * L2 semantic attributes of the board view (issue #506): the mounted board
 * container, the board root, every status column, and every task card opt
 * into the semantic-attrs/v1 enum (data-dsh-plugin / data-dsh-part) so skins
 * can target them without hash-class selectors.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountBoard } from '../src/client/board-mount.tsx'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import type { TaskRecord } from '../src/core/tasks.ts'
import type { WorkspaceDefaultsPatch } from '../src/core/workspace-defaults.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
let disposeMount: (() => void) | undefined

afterEach(() => {
  disposeMount?.()
  disposeMount = undefined
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-dsh-taskboard-active')
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't1',
    title: 'Task A',
    description: '',
    prompt: 'do it',
    status: 'todo',
    createdAt: 0,
    updatedAt: Date.now(),
    executions: [],
    ...overrides,
  }
}

function fakeController(
  snapshot?: Partial<ControllerSnapshot>,
  overrides?: Partial<BoardController>,
): BoardController {
  const state: ControllerSnapshot = {
    tasks: [task()],
    boardOpen: false,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: [], endpoints: [] },
    workspaceDefaults: {},
    groups: [],
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
    ...overrides,
  } as unknown as BoardController
}

/** Open the All-tasks kanban from the landing list (the list is the first view). */
async function openAllTasks(container: HTMLElement): Promise<void> {
  const wrap = Array.from(container.querySelectorAll('[data-dsh-part="workspace-card"]'))
    .find(card => card.getAttribute('data-workspace') === '') as HTMLElement | undefined
  expect(wrap, 'All-tasks card').toBeDefined()
  const card = wrap!.querySelector('button') as HTMLButtonElement
  await act(async () => { card.click() })
}

/** Open one workspace's kanban from the landing list. */
async function openWorkspace(container: HTMLElement, workspaceId: string): Promise<void> {
  const wrap = Array.from(container.querySelectorAll('[data-dsh-part="workspace-card"]'))
    .find(card => card.getAttribute('data-workspace') === workspaceId) as HTMLElement | undefined
  expect(wrap, `workspace card ${workspaceId}`).toBeDefined()
  const card = wrap!.querySelector('button') as HTMLButtonElement
  await act(async () => { card.click() })
}

describe('TaskBoard L2 semantic attributes (#506)', () => {
  it('tags the board root, the status columns, and the task cards', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController()} />) })

    const board = container.querySelector('[data-dsh-taskboard-board]')
    expect(board).not.toBeNull()
    expect(board!.getAttribute('data-dsh-plugin')).toBe('task-board')
    expect(board!.querySelector('button[data-dsh-center-view-back]')).not.toBeNull()

    // The board lands on the workspace list; the kanban opens behind a row.
    expect(container.querySelector('[data-dsh-part="workspace-list"]')).not.toBeNull()
    await openAllTasks(container)

    const columns = container.querySelectorAll('section[data-status]')
    expect(columns.length).toBeGreaterThan(0)
    for (const column of columns) {
      expect(column.getAttribute('data-dsh-part')).toBe('column')
    }

    const card = container.querySelector('[data-dsh-part="card"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Task A')
  })

  it('tags the archive column as a column too', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const controller = fakeController({
      archiveView: true,
      tasks: [task({ archivedAt: Date.now(), status: 'done' })],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })
    await openAllTasks(container)

    const archive = container.querySelector('section[data-status="archived"]')
    expect(archive).not.toBeNull()
    expect(archive!.getAttribute('data-dsh-part')).toBe('column')
  })
})

describe('TaskBoard card drag-and-drop status changes (#1195)', () => {
  it('marks manual tasks as draggable and running/pending/archived tasks as not draggable', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const controller = fakeController({
      tasks: [
        task({ id: 't-todo', status: 'todo' }),
        task({ id: 't-running', status: 'running' }),
        task({ id: 't-pending', status: 'todo' }),
      ],
      pendingTaskIds: ['t-pending'],
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })
    await openAllTasks(container)

    const cards = container.querySelectorAll('button[data-dsh-part="card"]')
    expect(cards).toHaveLength(3)

    // Todo card is draggable
    const todoCard = Array.from(cards).find(c => c.getAttribute('data-status') === 'todo' && !c.hasAttribute('data-pending'))
    expect(todoCard?.getAttribute('draggable')).toBe('true')

    // Running card is not draggable
    const runningCard = Array.from(cards).find(c => c.getAttribute('data-status') === 'running')
    expect(runningCard?.getAttribute('draggable')).toBe('false')

    // Pending card is not draggable
    const pendingCard = Array.from(cards).find(c => c.getAttribute('data-pending') === 'true')
    expect(pendingCard?.getAttribute('draggable')).toBe('false')
  })

  it('drops a backlog card onto the todo column and triggers controller.moveTask', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [task({ id: 't-backlog', status: 'backlog', title: 'Task Backlog' })],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })
    await openAllTasks(container)

    const todoColumn = container.querySelector('section[data-status="todo"]')
    expect(todoColumn).not.toBeNull()
    const cards = todoColumn!.querySelector('[data-dsh-part="cards"]')
    expect(cards).not.toBeNull()

    // Simulate drag and drop (task payloads are `task:<id>`)
    const dataTransfer = {
      data: { 'text/plain': 'task:t-backlog' } as Record<string, string>,
      setData(type: string, val: string) { this.data[type] = val },
      getData(type: string) { return this.data[type] ?? '' },
      dropEffect: 'none',
    }

    await act(async () => {
      cards!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })

    expect(moveCalls).toEqual([{ id: 't-backlog', status: 'todo' }])
  })

  it('rejects invalid drops (same column or dropping running tasks)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    const moveCalls: Array<{ id: string; status: string }> = []
    const controller = fakeController(
      {
        tasks: [
          task({ id: 't-todo', status: 'todo' }),
          task({ id: 't-running', status: 'running' }),
        ],
      },
      {
        moveTask: (id, status) => { moveCalls.push({ id, status }) },
      },
    )
    await act(async () => { root.render(<TaskBoard controller={controller} />) })
    await openAllTasks(container)

    const todoColumn = container.querySelector('section[data-status="todo"]')
    const todoCards = todoColumn!.querySelector('[data-dsh-part="cards"]')
    expect(todoCards).not.toBeNull()

    // Dropping on the same column does nothing
    const sameColTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 'task:t-todo' : ''),
    }
    await act(async () => {
      todoCards!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: sameColTransfer }),
      )
    })
    expect(moveCalls).toHaveLength(0)

    // Dropping a running task does nothing
    const runningTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 'task:t-running' : ''),
    }
    await act(async () => {
      todoCards!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: runningTransfer }),
      )
    })
    expect(moveCalls).toHaveLength(0)
  })
})

describe('mountBoard lifecycle & interaction (#506, #1233)', () => {
  it('tags the injected board container with data-dsh-plugin', async () => {
    const column = document.createElement('div')
    column.setAttribute('data-pane', 'conversation')
    document.body.appendChild(column)

    await act(async () => { disposeMount = mountBoard(fakeController()) })

    const view = column.querySelector('[data-dsh-taskboard-view]')
    expect(view).not.toBeNull()
    expect(view!.getAttribute('data-dsh-plugin')).toBe('task-board')
  })

  it('clicking the back button calls controller.closeBoard() (#1233)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    let closed = 0
    const controller = fakeController({}, {
      closeBoard: () => { closed += 1 },
    })
    await act(async () => { root.render(<TaskBoard controller={controller} />) })

    const backButton = container.querySelector('button[data-dsh-center-view-back]') as HTMLButtonElement
    expect(backButton).not.toBeNull()
    await act(async () => { backButton.click() })
    expect(closed).toBe(1)
  })

  it('self-heals and remounts when the conversation column is replaced (#1233)', async () => {
    let column = document.createElement('div')
    column.setAttribute('data-pane', 'conversation')
    document.body.appendChild(column)

    const controller = fakeController({ boardOpen: true })
    await act(async () => { disposeMount = mountBoard(controller) })
    expect(column.querySelector('[data-dsh-taskboard-view]')).not.toBeNull()

    // Replace the column element in DOM (e.g. React re-render of AppFrame)
    column.remove()
    column = document.createElement('div')
    column.setAttribute('data-pane', 'conversation')
    document.body.appendChild(column)

    await act(async () => {
      // Trigger MutationObserver callback
      document.body.appendChild(document.createElement('span'))
    })
    expect(column.querySelector('[data-dsh-taskboard-view]')).not.toBeNull()
  })
})

describe('TaskBoard group sections', () => {
  const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', order: ['t1', 't2'], createdAt: 0, updatedAt: 0, offPeakOnly: false }

  async function renderBoard(snapshot: Partial<ControllerSnapshot>, overrides?: Partial<BoardController>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot, overrides)} />) })
    // The kanban lives behind the workspace list; open the All-tasks view.
    await openAllTasks(container)
    return { container }
  }

  it('renders a group banner with its member cards inside the column, separate from ungrouped cards', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't1', title: 'Member A', status: 'todo', groupId: 'g1' }),
        task({ id: 't2', title: 'Member B', status: 'todo', groupId: 'g1' }),
        task({ id: 't3', title: 'Lone', status: 'todo' }),
      ],
      groups: [GROUP],
    })

    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('Nightly')
    expect(section!.textContent).toContain(t('group.sequentialBadge'))
    const memberCards = section!.querySelectorAll('button[data-dsh-part="card"]')
    expect(memberCards).toHaveLength(2)

    // The ungrouped card lives outside the group section.
    const lone = Array.from(container.querySelectorAll('button[data-dsh-part="card"]')).find(card => card.textContent?.includes('Lone'))
    expect(lone?.closest('[data-group="g1"]')).toBeNull()
  })

  it('opens the group editor from the banner manage button', async () => {
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'todo', groupId: 'g1' })],
      groups: [GROUP],
    })
    const manage = container.querySelector(`button[aria-label="${t('group.manage')}"]`) as HTMLButtonElement
    expect(manage).not.toBeNull()
    await act(async () => { manage.click() })
    expect(container.textContent).toContain(t('group.edit'))
    expect(container.textContent).toContain(t('group.members'))
  })

  it('shows a new-group button in the header', async () => {
    const { container } = await renderBoard({ tasks: [], groups: [] })
    const button = Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent?.includes(t('board.newGroup')))
    expect(button).not.toBeNull()
    await act(async () => { button!.click() })
    expect(container.textContent).toContain(t('group.create'))
  })

  it('renders an empty group in the todo column so it stays visible', async () => {
    const { container } = await renderBoard({
      tasks: [],
      groups: [{ ...GROUP, order: [] }],
    })
    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('Nightly')
    expect(section!.textContent).toContain(t('group.emptyMembers'))
    // The empty group appears exactly once (in the todo column), not in every column.
    expect(container.querySelectorAll('[data-group="g1"]')).toHaveLength(1)
  })

  it('offers a per-member stop button for running members and stops the group from the banner', async () => {
    const stopCalls: string[] = []
    const stopGroupCalls: string[] = []
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'running', groupId: 'g1' })],
      groups: [GROUP],
    }, {
      stopTask: async (id: string) => { stopCalls.push(id); return true },
      stopGroup: async (id: string) => { stopGroupCalls.push(id); return true },
    })
    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    const stopMember = section!.querySelector(`button[aria-label="${t('group.stopMember')}"]`) as HTMLButtonElement
    expect(stopMember).not.toBeNull()
    await act(async () => { stopMember.click() })
    expect(stopCalls).toEqual(['t1'])
    const stopGroup = section!.querySelector(`button[aria-label="${t('group.stop')}"]`) as HTMLButtonElement
    expect(stopGroup).not.toBeNull()
    await act(async () => { stopGroup.click() })
    expect(stopGroupCalls).toEqual(['g1'])
  })

  it('shows a resume button and a stopped badge for a stopped group', async () => {
    const resumeCalls: string[] = []
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'todo', groupId: 'g1' })],
      groups: [{ ...GROUP, stopped: true }],
    }, {
      resumeGroup: async (id: string) => { resumeCalls.push(id); return true },
    })
    const section = container.querySelector('[data-group="g1"]')
    expect(section?.textContent).toContain(t('group.stopped'))
    const resume = section!.querySelector(`button[aria-label="${t('group.resume')}"]`) as HTMLButtonElement
    expect(resume).not.toBeNull()
    await act(async () => { resume.click() })
    expect(resumeCalls).toEqual(['g1'])
  })

  it('starts the whole group from the banner when a member is runnable', async () => {
    const runGroupCalls: string[] = []
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'todo', groupId: 'g1' })],
      groups: [GROUP],
    }, {
      runGroup: async (id: string) => { runGroupCalls.push(id); return true },
    })
    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    const start = section!.querySelector(`button[aria-label="${t('group.start')}"]`) as HTMLButtonElement
    expect(start).not.toBeNull()
    expect(start.disabled).toBe(false)
    await act(async () => { start.click() })
    expect(runGroupCalls).toEqual(['g1'])
  })

  it('disables the group start button when no member is runnable and hides it for a stopped group', async () => {
    // All members running: the start button is disabled (the Host also refuses).
    const running: { container: HTMLElement } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Running A', status: 'running', groupId: 'g1' })],
      groups: [GROUP],
    })
    let section = running.container.querySelector('[data-group="g1"]')
    let start = section!.querySelector(`button[aria-label="${t('group.start')}"]`) as HTMLButtonElement
    expect(start).not.toBeNull()
    expect(start.disabled).toBe(true)
    // A stopped group shows the resume button instead of the start button.
    const stopped: { container: HTMLElement } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'todo', groupId: 'g1' })],
      groups: [{ ...GROUP, stopped: true }],
    })
    section = stopped.container.querySelector('[data-group="g1"]')
    expect(section!.querySelector(`button[aria-label="${t('group.start')}"]`)).toBeNull()
    expect(section!.querySelector(`button[aria-label="${t('group.resume')}"]`)).not.toBeNull()
  })

  it('drops a dragged group banner onto a manual column and moves the whole group', async () => {
    const moveCalls: Array<{ id: string; status: string }> = []
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'todo', groupId: 'g1' })],
      groups: [GROUP],
    }, {
      moveGroup: (id: string, status: string) => { moveCalls.push({ id, status }); return Promise.resolve(true) },
    })
    const banner = container.querySelector('[data-group="g1"] [data-dsh-part="group"]') as HTMLElement
    expect(banner.getAttribute('draggable')).toBe('true')

    const backlogColumn = container.querySelector('section[data-status="backlog"]')
    const backlogCards = backlogColumn!.querySelector('[data-dsh-part="cards"]')
    expect(backlogCards).not.toBeNull()
    const dataTransfer = {
      data: { 'text/plain': 'group:g1' } as Record<string, string>,
      setData(type: string, val: string) { this.data[type] = val },
      getData(type: string) { return this.data[type] ?? '' },
      dropEffect: 'none',
    }
    await act(async () => {
      backlogCards!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
      )
    })
    expect(moveCalls).toEqual([{ id: 'g1', status: 'backlog' }])
  })
})

describe('TaskBoard start buttons', () => {
  async function renderBoard(snapshot: Partial<ControllerSnapshot>, overrides?: Partial<BoardController>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot, overrides)} />) })
    // The kanban lives behind the workspace list; open the All-tasks view.
    await openAllTasks(container)
    return { container }
  }

  it('shows a run button on a runnable todo card and starts it through the controller', async () => {
    const runCalls: string[] = []
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Ready', status: 'todo' })],
    }, {
      runTask: async (id: string) => { runCalls.push(id); return true },
    })
    const run = container.querySelector(`button[aria-label="${t('card.run')}"]`) as HTMLButtonElement
    expect(run).not.toBeNull()
    await act(async () => { run.click() })
    expect(runCalls).toEqual(['t1'])
  })

  it('offers a run button for runnable group members', async () => {
    const runCalls: string[] = []
    const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', order: ['t1'], createdAt: 0, updatedAt: 0, offPeakOnly: false }
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member', status: 'todo', groupId: 'g1' })],
      groups: [GROUP],
    }, {
      runTask: async (id: string) => { runCalls.push(id); return true },
    })
    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    const run = section!.querySelector(`button[aria-label="${t('card.run')}"]`) as HTMLButtonElement
    expect(run).not.toBeNull()
    await act(async () => { run.click() })
    expect(runCalls).toEqual(['t1'])
  })

  it('does not render a run button for running, done, unapproved, or archived tasks', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't1', title: 'Running', status: 'running' }),
        task({ id: 't2', title: 'Done', status: 'done' }),
        task({ id: 't3', title: 'Pending', status: 'todo', approved: false }),
        { ...task({ id: 't4', title: 'Archived', status: 'done' }), archivedAt: 1 },
      ],
    })
    expect(container.querySelector(`button[aria-label="${t('card.run')}"]`)).toBeNull()
  })
})

describe('TaskBoard workspace landing list', () => {
  async function renderBoard(snapshot: Partial<ControllerSnapshot>, overrides?: Partial<BoardController>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot, overrides)} />) })
    return { container }
  }

  const WORKSPACES = [
    { workspaceId: 'ws-a', title: 'Alpha' },
    { workspaceId: 'ws-b', title: 'Beta' },
  ]

  function listRows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('[data-dsh-part="workspace-card"]')) as HTMLElement[]
  }

  function listRow(container: HTMLElement, workspaceId: string): HTMLElement {
    const row = listRows(container).find(candidate => candidate.getAttribute('data-workspace') === workspaceId)
    expect(row, `workspace row ${workspaceId}`).toBeDefined()
    return row!
  }

  function cardsOf(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('button[data-dsh-part="card"]')).map(card => card.textContent ?? '')
  }

  function hasCard(container: HTMLElement, title: string): boolean {
    return cardsOf(container).some(text => text.includes(title))
  }

  /** The text of one aligned count cell (`data-col`) inside a workspace row. */
  function cellOf(row: HTMLElement, col: string): string {
    const cell = row.querySelector(`[data-col="${col}"]`)
    expect(cell, `count cell ${col}`).not.toBeNull()
    return (cell!.textContent ?? '').trim()
  }

  it('lands on the workspace list first: an All-tasks row plus one row per workspace, each with live counts', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't1', title: 'Do', status: 'todo', workspaceId: 'ws-a' }),
        task({ id: 't2', title: 'Review', status: 'todo', workspaceId: 'ws-a', approved: false }),
        task({ id: 't3', title: 'Run', status: 'running', workspaceId: 'ws-a' }),
        task({ id: 't4', title: 'Cron', status: 'todo', workspaceId: 'ws-a', schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: undefined, lastTriggeredAt: undefined } }),
        task({ id: 't5', title: 'Done', status: 'done', workspaceId: 'ws-a' }),
        task({ id: 't6', title: 'Boom', status: 'failed', workspaceId: 'ws-a' }),
        task({ id: 't7', title: 'Beta done', status: 'done', workspaceId: 'ws-b' }),
      ],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })

    // The first view is the list, not the kanban: no status columns yet.
    expect(container.querySelector('[data-dsh-part="workspace-list"]')).not.toBeNull()
    expect(container.querySelector('section[data-status]')).toBeNull()

    const rows = listRows(container)
    expect(rows.map(row => row.getAttribute('data-workspace'))).toEqual(['', 'ws-a', 'ws-b'])

    const all = listRow(container, '')
    expect(all.textContent).toContain(t('grid.allTasks'))
    // All counts every on-board task: 7 total (Cron is also scheduled).
    expect(cellOf(all, 'todo')).toBe('2')
    expect(cellOf(all, 'total')).toBe('7')

    const alpha = listRow(container, 'ws-a')
    expect(alpha.textContent).toContain('Alpha')
    // ws-a: total 6, todo 2 (Do + Cron), pending 1, working 1, scheduled 1, finished 1, failed 1.
    expect(cellOf(alpha, 'todo')).toBe('2')
    expect(cellOf(alpha, 'pending')).toBe('1')
    expect(cellOf(alpha, 'working')).toBe('1')
    expect(cellOf(alpha, 'scheduled')).toBe('1')
    expect(cellOf(alpha, 'finished')).toBe('1')
    expect(cellOf(alpha, 'failed')).toBe('1')
    expect(cellOf(alpha, 'total')).toBe('6')
  })

  it('opens the scoped kanban from a workspace card and collects unpinned tasks in an Unassigned section', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't-a', title: 'Pinned A', status: 'todo', workspaceId: 'ws-a' }),
        task({ id: 't-b', title: 'Pinned B', status: 'todo', workspaceId: 'ws-b' }),
        task({ id: 't-u', title: 'Unpinned', status: 'todo' }),
      ],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })

    await openWorkspace(container, 'ws-a')

    // Only ws-a's pinned task and the unpinned task remain.
    expect(hasCard(container, 'Pinned A')).toBe(true)
    expect(hasCard(container, 'Unpinned')).toBe(true)
    expect(hasCard(container, 'Pinned B')).toBe(false)

    // The unpinned task sits inside the Unassigned section, Pinned A outside it.
    const unassigned = container.querySelector('[data-dsh-part="unassigned"]')
    expect(unassigned).not.toBeNull()
    expect(unassigned!.textContent).toContain(t('board.unassigned'))
    expect(unassigned!.textContent).toContain('Unpinned')
    const pinnedACard = Array.from(container.querySelectorAll('button[data-dsh-part="card"]')).find(card => card.textContent?.includes('Pinned A'))
    expect(pinnedACard?.closest('[data-dsh-part="unassigned"]')).toBeNull()
  })

  it('keeps the general overview via the All-tasks card: every task visible, no Unassigned section', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't-a', title: 'Pinned A', status: 'todo', workspaceId: 'ws-a' }),
        task({ id: 't-b', title: 'Pinned B', status: 'todo', workspaceId: 'ws-b' }),
        task({ id: 't-u', title: 'Unpinned', status: 'todo' }),
      ],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })
    await openAllTasks(container)
    expect(hasCard(container, 'Pinned A')).toBe(true)
    expect(hasCard(container, 'Pinned B')).toBe(true)
    expect(hasCard(container, 'Unpinned')).toBe(true)
    expect(container.querySelector('[data-dsh-part="unassigned"]')).toBeNull()
  })

  it('the kanban back button returns to the workspace list and no workspace dropdown exists', async () => {
    const { container } = await renderBoard({
      tasks: [task({ id: 't-a', title: 'Pinned A', status: 'todo', workspaceId: 'ws-a' })],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })
    await openWorkspace(container, 'ws-a')
    expect(container.querySelector('section[data-status]')).not.toBeNull()
    // The workspace dropdown is gone from the kanban header (no selects at all).
    expect(container.querySelector('select')).toBeNull()

    const back = container.querySelector('button[data-dsh-center-view-back]') as HTMLButtonElement
    expect(back).not.toBeNull()
    await act(async () => { back.click() })
    // Back on the landing list; the columns are gone.
    expect(container.querySelector('[data-dsh-part="workspace-list"]')).not.toBeNull()
    expect(container.querySelector('section[data-status]')).toBeNull()
    expect(container.textContent).toContain('Alpha')
  })

  it('keeps groups whole in a scoped view: matching and unpinned members stay grouped, other workspaces drop out', async () => {
    const GROUP: TaskGroupRecord = {
      id: 'g1',
      name: 'Nightly',
      mode: 'sequential',
      order: ['t-a', 't-u', 't-b'],
      createdAt: 0,
      updatedAt: 0,
      offPeakOnly: false,
    }
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't-a', title: 'Member A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
        task({ id: 't-u', title: 'Member U', status: 'todo', groupId: 'g1' }),
        task({ id: 't-b', title: 'Member B', status: 'todo', workspaceId: 'ws-b', groupId: 'g1' }),
      ],
      groups: [GROUP],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })

    await openWorkspace(container, 'ws-a')

    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    const memberTitles = Array.from(section!.querySelectorAll('button[data-dsh-part="card"]')).map(card => card.textContent ?? '')
    expect(memberTitles.some(text => text.includes('Member A'))).toBe(true)
    expect(memberTitles.some(text => text.includes('Member U'))).toBe(true)
    expect(memberTitles.some(text => text.includes('Member B'))).toBe(false)
  })

  it('keeps workspaces pinned by tasks but missing from the runtime list visible in the grid', async () => {
    const { container } = await renderBoard({
      tasks: [task({ id: 't-g', title: 'Ghost pinned', status: 'todo', workspaceId: 'ws-gone' })],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })
    const ghost = listRow(container, 'ws-gone')
    expect(ghost.textContent).toContain('ws-gone')
    expect(cellOf(ghost, 'todo')).toBe('1')
    await openWorkspace(container, 'ws-gone')
    expect(hasCard(container, 'Ghost pinned')).toBe(true)
  })

  it('opens the workspace defaults editor from a card settings button and saves through the controller', async () => {
    const setWorkspaceDefaults = vi.fn<(workspaceId: string, patch: WorkspaceDefaultsPatch) => Promise<boolean>>(async () => true)
    const { container } = await renderBoard({
      tasks: [],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    }, {
      setWorkspaceDefaults,
    })
    const alpha = listRow(container, 'ws-a')
    const settings = alpha.querySelector(`button[aria-label="${t('grid.workspaceSettings')}"]`) as HTMLButtonElement
    expect(settings).not.toBeNull()
    await act(async () => { settings.click() })

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain(t('grid.settingsTitle'))
    expect(dialog!.textContent).toContain(t('grid.settingsHint'))

    // Default unapproved for this workspace, then save: the editor sends the
    // full desired state (blank fields as explicit null clears).
    const checkbox = dialog!.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { checkbox.click() })
    const submit = dialog!.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })

    expect(setWorkspaceDefaults).toHaveBeenCalledOnce()
    expect(setWorkspaceDefaults.mock.calls[0][0]).toBe('ws-a')
    expect(setWorkspaceDefaults.mock.calls[0][1]).toEqual({
      mode: null,
      model: null,
      endpoints: null,
      permission: null,
      approved: false,
    })
  })
})

describe('TaskBoard approval', () => {
  async function renderBoard(snapshot: Partial<ControllerSnapshot>, overrides?: Partial<BoardController>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot, overrides)} />) })
    // The kanban lives behind the workspace list; open the All-tasks view.
    await openAllTasks(container)
    return { container }
  }

  function hasCard(container: HTMLElement, title: string): boolean {
    return Array.from(container.querySelectorAll('button[data-dsh-part="card"]')).some(card => (card.textContent ?? '').includes(title))
  }

  it('shows a Not-approved badge and a one-click approve button on an unapproved ungrouped card', async () => {
    const approveCalls: string[] = []
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Pending', status: 'todo', approved: false })],
    }, {
      setApproved: (id: string, approved: boolean) => { if (approved) approveCalls.push(id) },
    })

    const card = Array.from(container.querySelectorAll('button[data-dsh-part="card"]')).find(candidate => candidate.textContent?.includes('Pending'))
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain(t('card.unapproved'))
    expect(card!.textContent).not.toContain(t('card.approved'))
    const approve = container.querySelector(`button[aria-label="${t('card.approve')}"]`) as HTMLButtonElement
    expect(approve).not.toBeNull()
    await act(async () => { approve.click() })
    expect(approveCalls).toEqual(['t1'])
  })

  it('offers a per-member approve button inside a group section', async () => {
    const approveCalls: string[] = []
    const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', order: ['t1'], createdAt: 0, updatedAt: 0, offPeakOnly: false }
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member', status: 'todo', groupId: 'g1', approved: false })],
      groups: [GROUP],
    }, {
      setApproved: (id: string, approved: boolean) => { if (approved) approveCalls.push(id) },
    })
    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    const approve = section!.querySelector(`button[aria-label="${t('card.approve')}"]`) as HTMLButtonElement
    expect(approve).not.toBeNull()
    await act(async () => { approve.click() })
    expect(approveCalls).toEqual(['t1'])
  })

  it('does not render an approve button for an approved task', async () => {
    const { container } = await renderBoard({ tasks: [task({ id: 't1', title: 'Fine', status: 'todo' })] })
    expect(container.querySelector(`button[aria-label="${t('card.approve')}"]`)).toBeNull()
    const card = Array.from(container.querySelectorAll('button[data-dsh-part="card"]')).find(candidate => candidate.textContent?.includes('Fine'))
    expect(card!.textContent).not.toContain(t('card.unapproved'))
    expect(card!.textContent).toContain(t('card.approved'))
  })

  it('filters the board to unapproved tasks only', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't1', title: 'Pending', status: 'todo', approved: false }),
        task({ id: 't2', title: 'Approved task', status: 'todo' }),
      ],
    })
    expect(hasCard(container, 'Approved task')).toBe(true)
    expect(hasCard(container, 'Pending')).toBe(true)

    const toggle = Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent?.includes(t('board.unapprovedFilter'))) as HTMLButtonElement
    expect(toggle).not.toBeNull()
    await act(async () => { toggle.click() })
    expect(hasCard(container, 'Approved task')).toBe(false)
    expect(hasCard(container, 'Pending')).toBe(true)
    await act(async () => { toggle.click() })
    expect(hasCard(container, 'Approved task')).toBe(true)
  })
})

describe('TaskBoard drag reorder, group join/leave (#drag)', () => {
  async function renderBoard(snapshot: Partial<ControllerSnapshot>, overrides?: Partial<BoardController>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot, overrides)} />) })
    // The kanban lives behind the workspace list; open the All-tasks view.
    await openAllTasks(container)
    return { container }
  }

  /** Dispatch a synthetic drop on `target` with the given payload + pointer Y. */
  function dropOn(target: HTMLElement, payload: string, clientY = 0): void {
    const dataTransfer = {
      data: { 'text/plain': payload } as Record<string, string>,
      setData(type: string, val: string) { this.data[type] = val },
      getData(type: string) { return this.data[type] ?? '' },
      dropEffect: 'none',
    }
    act(() => {
      target.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer, clientY }),
      )
    })
  }

  /** Force a card's vertical midpoint so the insertion math is deterministic. */
  function stubCardRect(container: HTMLElement, taskId: string, top: number, height: number): void {
    const card = container.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement
    card.getBoundingClientRect = () => ({
      top, height, left: 0, right: 200, bottom: top + height, x: 0, y: top,
      width: 200, toJSON: () => ({}),
    })
  }

  it('drops an ungrouped task onto a group section and joins the group', async () => {
    const updates: Array<{ id: string; patch: { groupId: string | null } }> = []
    const { container } = await renderBoard({
      tasks: [task({ id: 't-joiner', title: 'Joiner', status: 'todo' })],
      groups: [{ id: 'g1', name: 'Nightly', mode: 'sequential', order: [], createdAt: 0, updatedAt: 0, offPeakOnly: false }],
    }, {
      updateTask: async (id: string, patch: { groupId: string | null }) => { updates.push({ id, patch }); return true },
    })
    const section = container.querySelector('[data-group="g1"]') as HTMLElement
    expect(section).not.toBeNull()
    dropOn(section, 'task:t-joiner')
    expect(updates).toEqual([{ id: 't-joiner', patch: { groupId: 'g1' } }])
  })

  it('drops a group member onto the column background and ungroups it', async () => {
    const updates: Array<{ id: string; patch: { groupId: string | null } }> = []
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't-member', title: 'Member', status: 'todo', groupId: 'g1' }),
        task({ id: 't-other', title: 'Other', status: 'todo' }),
      ],
      groups: [{ id: 'g1', name: 'Nightly', mode: 'sequential', order: ['t-member'], createdAt: 0, updatedAt: 0, offPeakOnly: false }],
    }, {
      updateTask: async (id: string, patch: { groupId: string | null }) => { updates.push({ id, patch }); return true },
    })
    const cards = container.querySelector('section[data-status="todo"] [data-dsh-part="cards"]') as HTMLElement
    expect(cards).not.toBeNull()
    dropOn(cards, 'task:t-member')
    expect(updates).toEqual([{ id: 't-member', patch: { groupId: null } }])
  })

  it('drops an ungrouped card above another and reorders it', async () => {
    const reorders: Array<{ id: string; before: string | undefined }> = []
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't-a', title: 'Alpha', status: 'todo' }),
        task({ id: 't-b', title: 'Beta', status: 'todo' }),
      ],
    }, {
      reorderTask: (id: string, before: string | undefined) => { reorders.push({ id, before }) },
    })
    // Beta's midpoint sits at 100 + 40/2 = 120; drop Alpha at y=100 (above it).
    stubCardRect(container, 't-b', 100, 40)
    const cards = container.querySelector('section[data-status="todo"] [data-dsh-part="cards"]') as HTMLElement
    dropOn(cards, 'task:t-a', 100)
    expect(reorders).toEqual([{ id: 't-a', before: 't-b' }])
  })

  it('drops a member above a sibling and reorders the whole group', async () => {
    const orders: Array<{ groupId: string; order: string[] }> = []
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't1', title: 'One', status: 'todo', groupId: 'g1' }),
        task({ id: 't2', title: 'Two', status: 'todo', groupId: 'g1' }),
      ],
      groups: [{ id: 'g1', name: 'Nightly', mode: 'sequential', order: ['t1', 't2'], createdAt: 0, updatedAt: 0, offPeakOnly: false }],
    }, {
      setGroupOrder: async (groupId: string, order: string[]) => { orders.push({ groupId, order }); return true },
    })
    // One's midpoint sits at 100 + 40/2 = 120; drop Two at y=100 (above One).
    stubCardRect(container, 't1', 100, 40)
    const section = container.querySelector('[data-group="g1"]') as HTMLElement
    dropOn(section, 'task:t2', 100)
    expect(orders).toEqual([{ groupId: 'g1', order: ['t2', 't1'] }])
  })
})

describe('TaskBoard workspace directory (expandable landing)', () => {
  async function renderBoard(snapshot: Partial<ControllerSnapshot>, overrides?: Partial<BoardController>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot, overrides)} />) })
    return { container }
  }

  function rowOf(container: HTMLElement, workspaceId: string): HTMLElement {
    const row = Array.from(container.querySelectorAll('[data-dsh-part="workspace-card"]') as NodeListOf<HTMLElement>)
      .find(candidate => candidate.getAttribute('data-workspace') === workspaceId)
    expect(row, `workspace row ${workspaceId}`).toBeDefined()
    return row!
  }

  function chevronOf(row: HTMLElement): HTMLButtonElement {
    const chevron = row.querySelector(`button[aria-label="${t('list.expand')}"], button[aria-label="${t('list.collapse')}"]`) as HTMLButtonElement
    expect(chevron, 'chevron button').not.toBeNull()
    return chevron
  }

  const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', order: ['t1', 't2'], createdAt: 0, updatedAt: 0, offPeakOnly: false }
  const ALPHA_ONLY = { workspaces: [{ workspaceId: 'ws-a', title: 'Alpha' }], presets: [], models: [], endpoints: [] }

  it('expands a workspace into its group band and task rows, and opens a task from a row', async () => {
    const openCalls: string[] = []
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't1', title: 'Member A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
        task({ id: 't2', title: 'Member B', status: 'done', workspaceId: 'ws-a', groupId: 'g1' }),
        task({ id: 't3', title: 'Lone', status: 'todo', workspaceId: 'ws-a' }),
      ],
      groups: [GROUP],
      executionOptions: ALPHA_ONLY,
    }, {
      openTask: (id: string) => { openCalls.push(id) },
    })

    // Collapsed: no group bands yet.
    expect(container.querySelector('[data-dsh-part="workspace-group"]')).toBeNull()

    await act(async () => { chevronOf(rowOf(container, 'ws-a')).click() })

    const bands = container.querySelectorAll('[data-dsh-part="workspace-group"]')
    expect(bands).toHaveLength(2) // the Nightly band plus the ungrouped band
    const group = container.querySelector('[data-group="g1"]') as HTMLElement
    expect(group).not.toBeNull()
    expect(group.textContent).toContain('Nightly')
    expect(group.textContent).toContain(t('group.sequentialBadge'))
    const rows = group.querySelectorAll('[data-dsh-part="task-row"]')
    expect(rows).toHaveLength(2)
    expect(Array.from(rows).map(row => row.textContent).join(' ')).toContain('Member A')

    // Clicking a task row opens its detail through the controller.
    const memberRow = Array.from(rows).find(row => row.textContent?.includes('Member A')) as HTMLButtonElement
    await act(async () => { memberRow.click() })
    expect(openCalls).toEqual(['t1'])
  })

  it('collapses the directory again via the chevron', async () => {
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' })],
      groups: [GROUP],
      executionOptions: ALPHA_ONLY,
    })
    const row = rowOf(container, 'ws-a')
    await act(async () => { chevronOf(row).click() })
    expect(container.querySelector('[data-dsh-part="workspace-group"]')).not.toBeNull()
    await act(async () => { chevronOf(row).click() })
    expect(container.querySelector('[data-dsh-part="workspace-group"]')).toBeNull()
  })

  it('expands the All-tasks row across every workspace, and an empty workspace shows a hint', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't1', title: 'Pinned A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' }),
        task({ id: 't2', title: 'Pinned B', status: 'todo', workspaceId: 'ws-b' }),
      ],
      groups: [GROUP],
      executionOptions: {
        workspaces: [
          { workspaceId: 'ws-a', title: 'Alpha' },
          { workspaceId: 'ws-b', title: 'Beta' },
          { workspaceId: 'ws-empty', title: 'Empty' },
        ],
        presets: [],
        models: [],
        endpoints: [],
      },
    })

    await act(async () => { chevronOf(rowOf(container, '')).click() })
    expect(container.querySelector('[data-group="g1"]')?.textContent).toContain('Pinned A')
    expect(container.textContent).toContain('Pinned B')

    // ws-empty has nothing on board: expanding shows the quiet hint.
    await act(async () => { chevronOf(rowOf(container, 'ws-empty')).click() })
    expect(container.textContent).toContain(t('list.noTasks'))
  })

  it('chevron toggling never opens the kanban', async () => {
    const { container } = await renderBoard({
      tasks: [task({ id: 't1', title: 'Member A', status: 'todo', workspaceId: 'ws-a', groupId: 'g1' })],
      groups: [GROUP],
      executionOptions: ALPHA_ONLY,
    })
    await act(async () => { chevronOf(rowOf(container, 'ws-a')).click() })
    // Still on the landing directory, not the kanban columns.
    expect(container.querySelector('[data-dsh-part="workspace-list"]')).not.toBeNull()
    expect(container.querySelector('section[data-status]')).toBeNull()
  })
})
