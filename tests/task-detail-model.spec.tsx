// @vitest-environment jsdom
/**
 * The task detail's model pin editing: the reasoning-effort picker reflects
 * the pinned effort, updates it through the controller, and keeps an
 * out-of-preset custom effort selectable.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot, ExecutionEndpointOption, ExecutionModelOption } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import type { WorkspaceDefaultsRecord } from '../src/core/workspace-defaults.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskUpdatePatch } from '../src/core/use-cases/task-update.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
})

const MODEL_CATALOG: readonly ExecutionModelOption[] = [
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat' },
]

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    ...createTask({ title: 'Task A', description: 'desc', prompt: 'do it' }, 0, 't1'),
    ...overrides,
  }
}

function controllerFake(
  taskRecord: TaskRecord,
  models: readonly ExecutionModelOption[] = MODEL_CATALOG,
  updateTask: (id: string, patch: TaskUpdatePatch) => Promise<boolean> = async () => true,
  endpoints: readonly ExecutionEndpointOption[] = [],
  groups: readonly TaskGroupRecord[] = [],
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord> = {},
): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [taskRecord],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: taskRecord.id,
    executionOptions: { workspaces: [], presets: [], models, endpoints },
    workspaceDefaults,
    groups,
    pendingTaskIds: [],
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    closeTask: vi.fn(),
    retryHostSync: vi.fn(async () => true),
    openSession: vi.fn(),
    updateTask,
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    archiveTask: vi.fn(),
    restoreTask: vi.fn(),
    rerunTask: vi.fn(async () => {}),
    setSchedule: vi.fn(() => true),
    isHostBacked: () => false,
  } as unknown as BoardController
}

async function renderDetail(
  taskRecord: TaskRecord,
  models?: readonly ExecutionModelOption[],
  updateTask?: (id: string, patch: TaskUpdatePatch) => Promise<boolean>,
  endpoints?: readonly ExecutionEndpointOption[],
  workspaceDefaults?: Record<string, WorkspaceDefaultsRecord>,
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<TaskDetail controller={controllerFake(taskRecord, models, updateTask, endpoints, [], workspaceDefaults)} task={taskRecord} />)
  })
  return container
}

function effortSelectOf(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector(`select[aria-label="${t('new.model.effort')}"]`)
}

describe('TaskDetail model reasoning-effort pin', () => {
  it('reflects the pinned effort level in the picker', async () => {
    const container = await renderDetail(task({
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    }))
    expect(effortSelectOf(container)?.value).toBe('high')
  })

  it('updates the effort through the controller', async () => {
    const updateTask = vi.fn(async () => true)
    const container = await renderDetail(
      task({ model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } }),
      MODEL_CATALOG,
      updateTask,
    )
    const effort = effortSelectOf(container)!
    await act(async () => {
      effort.value = 'low'
      effort.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(updateTask).toHaveBeenCalledWith('t1', {
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
    })
  })

  it('clearing the effort keeps the model pin', async () => {
    const updateTask = vi.fn(async () => true)
    const container = await renderDetail(
      task({ model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' } }),
      MODEL_CATALOG,
      updateTask,
    )
    const effort = effortSelectOf(container)!
    await act(async () => {
      effort.value = ''
      effort.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(updateTask).toHaveBeenCalledWith('t1', {
      model: { provider: 'deepseek', model: 'deepseek-chat' },
    })
  })

  it('shows no effort picker without a model pin', async () => {
    const container = await renderDetail(task())
    expect(effortSelectOf(container)).toBeNull()
  })

  it('keeps a custom pinned effort selectable even when the model is stale', async () => {
    const container = await renderDetail(task({
      model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'turbo' },
    }), [])
    const effort = effortSelectOf(container)
    expect(effort).not.toBeNull()
    expect(effort!.value).toBe('turbo')
    expect(effort!.textContent).toContain('turbo')
    expect(effort!.textContent).toContain(t('exec.model.effort.custom'))
  })
})

describe('TaskDetail workspace-default hints', () => {
  it('shows the workspace default for a blank model pin', async () => {
    const container = await renderDetail(
      task({ workspaceId: 'ws-a' }),
      MODEL_CATALOG,
      async () => true,
      [],
      { 'ws-a': { model: { provider: 'deepseek', model: 'deepseek-chat' } } },
    )
    expect(container.textContent).toContain(t('detail.workspaceDefault', { value: 'deepseek · deepseek-chat' }))
  })

  it('does not show a hint when the task pins its own model', async () => {
    const container = await renderDetail(
      task({ workspaceId: 'ws-a', model: { provider: 'deepseek', model: 'deepseek-chat' } }),
      MODEL_CATALOG,
      async () => true,
      [],
      { 'ws-a': { model: { provider: 'deepseek', model: 'deepseek-chat' } } },
    )
    expect(container.textContent).not.toContain(t('detail.workspaceDefault', { value: 'deepseek · deepseek-chat' }))
  })
})

const ENDPOINTS: readonly ExecutionEndpointOption[] = [
  { id: 'deepseek-official', name: 'DeepSeek Official' },
  { id: 'lm-studio-nas', name: 'LM Studio (NAS)' },
]

function addEndpointSelectOf(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector(`select[aria-label="${t('endpoint.add')}"]`)
}

function addEndpoint(container: HTMLElement, id: string): void {
  const select = addEndpointSelectOf(container)!
  select.value = id
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('TaskDetail endpoint order pin', () => {
  it('shows the pinned endpoints and updates through the controller', async () => {
    const updateTask = vi.fn(async () => true)
    const container = await renderDetail(
      task({ endpoints: ['deepseek-official'] }),
      MODEL_CATALOG,
      updateTask,
      ENDPOINTS,
    )
    expect(container.textContent).toContain('DeepSeek Official')

    await act(async () => { addEndpoint(container, 'lm-studio-nas') })
    expect(updateTask).toHaveBeenCalledWith('t1', { endpoints: ['deepseek-official', 'lm-studio-nas'] })
  })

  it('clears the pin to null when the last endpoint is removed', async () => {
    const updateTask = vi.fn(async () => true)
    const container = await renderDetail(
      task({ endpoints: ['deepseek-official'] }),
      MODEL_CATALOG,
      updateTask,
      ENDPOINTS,
    )
    const remove = container.querySelector(`button[aria-label="${t('endpoint.remove')}"]`) as HTMLButtonElement
    await act(async () => { remove.click() })
    expect(updateTask).toHaveBeenCalledWith('t1', { endpoints: null })
  })

  it('shows a note when no endpoints are configured', async () => {
    const container = await renderDetail(task())
    expect(container.textContent).toContain(t('endpoint.none'))
  })
})

describe('TaskDetail queued-run display', () => {
  it('shows the waiting badge and preferred endpoint for a queued run', async () => {
    const queued = {
      id: 'e-queued',
      sessionId: undefined,
      startedAt: Date.now() - 1000,
      endedAt: undefined,
      result: undefined,
      error: undefined,
      queuedAt: Date.now() - 1000,
      endpointId: 'deepseek-official',
    }
    const container = await renderDetail(task({
      status: 'running' as const,
      executions: [queued],
    }), MODEL_CATALOG, async () => true, ENDPOINTS)
    expect(container.textContent).toContain(t('detail.result.waiting'))
    expect(container.textContent).toContain(t('exec.endpoint.via', { name: 'DeepSeek Official' }))
  })

  it('shows the endpoint a completed run used', async () => {
    const done = {
      id: 'e-done',
      sessionId: 'session-1',
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 10_000,
      result: 'succeeded' as const,
      error: undefined,
      endpointId: 'lm-studio-nas',
    }
    const container = await renderDetail(task({
      status: 'done' as const,
      executions: [done],
    }), MODEL_CATALOG, async () => true, ENDPOINTS)
    expect(container.textContent).toContain(t('exec.endpoint.via', { name: 'LM Studio (NAS)' }))
    expect(container.textContent).not.toContain(t('detail.result.waiting'))
  })
})

describe('task detail group membership', () => {
  const GROUP: TaskGroupRecord = { id: 'g1', name: 'Nightly', mode: 'sequential', order: [], createdAt: 0, updatedAt: 0, offPeakOnly: false }

  function selectOf(container: HTMLElement, optionValue: string): HTMLSelectElement {
    const select = [...container.querySelectorAll('select')].find(candidate =>
      [...candidate.querySelectorAll('option')].some(option => option.value === optionValue))
    expect(select, `select with option ${optionValue}`).toBeDefined()
    return select as HTMLSelectElement
  }

  it('assigns and clears the group through the controller', async () => {
    const updateTask = vi.fn(async () => true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<TaskDetail controller={controllerFake(task(), MODEL_CATALOG, updateTask, [], [GROUP])} task={task()} />)
    })

    const select = selectOf(container, 'g1')
    select.value = 'g1'
    await act(async () => { select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(updateTask).toHaveBeenCalledWith('t1', { groupId: 'g1' })

    select.value = ''
    await act(async () => { select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(updateTask).toHaveBeenCalledWith('t1', { groupId: null })
  })

  it('shows the inheritance hint when the task group has an armed schedule', async () => {
    const scheduled = { ...GROUP, schedule: { enabled: true, cron: '0 9 * * *' } }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const groupedTask = task({ groupId: 'g1' })
    await act(async () => {
      root.render(<TaskDetail controller={controllerFake(groupedTask, MODEL_CATALOG, async () => true, [], [scheduled])} task={groupedTask} />)
    })
    expect(container.textContent).toContain(t('group.scheduleInherits'))
  })
})
