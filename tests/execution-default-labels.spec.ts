/**
 * Effective default display names for the blank execution-target options:
 * the workspace default when one exists, else the deployment default; the
 * model's deployment default is unknowable from the catalog.
 */
import { describe, expect, it } from 'vitest'
import { effectiveDefaultNames } from '../src/client/board/execution-default-labels.ts'
import type { ExecutionModelOption, ExecutionPresetOption } from '../src/core/controller.ts'
import type { WorkspaceDefaultsRecord } from '../src/core/workspace-defaults.ts'

const MODELS: readonly ExecutionModelOption[] = [
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', modelName: 'DeepSeek Chat' },
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-reasoner' },
]

const PRESETS: readonly ExecutionPresetOption[] = [
  { id: 'planner', name: 'Planner', isDefault: false },
  { id: 'standard', name: 'Standard', isDefault: true },
]

const NO_DEFAULTS: Record<string, WorkspaceDefaultsRecord> = {}

describe('effectiveDefaultNames', () => {
  it('falls back to the deployment default preset name without a workspace default', () => {
    expect(effectiveDefaultNames('ws-a', NO_DEFAULTS, PRESETS, MODELS).mode).toBe('Standard')
  })

  it('stays unknowable without a workspace default for the model', () => {
    expect(effectiveDefaultNames('ws-a', NO_DEFAULTS, PRESETS, MODELS).model).toBeUndefined()
  })

  it('names the workspace default preset over the deployment default', () => {
    const defaults = { 'ws-a': { mode: 'planner' } }
    expect(effectiveDefaultNames('ws-a', defaults, PRESETS, MODELS).mode).toBe('Planner')
  })

  it('falls back to the raw preset id when the workspace default preset left the roster', () => {
    const defaults = { 'ws-a': { mode: 'retired' } }
    expect(effectiveDefaultNames('ws-a', defaults, PRESETS, MODELS).mode).toBe('retired')
  })

  it('uses the catalog display name for the workspace default model', () => {
    const defaults = { 'ws-a': { model: { provider: 'deepseek', model: 'deepseek-chat' } } }
    expect(effectiveDefaultNames('ws-a', defaults, PRESETS, MODELS).model).toBe('DeepSeek Chat')
  })

  it('falls back to provider · model when the default model is not in the catalog', () => {
    const defaults = { 'ws-a': { model: { provider: 'lm-studio', model: 'qwen/qwen3-8b' } } }
    expect(effectiveDefaultNames('ws-a', defaults, PRESETS, MODELS).model).toBe('lm-studio · qwen/qwen3-8b')
  })

  it('uses the preset id when the deployment default preset has no name', () => {
    const presets: readonly ExecutionPresetOption[] = [{ id: 'standard', isDefault: true }]
    expect(effectiveDefaultNames(undefined, NO_DEFAULTS, presets, MODELS).mode).toBe('standard')
  })

  it('resolves nothing when no preset is the deployment default and no workspace default exists', () => {
    const presets: readonly ExecutionPresetOption[] = [{ id: 'planner', name: 'Planner', isDefault: false }]
    expect(effectiveDefaultNames(undefined, NO_DEFAULTS, presets, MODELS).mode).toBeUndefined()
  })

  it('ignores the workspace defaults of other workspaces', () => {
    const defaults = { 'ws-b': { mode: 'planner', model: { provider: 'deepseek', model: 'deepseek-chat' } } }
    const names = effectiveDefaultNames('ws-a', defaults, PRESETS, MODELS)
    expect(names.mode).toBe('Standard')
    expect(names.model).toBeUndefined()
  })
})
