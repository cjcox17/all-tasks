// @vitest-environment jsdom
/**
 * Hide-old-tasks UI: the Done/Failed column headers carry an archive-icon
 * button (the same official DSH "Archive session" glyph the sidebar rows
 * use) whose dialog lists the settled tasks, defaults the session-archive
 * option on, and confirms through controller.hideSettledTasks.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AllTasks } from '../src/client/board/AllTasks.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
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

function task(id: string, status: TaskRecord['status'], sessionIds: string[] = []): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    prompt: 'do it',
    status,
    createdAt: 1,
    updatedAt: 2,
    executions: sessionIds.map((sessionId, index) => ({
      id: `${id}-e${index}`,
      sessionId,
      startedAt: 3 + index,
      endedAt: 4 + index,
      result: 'succeeded' as const,
      error: undefined,
    })),
  }
}

function group(overrides: Partial<TaskGroupRecord> = {}): TaskGroupRecord {
  return {
    id: 'g1',
    name: 'Group A',
    mode: 'sequential',
    offPeakOnly: false,
    order: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function fakeController(
  snapshot: Partial<ControllerSnapshot> = {},
  overrides: Partial<BoardController> = {},
): BoardController {
  const state: ControllerSnapshot = {
    tasks: [],
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
    retryHostSync: async () => true,
    openTask: () => {},
    openAll: () => {},
    ...overrides,
  } as unknown as BoardController
}

/** Open the All-tasks kanban from the landing list (the list is the first view). */
async function openAllTasks(container: HTMLElement): Promise<void> {
  const wrap = Array.from(container.querySelectorAll('[data-dsh-part="workspace-card"]'))
    .find(card => card.getAttribute('data-workspace') === '') as HTMLElement | undefined
  expect(wrap, 'All-tasks card').toBeDefined()
  const card = wrap!.querySelector('button[data-dsh-part="workspace-name"]') as HTMLButtonElement
  await act(async () => { card.click() })
}

