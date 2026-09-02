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
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord> = {},
): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces, presets, models: MODELS, endpoints },
    workspaceDefaults,
    workspacePaused: {},
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
  modalProps: { defaultWorkspaceId?: string; defaults?: WorkspaceDefaultsRecord; workspaceDefaults?: Record<string, WorkspaceDefaultsRecord> } = {},
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
    root.render(<NewTaskModal controller={fakeController(createTaskConfirmed, endpoints, groups, workspaces, presets, modalProps.workspaceDefaults)} onClose={onClose} {...modalProps} />)
  })
  return { container, onClose }
}

function selectOf(container: HTMLElement, optionValue: string): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find(candidate =>
    [...candidate.querySelectorAll('option')].some(option => option.value === optionValue))
  expect(select, `select with option ${optionValue}`).toBeDefined()
  return select as HTMLSelectElement
}

function fieldSelectOf(container: HTMLElement, label: string): HTMLSelectElement {
  const labelElement = [...container.querySelectorAll('label')].find(element =>
    element.querySelector('span')?.textContent === label)
  const select = labelElement?.querySelector('select')
  expect(select, `select for label ${label}`).toBeDefined()
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

  it('offers only the groups of the selected workspace scope', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const GROUP_A: TaskGroupRecord = { id: 'g-a', name: 'Alpha Group', mode: 'sequential', order: [], createdAt: 0, updatedAt: 0, offPeakOnly: false, workspaceId: 'ws-a' }
    const GROUP_U: TaskGroupRecord = { id: 'g-u', name: 'Open', mode: 'sequential', order: [], createdAt: 0, updatedAt: 0, offPeakOnly: false }
    const WORKSPACES: readonly ExecutionWorkspaceOption[] = [
      { workspaceId: 'ws-a', title: 'Alpha' },
      { workspaceId: 'ws-b', title: 'Beta' },
    ]
    const { container } = await renderModal(createTaskConfirmed, [], [GROUP_A, GROUP_U], WORKSPACES)

    // No workspace selected → only the unassigned-scope group is offered.
    let groupOptions = Array.from(selectOf(container, 'g-u').querySelectorAll('option')).map(option => option.value)
    expect(groupOptions).toContain('g-u')
    expect(groupOptions).not.toContain('g-a')

    // Selecting ws-a switches the roster to that workspace's groups only.
    await act(async () => { setSelect(selectOf(container, 'ws-a'), 'ws-a') })
    groupOptions = Array.from(selectOf(container, 'g-a').querySelectorAll('option')).map(option => option.value)
    expect(groupOptions).toContain('g-a')
    expect(groupOptions).not.toContain('g-u')
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
    // The approval toggle follows the workspace default (off = starts unapproved).
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)

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

  it('manual creation starts approved unless the approval toggle is turned off', async () => {
    // Toggle on (the default): the create input carries no approval flag.
    {
      const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
      const { container } = await renderModal(createTaskConfirmed)
      setFieldValue(container.querySelector('input') as HTMLInputElement, 'Plain task')
      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      expect(checkbox.checked).toBe(true)
      const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
      await act(async () => { submit.click() })
      expect(createTaskConfirmed).toHaveBeenCalledOnce()
      expect(createTaskConfirmed.mock.calls[0][0].approved).toBeUndefined()
    }
    // Toggle off: the task is minted unapproved.
    {
      const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
      const { container } = await renderModal(createTaskConfirmed)
      setFieldValue(container.querySelector('input') as HTMLInputElement, 'Gated task')
      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
      await act(async () => { checkbox.click() })
      expect(checkbox.checked).toBe(false)
      const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
      await act(async () => { submit.click() })
      expect(createTaskConfirmed).toHaveBeenCalledOnce()
      expect(createTaskConfirmed.mock.calls[0][0].approved).toBe(false)
    }
  })
})

