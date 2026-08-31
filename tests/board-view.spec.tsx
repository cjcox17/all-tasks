// @vitest-environment jsdom
/**
 * L2 semantic attributes of the board view (issue #506): the mounted board
 * container, the board root, every status column, and every task card opt
 * into the semantic-attrs/v1 enum (data-dsh-plugin / data-dsh-part) so skins
 * can target them without hash-class selectors.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { mountBoard } from '../src/client/board-mount.tsx'
import { TaskBoard } from '../src/client/board/TaskBoard.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

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
    groups: [],
    pendingTaskIds: [],
    ...snapshot,
  }
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    closeBoard: () => {},
    toggleArchiveView: () => {},
    retryHostSync: async () => {},
    openTask: () => {},
    moveTask: () => {},
    groupMembers: (id: string) => state.tasks.filter(t => t.groupId === id),
    createGroupConfirmed: async () => undefined,
    updateGroup: async () => true,
    deleteGroup: async () => true,
    setGroupOrder: async () => true,
    ...overrides,
  } as unknown as BoardController
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

    const todoColumn = container.querySelector('section[data-status="todo"]')
    expect(todoColumn).not.toBeNull()

    // Simulate drag and drop
    const dataTransfer = {
      data: { 'text/plain': 't-backlog' } as Record<string, string>,
      setData(type: string, val: string) { this.data[type] = val },
      getData(type: string) { return this.data[type] ?? '' },
      dropEffect: 'none',
    }

    await act(async () => {
      todoColumn!.dispatchEvent(
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

    const todoColumn = container.querySelector('section[data-status="todo"]')

    // Dropping on the same column does nothing
    const sameColTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-todo' : ''),
    }
    await act(async () => {
      todoColumn!.dispatchEvent(
        Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer: sameColTransfer }),
      )
    })
    expect(moveCalls).toHaveLength(0)

    // Dropping a running task does nothing
    const runningTransfer = {
      getData: (type: string) => (type === 'text/plain' ? 't-running' : ''),
    }
    await act(async () => {
      todoColumn!.dispatchEvent(
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

  async function renderBoard(snapshot: Partial<ControllerSnapshot>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot)} />) })
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
})

describe('TaskBoard workspace scoping', () => {
  async function renderBoard(snapshot: Partial<ControllerSnapshot>): Promise<{ container: HTMLElement }> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => { root.render(<TaskBoard controller={fakeController(snapshot)} />) })
    return { container }
  }

  const WORKSPACES = [
    { workspaceId: 'ws-a', title: 'Alpha' },
    { workspaceId: 'ws-b', title: 'Beta' },
  ]

  function workspaceSelect(container: HTMLElement): HTMLSelectElement {
    const select = container.querySelector(`select[aria-label="${t('board.workspaceFilter')}"]`)
    expect(select).not.toBeNull()
    return select as HTMLSelectElement
  }

  function cardsOf(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('button[data-dsh-part="card"]')).map(card => card.textContent ?? '')
  }

  function hasCard(container: HTMLElement, title: string): boolean {
    return cardsOf(container).some(text => text.includes(title))
  }

  it('offers an all-workspaces default plus one option per known workspace', async () => {
    const { container } = await renderBoard({
      tasks: [],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })
    const select = workspaceSelect(container)
    expect(select.value).toBe('')
    expect(Array.from(select.options).map(option => option.textContent)).toEqual([
      t('board.allWorkspaces'),
      'Alpha',
      'Beta',
    ])
  })

  it('keeps the general overview by default: every task visible, no Unassigned section', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't-a', title: 'Pinned A', status: 'todo', workspaceId: 'ws-a' }),
        task({ id: 't-b', title: 'Pinned B', status: 'todo', workspaceId: 'ws-b' }),
        task({ id: 't-u', title: 'Unpinned', status: 'todo' }),
      ],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })
    expect(hasCard(container, 'Pinned A')).toBe(true)
    expect(hasCard(container, 'Pinned B')).toBe(true)
    expect(hasCard(container, 'Unpinned')).toBe(true)
    expect(container.querySelector('[data-dsh-part="unassigned"]')).toBeNull()
  })

  it('scopes the board to one workspace and collects unpinned tasks in an Unassigned section', async () => {
    const { container } = await renderBoard({
      tasks: [
        task({ id: 't-a', title: 'Pinned A', status: 'todo', workspaceId: 'ws-a' }),
        task({ id: 't-b', title: 'Pinned B', status: 'todo', workspaceId: 'ws-b' }),
        task({ id: 't-u', title: 'Unpinned', status: 'todo' }),
      ],
      executionOptions: { workspaces: WORKSPACES, presets: [], models: [], endpoints: [] },
    })

    const select = workspaceSelect(container)
    await act(async () => {
      select.value = 'ws-a'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

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

    const select = workspaceSelect(container)
    await act(async () => {
      select.value = 'ws-a'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const section = container.querySelector('[data-group="g1"]')
    expect(section).not.toBeNull()
    const memberTitles = Array.from(section!.querySelectorAll('button[data-dsh-part="card"]')).map(card => card.textContent ?? '')
    expect(memberTitles.some(text => text.includes('Member A'))).toBe(true)
    expect(memberTitles.some(text => text.includes('Member U'))).toBe(true)
    expect(memberTitles.some(text => text.includes('Member B'))).toBe(false)
  })
})
