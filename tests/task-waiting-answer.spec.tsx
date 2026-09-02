// @vitest-environment jsdom
/**
 * "Waiting for your answer" on the board: a running task whose execution
 * session asked the human a question (an open ask_user_question) shows a
 * distinct state on its card and its detail execution row, and clicking the
 * waiting card opens that session to answer.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AllTasks } from '../src/client/board/AllTasks.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
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
    updatedAt: Date.now(),
    executions: [],
    ...overrides,
  }
}

function runningTask(id: string, sessionId: string): TaskRecord {
  return task({
    id,
    title: id,
    status: 'running',
    executions: [{ id: `${id}-e1`, sessionId, startedAt: 0, endedAt: undefined, result: undefined, error: undefined }],
  })
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
    workspacePaused: {},
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
    openSession: () => {},
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
    runWorkspace: async () => {},
    pauseWorkspace: async () => {},
    stopWorkspace: async () => {},
    ...overrides,
  } as unknown as BoardController
}

/** Open the All-tasks kanban from the landing list. */
async function openAllTasks(container: HTMLElement): Promise<void> {
  const wrap = Array.from(container.querySelectorAll('[data-dsh-part="workspace-card"]'))
    .find(card => card.getAttribute('data-workspace') === '') as HTMLElement | undefined
  expect(wrap, 'All-tasks card').toBeDefined()
  const card = wrap!.querySelector('button[data-dsh-part="workspace-name"]') as HTMLButtonElement
  await act(async () => { card.click() })
}

function mount(controller: BoardController): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<AllTasks controller={controller} />) })
  return container
}

describe('AllTasks waiting-for-your-answer state', () => {
  it('marks the waiting card and opens its session on click; other running cards open the detail', async () => {
    const waiting = runningTask('t-waiting', 's-9')
    const plain = runningTask('t-running', 's-2')
    const openDetail = vi.fn()
    const openSession = vi.fn()
    const controller = fakeController({
      tasks: [waiting, plain],
      sessionQuestions: { 's-9': { askedAt: 0, count: 1, summary: 'Shall I proceed?' } },
    }, { openTask: openDetail, openSession })
    const container = mount(controller)
    await openAllTasks(container)

    const cards = Array.from(container.querySelectorAll<HTMLElement>('button[data-dsh-part="card"]'))
    const waitingCard = cards.find(card => card.getAttribute('data-task-id') === 't-waiting')
    const plainCard = cards.find(card => card.getAttribute('data-task-id') === 't-running')
    expect(waitingCard).toBeDefined()
    expect(plainCard).toBeDefined()

    // The waiting card carries the data-waiting marker, its pill, and a
    // question tooltip; the plain running card does not.
    expect(waitingCard!.getAttribute('data-waiting')).toBe('true')
    expect(waitingCard!.textContent).toContain(t('card.waitingAnswer'))
    expect(waitingCard!.getAttribute('title')).toContain('Shall I proceed?')
    expect(plainCard!.getAttribute('data-waiting')).toBeNull()
    expect(plainCard!.textContent).not.toContain(t('card.waitingAnswer'))
    expect(plainCard!.textContent).toContain(t('detail.result.running'))

    // Clicking the waiting card answers straight from the session.
    await act(async () => { (waitingCard as HTMLButtonElement).click() })
    expect(openSession).toHaveBeenCalledWith('s-9')
    expect(openDetail).not.toHaveBeenCalled()

    // A plain running card still opens the task detail.
    await act(async () => { (plainCard as HTMLButtonElement).click() })
    expect(openDetail).toHaveBeenCalledWith('t-running')
    expect(openSession).toHaveBeenCalledTimes(1)
  })

  it('shows the waiting state on the open execution row of the task detail', () => {
    const waiting = runningTask('t-waiting', 's-9')
    const controller = fakeController({
      selectedTaskId: 't-waiting',
      tasks: [waiting],
      sessionQuestions: { 's-9': { askedAt: 0, count: 1, summary: 'Shall I proceed?' } },
    })
    const container = mount(controller)

    const row = container.querySelector('li[data-waiting]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain(t('detail.result.waitingAnswer'))
  })
})