describe('NewTaskModal workspace-default labels', () => {
  it('names the deployment default preset in the blank mode option', async () => {
    const { container } = await renderModal(
      async input => createTask(input, Date.now(), 't-new'),
      [], [], [],
      [{ id: 'standard', name: 'Standard', isDefault: true }],
    )
    const blank = [...selectOf(container, 'standard').querySelectorAll('option')].find(option => option.value === '')
    expect(blank?.textContent).toBe(t('exec.mode.workspaceDefaultWithValue', { value: 'Standard' }))
  })

  it('names the workspace default model in the blank model option of the selected workspace', async () => {
    const { container } = await renderModal(
      async input => createTask(input, Date.now(), 't-new'),
      [], [],
      [{ workspaceId: 'ws-a', title: 'Alpha' }],
      [],
      { defaultWorkspaceId: 'ws-a', workspaceDefaults: { 'ws-a': { model: { provider: 'deepseek', model: 'deepseek-chat' } } } },
    )
    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    const blank = [...selectOf(container, chatKey).querySelectorAll('option')].find(option => option.value === '')
    expect(blank?.textContent).toBe(t('exec.model.workspaceDefaultWithValue', { value: 'deepseek · deepseek-chat' }))
  })

  it('keeps the blank options plain without workspace or deployment defaults', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'))
    const modeBlank = [...fieldSelectOf(container, t('new.mode')).querySelectorAll('option')].find(option => option.value === '')
    expect(modeBlank?.textContent).toBe(t('exec.mode.workspaceDefault'))
    const modelBlank = [...fieldSelectOf(container, t('new.model')).querySelectorAll('option')].find(option => option.value === '')
    expect(modelBlank?.textContent).toBe(t('exec.model.workspaceDefault'))
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
    // deepseek-reasoner is not on the endpoint's model list, so the WORKER
    // model picker (the endpoint-scoped one) must not offer it; the plan
    // model picker is a direct pin and legitimately offers the full catalog.
    const workerSelect = fieldSelectOf(container, t('new.model'))
    expect([...workerSelect.querySelectorAll('option')].some(option => option.value === reasonerKey)).toBe(false)
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

describe('NewTaskModal endpoint → model cascade', () => {
  const SERVING_ENDPOINTS: readonly ExecutionEndpointOption[] = [
    { id: 'deepseek-official', name: 'DeepSeek Official', provider: 'deepseek', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
    { id: 'lm-studio-nas', name: 'LM Studio (NAS)', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'], defaultModel: 'qwen/qwen3.8-27b' },
  ]

  /** The model select must sit inside the endpoint selection: after the endpoint editor. */
  function modelSelectIndex(container: HTMLElement, modelKey: string): number {
    return [...container.querySelectorAll('select')].indexOf(selectOf(container, modelKey))
  }

  function endpointAddIndex(container: HTMLElement): number {
    return [...container.querySelectorAll('select')].indexOf(
      container.querySelector(`select[aria-label="${t('endpoint.add')}"]`) as HTMLSelectElement)
  }

  it('renders the endpoint selection before the model select (model inside the endpoint)', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'), SERVING_ENDPOINTS)
    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(modelSelectIndex(container, chatKey)).toBeGreaterThan(endpointAddIndex(container))
  })

  it('explains the endpoint-scoped model list as soon as an endpoint is pinned', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'), SERVING_ENDPOINTS)
    expect(container.textContent).not.toContain(t('exec.model.endpointHint'))
    const add = container.querySelector(`select[aria-label="${t('endpoint.add')}"]`) as HTMLSelectElement
    await act(async () => { setSelect(add, 'deepseek-official') })
    expect(container.textContent).toContain(t('exec.model.endpointHint'))
  })
})

describe('NewTaskModal auto-generated title', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** Flush the mocked-fetch microtask chain after the debounce fires. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { await Promise.resolve() })
    }
  }

  it('shows a generating hint, fills a generated title, and submits it', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ title: 'Fix the login bug' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container, onClose } = await renderModal(createTaskConfirmed)

    const titleInput = container.querySelector('input') as HTMLInputElement
    const prompt = container.querySelectorAll('textarea')[1] as HTMLTextAreaElement
    await act(async () => { setTextareaValue(prompt, 'Fix the login bug, users are locked out') })
    expect(titleInput.value).toBe('')
    expect(container.textContent).toContain(t('new.titleGenerating'))

    await act(async () => { vi.advanceTimersByTime(10_000) })
    await flush()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(titleInput.value).toBe('Fix the login bug')
    expect(container.textContent).toContain(t('new.titleRegenerate'))

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(createTaskConfirmed.mock.calls[0][0].title).toBe('Fix the login bug')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('never overwrites a manual title with a late generation', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ title: 'Generated' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed)

    const titleInput = container.querySelector('input') as HTMLInputElement
    setFieldValue(titleInput, 'My manual title')
    const prompt = container.querySelectorAll('textarea')[1] as HTMLTextAreaElement
    setTextareaValue(prompt, 'Fix the login bug')

    await act(async () => { vi.advanceTimersByTime(10_000) })
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(titleInput.value).toBe('My manual title')
  })

  it('falls back to the prompt first line when generation fails', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('host offline') }))
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed)

    const titleInput = container.querySelector('input') as HTMLInputElement
    const prompt = container.querySelectorAll('textarea')[1] as HTMLTextAreaElement
    setTextareaValue(prompt, '- Fix the login bug\n\nMore details')
    await act(async () => { vi.advanceTimersByTime(10_000) })
    await flush()
    expect(titleInput.value).toBe('Fix the login bug')
  })

  it('submits the prompt-line fallback when the user creates before generation lands', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed)

    const prompt = container.querySelectorAll('textarea')[1] as HTMLTextAreaElement
    setTextareaValue(prompt, 'Draft the release notes')
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    expect(createTaskConfirmed.mock.calls[0][0].title).toBe('Draft the release notes')
  })
})

