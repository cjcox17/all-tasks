// @vitest-environment jsdom
/**
 * The new-task modal's model pin: picking a model reveals the reasoning-effort
 * picker, and the submitted model selection carries the chosen effort level
 * (or none for the deployment default).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewTaskModal } from '../src/client/board/NewTaskModal.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot, ExecutionModelOption } from '../src/core/controller.ts'
import { createTask, modelSelectionKey, type NewTaskInput, type TaskRecord } from '../src/core/tasks.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
})

const MODELS: readonly ExecutionModelOption[] = [
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat' },
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-reasoner' },
]

function fakeController(createTaskConfirmed: (input: NewTaskInput) => Promise<TaskRecord | undefined>): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: MODELS },
    pendingTaskIds: [],
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    createTaskConfirmed,
  } as unknown as BoardController
}

async function renderModal(createTaskConfirmed: (input: NewTaskInput) => Promise<TaskRecord | undefined>): Promise<{
  container: HTMLElement
  onClose: ReturnType<typeof vi.fn>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const onClose = vi.fn()
  await act(async () => {
    root.render(<NewTaskModal controller={fakeController(createTaskConfirmed)} onClose={onClose} />)
  })
  return { container, onClose }
}

function selectOf(container: HTMLElement, optionValue: string): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find(candidate =>
    [...candidate.querySelectorAll('option')].some(option => option.value === optionValue))
  expect(select, `select with option ${optionValue}`).toBeDefined()
  return select as HTMLSelectElement
}

function setSelect(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function setFieldValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('NewTaskModal model + reasoning-effort pin', () => {
  it('reveals the effort picker only after a model is pinned', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'))
    const effortLabel = t('new.model.effort')
    expect(container.querySelector(`select[aria-label="${effortLabel}"]`)).toBeNull()

    const modelKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    await act(async () => { setSelect(selectOf(container, modelKey), modelKey) })
    expect(container.querySelector(`select[aria-label="${effortLabel}"]`)).not.toBeNull()
  })

  it('submits the pinned model with the chosen reasoning effort', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed)

    setFieldValue(container.querySelector('input') as HTMLInputElement, 'Write a plan')
    const modelKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    await act(async () => { setSelect(selectOf(container, modelKey), modelKey) })
    await act(async () => { setSelect(selectOf(container, 'high'), 'high') })

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })

    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    const input = createTaskConfirmed.mock.calls[0][0]
    expect(input.model).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
  })

  it('submits the model without an effort for the deployment default', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed)

    const modelKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    await act(async () => { setSelect(selectOf(container, modelKey), modelKey) })
    expect(container.querySelector(`select[aria-label="${t('new.model.effort')}"]`)).not.toBeNull()

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })

    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(createTaskConfirmed.mock.calls[0][0].model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('omits the model entirely when none is pinned', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed)

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })

    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(createTaskConfirmed.mock.calls[0][0].model).toBeUndefined()
  })
})
