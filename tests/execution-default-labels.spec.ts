/**
 * Effective default display names for the blank execution-target options:
 * the group default when one exists, then the workspace default, else the
 * deployment default; the model's deployment default is unknowable from the
 * catalog, and the plan model's absence means "no plan phase".
 */
import { describe, expect, it } from 'vitest'
import { effectiveDefaultNames } from '../src/client/board/execution-default-labels.ts'
import type { ExecutionModelOption, ExecutionPresetOption } from '../src/core/controller.ts'
import type { TaskGroupRecord } from '../src/core/groups.ts'
import type { WorkspaceDefaultsRecord } from '../src/core/workspace-defaults.ts'

const MODELS: readonly ExecutionModelOption[] = [
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat' },
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-reasoner', modelName: 'DeepSeek Reasoner' },
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-r1', modelName: 'DeepSeek R1' },
]

const PRESETS: readonly ExecutionPresetOption[] = [
  { id: 'planner', name: 'Planner', isDefault: false },
  { id: 'standard', name: 'Standard', isDefault: true },
]

const NO_DEFAULTS: Record<string, WorkspaceDefaultsRecord> = {}
const NO_GROUPS: readonly TaskGroupRecord[] = []

const GROUP: TaskGroupRecord = {
  id: 'g1',
  name: 'Ship',
  mode: 'sequential',
  offPeakOnly: false,
  order: [],
  createdAt: 0,
  updatedAt: 0,
  workerModel: { provider: 'deepseek', model: 'deepseek-reasoner' },
  planModel: { provider: 'deepseek', model: 'deepseek-r1' },
}

const CHAT: { provider: 'deepseek'; model: 'deepseek-chat' } = { provider: 'deepseek', model: 'deepseek-chat' }

describe('effectiveDefaultNames', () => {
  it('falls back to the deployment default preset name without a workspace default', () => {
    expect(effectiveDefaultNames('ws-a', undefined, NO_DEFAULTS, NO_GROUPS, PRESETS, MODELS).mode).toBe('Standard')
  })

  it('stays unknowable without a group or workspace default for the model', () => {
    expect(effectiveDefaultNames('ws-a', undefined, NO_DEFAULTS, NO_GROUPS, PRESETS, MODELS).model).toBeUndefined()
  })

  it('reports no plan phase when no group or workspace plan-model default exists', () => {
    expect(effectiveDefaultNames('ws-a', undefined, NO_DEFAULTS, NO_GROUPS, PRESETS, MODELS).planModel).toBeUndefined()
  })

  it('names the workspace default preset over the deployment default', () => {
    const defaults = { 'ws-a': { mode: 'planner' } }
    expect(effectiveDefaultNames('ws-a', undefined, defaults, NO_GROUPS, PRESETS, MODELS).mode).toBe('Planner')
  })

  it('falls back to the raw preset id when the workspace default preset left the roster', () => {
    const defaults = { 'ws-a': { mode: 'retired' } }
    expect(effectiveDefaultNames('ws-a', undefined, defaults, NO_GROUPS, PRESETS, MODELS).mode).toBe('retired')
  })

  it('uses the catalog display name for the workspace default model', () => {
    const defaults = { 'ws-a': { model: CHAT } }
    const names = effectiveDefaultNames('ws-a', undefined, defaults, NO_GROUPS, PRESETS, MODELS)
    expect(names.model).toBe('DeepSeek Chat')
    expect(names.workerModelSource).toBe('workspace')
  })

  it('falls back to provider · model when the default model is not in the catalog', () => {
    const defaults = { 'ws-a': { model: { provider: 'lm-studio', model: 'qwen/qwen3-8b' } } }
    expect(effectiveDefaultNames('ws-a', undefined, defaults, NO_GROUPS, PRESETS, MODELS).model).toBe('lm-studio · qwen/qwen3-8b')
  })

  it('prefers the group model defaults over the workspace defaults', () => {
    const defaults = { 'ws-a': { model: CHAT, planModel: CHAT } }
    const names = effectiveDefaultNames('ws-a', 'g1', defaults, [GROUP], PRESETS, MODELS)
    expect(names.model).toBe('DeepSeek Reasoner')
    expect(names.workerModelSource).toBe('group')
    expect(names.planModel).toBe('DeepSeek R1')
    expect(names.planModelSource).toBe('group')
  })

  it('falls back to the workspace plan-model default when the group has none', () => {
    const defaults = { 'ws-a': { planModel: CHAT } }
    const group: TaskGroupRecord = { ...GROUP, planModel: undefined }
    const names = effectiveDefaultNames('ws-a', 'g1', defaults, [group], PRESETS, MODELS)
    expect(names.planModel).toBe('DeepSeek Chat')
    expect(names.planModelSource).toBe('workspace')
  })

  it('reports no plan phase when only the worker model has a default', () => {
    const group: TaskGroupRecord = { ...GROUP, planModel: undefined }
    const names = effectiveDefaultNames('ws-a', 'g1', NO_DEFAULTS, [group], PRESETS, MODELS)
    expect(names.model).toBe('DeepSeek Reasoner')
    expect(names.planModel).toBeUndefined()
  })

  it('uses the preset id when the deployment default preset has no name', () => {
    const presets: readonly ExecutionPresetOption[] = [{ id: 'standard', isDefault: true }]
    expect(effectiveDefaultNames(undefined, undefined, NO_DEFAULTS, NO_GROUPS, presets, MODELS).mode).toBe('standard')
  })

  it('resolves nothing when no preset is the deployment default and no workspace default exists', () => {
    const presets: readonly ExecutionPresetOption[] = [{ id: 'planner', name: 'Planner', isDefault: false }]
    expect(effectiveDefaultNames(undefined, undefined, NO_DEFAULTS, NO_GROUPS, presets, MODELS).mode).toBeUndefined()
  })

  it('ignores the workspace defaults of other workspaces', () => {
    const defaults = { 'ws-b': { mode: 'planner', model: CHAT } }
    const names = effectiveDefaultNames('ws-a', undefined, defaults, NO_GROUPS, PRESETS, MODELS)
    expect(names.mode).toBe('Standard')
    expect(names.model).toBeUndefined()
  })
})