describe('AllTasks hide-old-tasks', () => {
  it('shows an archive-icon hide button on the Done column only when settled tasks are present', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const controller = fakeController({
      tasks: [task('done-1', 'done', ['session-1']), task('todo-1', 'todo')],
    })
    await act(async () => { root.render(<AllTasks controller={controller} />) })
    await openAllTasks(container)

    const doneColumn = container.querySelector('section[data-status="done"]')
    expect(doneColumn).not.toBeNull()
    const doneHide = Array.from(doneColumn!.querySelectorAll('button'))
      .find(button => button.getAttribute('aria-label') === t('hide.columnLabel', { count: '1' }))
    expect(doneHide).toBeDefined()
    // Icon-only: the official DSH archive glyph, no visible "Hide" text.
    expect(doneHide!.querySelector('svg')).not.toBeNull()
    expect(doneHide!.getAttribute('aria-label')).toBe(t('hide.columnLabel', { count: '1' }))

    const todoColumn = container.querySelector('section[data-status="todo"]')
    expect(todoColumn!.querySelector('button[data-dsh-part="task-hide"]')).toBeNull()
  })

  it('opens the dialog listing the tasks with the session-archive option defaulted on, then hides', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const hide = vi.fn(async () => true)
    const done = task('done-1', 'done', ['session-1'])
    const failed = task('failed-1', 'failed', ['session-2'])
    const controller = fakeController(
      { tasks: [done, failed] },
      { hideSettledTasks: hide },
    )
    await act(async () => { root.render(<AllTasks controller={controller} />) })
    await openAllTasks(container)

    const doneHide = Array.from(container
      .querySelector('section[data-status="done"]')!
      .querySelectorAll('button'))
      .find(button => button.getAttribute('aria-label') === t('hide.columnLabel', { count: '1' }))!
    await act(async () => { doneHide.click() })

    const modal = container.querySelector('[role="alertdialog"]')
    expect(modal).not.toBeNull()
    expect(modal!.textContent).toContain('Task done-1')
    expect(modal!.textContent).not.toContain('Task failed-1')
    // The session-archive checkbox is offered (there is one session) and on by
    // default.
    const checkbox = modal!.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(true)

    const confirm = Array.from(modal!.querySelectorAll('button'))
      .find(button => button.textContent === t('hide.confirm', { count: '1' }))!
    // A successful hide closes the dialog only after the async confirm
    // settles; keep the act() open so the post-await state updates (busy off,
    // dialog closed) flush inside it.
    await act(async () => {
      confirm.click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(hide).toHaveBeenCalledWith(['done-1'], true)
    // A successful hide closes the dialog.
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('unchecking the option hides without archiving sessions, and cancel keeps everything', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const hide = vi.fn(async () => true)
    const done = task('done-1', 'done', ['session-1'])
    const controller = fakeController({ tasks: [done] }, { hideSettledTasks: hide })
    await act(async () => { root.render(<AllTasks controller={controller} />) })
    await openAllTasks(container)

    const doneHide = Array.from(container
      .querySelector('section[data-status="done"]')!
      .querySelectorAll('button'))
      .find(button => button.getAttribute('aria-label') === t('hide.columnLabel', { count: '1' }))!
    await act(async () => { doneHide.click() })

    const checkbox = container.querySelector('[role="alertdialog"] input[type="checkbox"]') as HTMLInputElement
    await act(async () => { checkbox.click() })
    expect(checkbox.checked).toBe(false)
    const cancel = Array.from(container.querySelector('[role="alertdialog"]')!.querySelectorAll('button'))
      .find(button => button.textContent === t('delete.cancel'))!
    await act(async () => { cancel.click() })
    expect(hide).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()

    // Reopen and confirm with the checkbox off: hide without session archiving.
    await act(async () => { doneHide.click() })
    const unchecked = container.querySelector('[role="alertdialog"] input[type="checkbox"]') as HTMLInputElement
    expect(unchecked.checked).toBe(true) // fresh dialog defaults back on
    await act(async () => { unchecked.click() })
    const confirm = Array.from(container.querySelector('[role="alertdialog"]')!.querySelectorAll('button'))
      .find(button => button.textContent === t('hide.confirm', { count: '1' }))!
    // Keep act() open until the async confirm settles (busy off, dialog closed
    // if accepted) so no state update lands outside the act scope.
    await act(async () => {
      confirm.click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(hide).toHaveBeenCalledWith(['done-1'], false)
  })
})

describe('AllTasks hide from a group banner', () => {
  it("hides only that group's settled members in the column", async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const hide = vi.fn(async () => true)
    const member = { ...task('done-1', 'done', ['session-1']), groupId: 'g1' }
    const other = task('done-2', 'done', ['session-2'])
    const g1 = group({ order: ['done-1'] })
    const controller = fakeController(
      { tasks: [member, other], groups: [g1] },
      { hideSettledTasks: hide },
    )
    await act(async () => { root.render(<AllTasks controller={controller} />) })
    await openAllTasks(container)

    const groupSection = container.querySelector('section[data-status="done"] [data-group="g1"]')
    expect(groupSection).not.toBeNull()
    const groupHide = Array.from(groupSection!.querySelectorAll('button'))
      .find(button => button.getAttribute('aria-label') === t('hide.groupLabel', { count: '1' }))!
    expect(groupHide.querySelector('svg')).not.toBeNull()
    expect(groupHide.getAttribute('aria-label')).toBe(t('hide.groupLabel', { count: '1' }))
    await act(async () => { groupHide.click() })

    const modal = container.querySelector('[role="alertdialog"]')
    expect(modal).not.toBeNull()
    // Only the group's member is offered — the column's ungrouped done task
    // stays out of this dialog.
    expect(modal!.textContent).toContain('Task done-1')
    expect(modal!.textContent).not.toContain('Task done-2')

    const confirm = Array.from(modal!.querySelectorAll('button'))
      .find(button => button.textContent === t('hide.confirm', { count: '1' }))!
    // Keep act() open until the async confirm settles (busy off, dialog closed
    // if accepted) so no state update lands outside the act scope.
    await act(async () => {
      confirm.click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(hide).toHaveBeenCalledWith(['done-1'], true)
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('shows no hide control on a group whose members in the column are not settled', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const backlogMember = { ...task('b1', 'todo'), groupId: 'g1' }
    const g1 = group({ order: ['b1'] })
    const controller = fakeController({
      tasks: [backlogMember],
      groups: [g1],
    })
    await act(async () => { root.render(<AllTasks controller={controller} />) })
    await openAllTasks(container)

    const todoColumn = container.querySelector('section[data-status="todo"]')
    const todoGroupSection = todoColumn!.querySelector('[data-group="g1"]')
    expect(todoGroupSection).not.toBeNull()
    expect(todoGroupSection!.querySelector('button[data-dsh-part="task-hide"]')).toBeNull()
  })
})

describe('AllTasks hide from a task card', () => {
  it('hides a single settled card through its own dialog', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const hide = vi.fn(async () => true)
    const doneA = task('done-a', 'done', ['session-a'])
    const doneB = task('done-b', 'done', ['session-b'])
    const controller = fakeController({ tasks: [doneA, doneB] }, { hideSettledTasks: hide })
    await act(async () => { root.render(<AllTasks controller={controller} />) })
    await openAllTasks(container)

    const doneColumn = container.querySelector('section[data-status="done"]')!
    const cardA = doneColumn.querySelector('[data-task-id="done-a"]') as HTMLElement
    const hidePills = Array.from(cardA.parentElement!.querySelectorAll('button'))
      .filter(button => button.getAttribute('aria-label') === t('hide.taskTitle'))
    expect(hidePills).toHaveLength(1)
    // Overlaid inside the card (a sibling in the DOM), carrying the archive glyph.
    expect(hidePills[0].querySelector('svg')).not.toBeNull()
    await act(async () => { hidePills[0].click() })

    const modal = container.querySelector('[role="alertdialog"]')
    expect(modal).not.toBeNull()
    expect(modal!.textContent).toContain('Task done-a')
    expect(modal!.textContent).not.toContain('Task done-b')

    const confirm = Array.from(modal!.querySelectorAll('button'))
      .find(button => button.textContent === t('hide.confirm', { count: '1' }))!
    // Keep act() open until the async confirm settles (busy off, dialog closed
    // if accepted) so no state update lands outside the act scope.
    await act(async () => {
      confirm.click()
      await new Promise(resolve => { setTimeout(resolve, 0) })
    })
    expect(hide).toHaveBeenCalledWith(['done-a'], true)
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('keeps cards of unsettled tasks without a hide control', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const controller = fakeController({
      tasks: [task('todo-1', 'todo'), task('running-1', 'running')],
    })
    await act(async () => { root.render(<AllTasks controller={controller} />) })
    await openAllTasks(container)

    expect(container.querySelector('[aria-label="' + t('hide.taskTitle') + '"]')).toBeNull()
  })
})
