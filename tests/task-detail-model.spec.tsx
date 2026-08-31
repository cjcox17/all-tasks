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
import type { BoardController, ControllerSnapshot, ExecutionModelOption } from '../src/core/controller.ts'
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
): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [taskRecord],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: taskRecord.id,
    executionOptions: { workspaces: [], presets: [], models },
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

async function renderDetail(taskRecord: TaskRecord, models?: readonly ExecutionModelOption[], updateTask?: (id: string, patch: TaskUpdatePatch) => Promise<boolean>): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<TaskDetail controller={controllerFake(taskRecord, models, updateTask)} task={taskRecord} />)
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
