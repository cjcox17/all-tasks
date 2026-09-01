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
import type { BoardController, ControllerSnapshot, ExecutionEndpointOption, ExecutionModelOption, ExecutionPresetOption, ExecutionWorkspaceOption } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import { createTask, modelSelectionKey, type NewTaskInput, type TaskRecord } from '../src/core/tasks.ts'
import type { WorkspaceDefaultsRecord } from '../src/core/workspace-defaults.ts'

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

const ENDPOINTS: readonly ExecutionEndpointOption[] = [
  { id: 'deepseek-official', name: 'DeepSeek Official' },
  { id: 'lm-studio-nas', name: 'LM Studio (NAS)' },
]

function fakeController(
  createTaskConfirmed: (input: NewTaskInput) => Promise<TaskRecord | undefined>,
  endpoints: readonly ExecutionEndpointOption[] = [],
  groups: readonly TaskGroupRecord[] = [],
  workspaces: readonly ExecutionWorkspaceOption[] = [],
  presets: readonly ExecutionPresetOption[] = [],
): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces, presets, models: MODELS, endpoints },
    workspaceDefaults: {},
    groups,
    pendingTaskIds: [],
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    createTaskConfirmed,
  } as unknown as BoardController
}

async function renderModal(
  createTaskConfirmed: (input: NewTaskInput) => Promise<TaskRecord | undefined>,
  endpoints: readonly ExecutionEndpointOption[] = [],
  groups: readonly TaskGroupRecord[] = [],
  workspaces: readonly ExecutionWorkspaceOption[] = [],
  presets: readonly ExecutionPresetOption[] = [],
  modalProps: { defaultWorkspaceId?: string; defaults?: WorkspaceDefaultsRecord } = {},
): Promise<{
  container: HTMLElement
  onClose: ReturnType<typeof vi.fn>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const onClose = vi.fn()
  await act(async () => {
    root.render(<NewTaskModal controller={fakeController(createTaskConfirmed, endpoints, groups, workspaces, presets)} onClose={onClose} {...modalProps} />)
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

describe('NewTaskModal endpoint order', () => {
  it('submits the priority-ordered endpoint list', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed, ENDPOINTS)

    const add = container.querySelector(`select[aria-label="${t('endpoint.add')}"]`) as HTMLSelectElement
    expect(add).not.toBeNull()
    await act(async () => { setSelect(add, 'deepseek-official') })
    await act(async () => { setSelect(add, 'lm-studio-nas') })

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(createTaskConfirmed.mock.calls[0][0].endpoints).toEqual(['deepseek-official', 'lm-studio-nas'])
  })

  it('omits endpoints when none are picked', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed, ENDPOINTS)
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed.mock.calls[0][0].endpoints).toBeUndefined()
  })

  it('shows a note when no endpoints are configured', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'))
    expect(container.textContent).toContain(t('endpoint.none'))
    expect(container.querySelector(`select[aria-label="${t('endpoint.add')}"]`)).toBeNull()
  })
})

describe('NewTaskModal group picker', () => {
  const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', order: [], createdAt: 0, updatedAt: 0, offPeakOnly: false }

  it('submits the chosen group on create', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed, [], [GROUP])

    setFieldValue(container.querySelector('input') as HTMLInputElement, 'Grouped task')
    await act(async () => { setSelect(selectOf(container, 'g1'), 'g1') })

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(createTaskConfirmed.mock.calls[0][0].groupId).toBe('g1')
  })

  it('omits the group when none is chosen', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed, [], [GROUP])
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed.mock.calls[0][0].groupId).toBeUndefined()
  })
})

