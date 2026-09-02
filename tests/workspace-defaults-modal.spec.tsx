// @vitest-environment jsdom
/**
 * The workspace-defaults editor's endpoint → model cascade: the endpoint
 * selection comes first and the model select lives inside it, offering only
 * the models the pinned endpoints serve (exactly like the task forms).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDefaultsModal } from '../src/client/board/WorkspaceDefaultsModal.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot, ExecutionEndpointOption, ExecutionModelOption } from '../src/core/controller.ts'
import { modelSelectionKey } from '../src/core/tasks.ts'
import type { WorkspaceDefaultsPatch, WorkspaceDefaultsRecord } from '../src/core/workspace-defaults.ts'

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

const SERVING_ENDPOINTS: readonly ExecutionEndpointOption[] = [
  { id: 'deepseek-official', name: 'DeepSeek Official', provider: 'deepseek', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
  { id: 'lm-studio-nas', name: 'LM Studio (NAS)', provider: 'lm-studio', models: ['qwen/qwen3.8-27b'], defaultModel: 'qwen/qwen3.8-27b' },
]

function fakeController(
  setWorkspaceDefaults: (workspaceId: string, patch: WorkspaceDefaultsPatch) => Promise<boolean>,
  defaults?: WorkspaceDefaultsRecord,
): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: MODELS, endpoints: SERVING_ENDPOINTS },
    workspaceDefaults: defaults === undefined ? {} : { 'ws-a': defaults },
    workspacePaused: {},
    groups: [],
    pendingTaskIds: [],
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    setWorkspaceDefaults,
  } as unknown as BoardController
}

async function renderDefaultsModal(
  setWorkspaceDefaults: (workspaceId: string, patch: WorkspaceDefaultsPatch) => Promise<boolean> = async () => true,
  defaults?: WorkspaceDefaultsRecord,
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <WorkspaceDefaultsModal controller={fakeController(setWorkspaceDefaults, defaults)} workspaceId="ws-a" title="Alpha" onClose={vi.fn()} />,
    )
  })
  return container
}

function selectOf(container: HTMLElement, optionValue: string): HTMLSelectElement {
  const select = [...container.querySelectorAll('select')].find(candidate =>
    [...candidate.querySelectorAll('option')].some(option => option.value === optionValue))
  expect(select, `select with option ${optionValue}`).toBeDefined()
  return select as HTMLSelectElement
}

describe('WorkspaceDefaultsModal endpoint → model cascade', () => {
  it('renders the endpoint selection before the model select (model inside the endpoint)', async () => {
    const container = await renderDefaultsModal()
    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    const selects = [...container.querySelectorAll('select')]
    const modelIndex = selects.indexOf(selectOf(container, chatKey))
    const addIndex = selects.indexOf(
      container.querySelector(`select[aria-label="${t('endpoint.add')}"]`) as HTMLSelectElement)
    expect(modelIndex).toBeGreaterThan(addIndex)
  })

  it('offers only models the pinned endpoint serves once endpoints are pinned in the defaults', async () => {
    const container = await renderDefaultsModal(undefined, { endpoints: ['deepseek-official'] })
    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    const reasonerKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(selectOf(container, chatKey)).toBeDefined()
    // The worker model picker (endpoint-scoped) must not offer reasoner; the
    // plan model picker is a direct pin and offers the full catalog.
    const workerSelect = [...container.querySelectorAll('label')]
      .find(element => element.querySelector('span')?.textContent === t('new.model'))
      ?.querySelector('select') as HTMLSelectElement
    expect([...workerSelect.querySelectorAll('option')].some(option => option.value === reasonerKey)).toBe(false)
    expect(container.textContent).toContain(t('exec.model.endpointHint'))
  })

  it('offers the full catalog when the defaults pin no endpoints', async () => {
    const container = await renderDefaultsModal()
    const chatKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-chat' })
    const reasonerKey = modelSelectionKey({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(selectOf(container, chatKey)).toBeDefined()
    expect(selectOf(container, reasonerKey)).toBeDefined()
  })
})