describe('NewTaskModal plan model picker', () => {
  it('renders the plan model picker with a "no plan phase" blank and the worker model picker', async () => {
    const { container } = await renderModal(async input => createTask(input, Date.now(), 't-new'))
    const planSelect = fieldSelectOf(container, t('new.planModel'))
    const blank = [...planSelect.querySelectorAll('option')].find(option => option.value === '')
    expect(blank?.textContent).toBe(t('exec.planModel.none'))
    // The worker model picker (endpoint-scoped) still exists beside it.
    expect(fieldSelectOf(container, t('new.model'))).toBeDefined()
  })

  it('submits the pinned plan model with its reasoning effort', async () => {
    const createTaskConfirmed = vi.fn(async (input: NewTaskInput) => createTask(input, Date.now(), 't-new'))
    const { container } = await renderModal(createTaskConfirmed)

    setFieldValue(container.querySelector('input') as HTMLInputElement, 'Write a plan')
    const planKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    await act(async () => { setSelect(fieldSelectOf(container, t('new.planModel')), planKey) })
    await act(async () => { setSelect(selectOf(container, 'high'), 'high') })

    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement
    await act(async () => { submit.click() })
    expect(createTaskConfirmed).toHaveBeenCalledOnce()
    const input = createTaskConfirmed.mock.calls[0][0] as NewTaskInput
    expect(input.planModel).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
  })

  it('pre-fills the plan model from the workspace defaults', async () => {
    const planKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    const planModel = { provider: 'deepseek', model: 'deepseek-reasoner' }
    const { container } = await renderModal(
      async input => createTask(input, Date.now(), 't-new'),
      [], [], [{ workspaceId: 'ws-a', title: 'Alpha' }], [],
      {
        defaultWorkspaceId: 'ws-a',
        defaults: { planModel },
        workspaceDefaults: { 'ws-a': { planModel } },
      },
    )
    const planSelect = fieldSelectOf(container, t('new.planModel'))
    expect(planSelect.value).toBe(planKey)
    const blank = [...planSelect.querySelectorAll('option')].find(option => option.value === '')
    expect(blank?.textContent).toBe(t('exec.planModel.workspaceDefaultWithValue', { value: 'deepseek · deepseek-reasoner' }))
  })
})