describe('NewTaskModal workspace defaults', () => {
  const WORKSPACES: readonly ExecutionWorkspaceOption[] = [
    { workspaceId: 'ws-a', title: 'Alpha' },
    { workspaceId: 'ws-b', title: 'Beta' },
  ]
  const DEFAULTS: WorkspaceDefaultsRecord = {
    mode: 'planner',
    model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    endpoints: ['deepseek-official'],
    permission: 'read-only',
    approved: false,
  }

  it('pre-selects the workspace and pre-fills the execution targets from the workspace defaults', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed, ENDPOINTS, [], WORKSPACES, [{ id: 'planner', isDefault: false }], {
      defaultWorkspaceId: 'ws-a',
      defaults: DEFAULTS,
    })

    const workspaceSelect = selectOf(container, 'ws-a')
    expect(workspaceSelect.value).toBe('ws-a')
    const modeSelect = selectOf(container, 'planner')
    expect(modeSelect.value).toBe('planner')
    const modelKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    const modelSelect = selectOf(container, modelKey)
    expect(modelSelect.value).toBe(modelKey)
    // The effort picker follows the pinned model with the defaulted effort.
    const effortSelect = selectOf(container, 'high')
    expect(effortSelect.value).toBe('high')
    // The endpoint order editor lists the defaulted endpoint.
    const endpointRow = Array.from(container.querySelectorAll('li')).find(li => li.textContent?.includes('DeepSeek Official'))
    expect(endpointRow).not.toBeNull()
    // The unapproved default is on.
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    setFieldValue(container.querySelector('input') as HTMLInputElement, 'Pinned task')
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })

    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    const input = createTaskConfirmed.mock.calls[0][0]
    expect(input.workspaceId).toBe('ws-a')
    expect(input.mode).toBe('planner')
    expect(input.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
    expect(input.endpoints).toEqual(['deepseek-official'])
    expect(input.permission).toBe('read-only')
    // The workspace default mints the task unapproved; the manual dialog keeps it.
    expect(input.approved).toBe(false)
  })

  it('manual creation stays approved unless the unapproved toggle is turned on', async () => {
    // Without the toggle: the create input carries no approval flag.
    {
      const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
      const { container } = await renderModal(createTaskConfirmed)
      setFieldValue(container.querySelector('input') as HTMLInputElement, 'Plain task')
      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(checkbox.checked).toBe(false)
      const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
      await act(async () => { submit.click() })
      expect(createTaskConfirmed).toHaveBeenCalledOnce()
      expect(createTaskConfirmed.mock.calls[0][0].approved).toBeUndefined()
    }
    // With the toggle: the task is minted unapproved.
    {
      const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
      const { container } = await renderModal(createTaskConfirmed)
      setFieldValue(container.querySelector('input') as HTMLInputElement, 'Gated task')
      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      await act(async () => { checkbox.click() })
      const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
      await act(async () => { submit.click() })
      expect(createTaskConfirmed).toHaveBeenCalledOnce()
      expect(createTaskConfirmed.mock.calls[0][0].approved).toBe(false)
    }
  })
})

describe('NewTaskModal endpoint-constrained model picker', () => {
  const SERVING_ENDPOINTS: readonly ExecutionEndpointOption[] = [
    { id: 'deepseek-official', name: 'DeepSeek Official', provider: 'deepseek', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
    { id: 'lm-studio-nas', name: 'LM Studio (NAS)', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'], defaultModel: 'qwen/qwen3.8-27b' },
  ]

  it('offers the full catalog when no endpoints are pinned', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'), SERVING_ENDPOINTS)
    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    const reasonerKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(selectOf(container, chatKey)).toBeDefined()
    expect(selectOf(container, reasonerKey)).toBeDefined()
  })

  it('offers only models the pinned endpoints serve once an endpoint is pinned', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'), SERVING_ENDPOINTS)
    const add = container.querySelector(`select[aria-label="${t('endpoint.add')}"]`) as HTMLSelectElement
    await act(async () => { setSelect(add, 'deepseek-official') })

    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    const reasonerKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(selectOf(container, chatKey)).toBeDefined()
    // deepseek-reasoner is not on the endpoint's model list, so it must vanish.
    expect([...container.querySelectorAll('option')].some(option => option.value === reasonerKey)).toBe(false)
  })

  it('keeps a pinned model outside the endpoint list as a stale row with a hint', async () => {
    const { container } = await renderModal(
      async input => createTask(input, Date.now(), 't-new'),
      SERVING_ENDPOINTS,
      [],
      [],
      [],
      { defaults: { model: { provider: 'deepseek', model: 'deepseek-reasoner' }, endpoints: ['deepseek-official'] } },
    )
    const reasonerKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    const select = selectOf(container, reasonerKey)
    expect(select).toBeDefined()
    const staleOption = [...select.querySelectorAll('option')].find(option => option.value === reasonerKey)
    expect(staleOption?.textContent).toContain(t('exec.model.notServed'))
    expect(container.textContent).toContain(t('exec.model.endpointHint'))
  })

  it('submits a model served by the pinned endpoints', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed, SERVING_ENDPOINTS)
    const add = container.querySelector(`select[aria-label="${t('endpoint.add')}"]`) as HTMLSelectElement
    await act(async () => { setSelect(add, 'deepseek-official') })

    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    await act(async () => { setSelect(selectOf(container, chatKey), chatKey) })

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed.mock.calls[0][0]).toMatchObject({
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      endpoints: ['deepseek-official'],
    })
  })
})
