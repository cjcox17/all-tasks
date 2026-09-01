/**
 * Workspace-defaults core: record/patch normalization and the patch-apply
 * transition (set / clear / drop-empty-entry semantics).
 */
import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceDefaultsPatch,
  isWorkspaceDefaultsEmpty,
  normalizeWorkspaceDefaults,
  normalizeWorkspaceDefaultsPatch,
  resolveExecutionTargets,
  type WorkspaceDefaultsRecord,
} from '../src/core/workspace-defaults.ts'

describe('workspace-defaults normalization', () => {
  it('normalizes a full record: bounded ids, model through the model gate, endpoints deduplicated', () => {
    expect(normalizeWorkspaceDefaults({
      mode: '  planner  ',
      model: { provider: ' deepseek ', model: 'deepseek-chat', reasoningEffort: ' high ' },
      endpoints: ['deepseek-official', 'deepseek-official', 'lm-studio-nas'],
      permission: 'workspace-write',
      approved: false,
    })).toEqual({
      mode: 'planner',
      model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      endpoints: ['deepseek-official', 'lm-studio-nas'],
      permission: 'workspace-write',
      approved: false,
    })
  })

  it('collapses a blank/unknown record to undefined (no defaults)', () => {
    expect(normalizeWorkspaceDefaults({ mode: '', model: null, permission: 'nope' })).toBeUndefined()
    expect(normalizeWorkspaceDefaults({ mode: 'planner' })).toEqual({ mode: 'planner' })
    expect(normalizeWorkspaceDefaults({ approved: true })).toBeUndefined()
    expect(normalizeWorkspaceDefaults(undefined)).toBeUndefined()
    expect(normalizeWorkspaceDefaults([])).toBeUndefined()
  })

  it('drops invalid fields of a record (never stores malformed targets)', () => {
    expect(normalizeWorkspaceDefaults({ mode: '   ', model: { provider: '', model: 'x' }, approved: 'yes' })).toBeUndefined()
    expect(normalizeWorkspaceDefaults({ permission: 'unknown-permission' })).toBeUndefined()
  })

  it('normalizes a patch: null clears, values set, malformed present keys reject the whole patch', () => {
    expect(normalizeWorkspaceDefaultsPatch({ mode: null, model: null, endpoints: null, permission: null, approved: null }))
      .toEqual({ mode: null, model: null, endpoints: null, permission: null, approved: null })
    expect(normalizeWorkspaceDefaultsPatch({ mode: 'planner', approved: false }))
      .toEqual({ mode: 'planner', approved: false })
    // A malformed value for a present key rejects the whole patch.
    expect(normalizeWorkspaceDefaultsPatch({ mode: 42 })).toBeUndefined()
    expect(normalizeWorkspaceDefaultsPatch({ model: { provider: '' } })).toBeUndefined()
    expect(normalizeWorkspaceDefaultsPatch({ permission: 'sudo' })).toBeUndefined()
    expect(normalizeWorkspaceDefaultsPatch({ approved: 'yes' })).toBeUndefined()
    // An empty patch is rejected (a no-op edit must not touch the entry).
    expect(normalizeWorkspaceDefaultsPatch({})).toBeUndefined()
    expect(normalizeWorkspaceDefaultsPatch(null)).toBeUndefined()
  })

  it('trims and bounds ids and model fields', () => {
    expect(normalizeWorkspaceDefaultsPatch({ mode: '  x  ' })).toEqual({ mode: 'x' })
    expect(normalizeWorkspaceDefaults({ mode: 'x'.repeat(300) })).toBeUndefined()
    expect(normalizeWorkspaceDefaultsPatch({ mode: 'x'.repeat(300) })).toBeUndefined()
  })
})

describe('workspace-defaults patch application', () => {
  it('sets fields on an empty record and keeps absent fields untouched', () => {
    const next = applyWorkspaceDefaultsPatch(undefined, { mode: 'planner', approved: false })
    expect(next).toEqual({ mode: 'planner', approved: false })
    expect(applyWorkspaceDefaultsPatch(next, { model: { provider: 'deepseek', model: 'chat' } }))
      .toEqual({ mode: 'planner', model: { provider: 'deepseek', model: 'chat' }, approved: false })
  })

  it('clears fields with null and drops the entry when nothing remains', () => {
    const current: WorkspaceDefaultsRecord = { mode: 'planner', approved: false }
    const partial = applyWorkspaceDefaultsPatch(current, { mode: null })
    expect(partial).toEqual({ approved: false })
    expect(applyWorkspaceDefaultsPatch(partial, { approved: null })).toBeUndefined()
  })

  it('overwrites a field with a new value', () => {
    const current: WorkspaceDefaultsRecord = { mode: 'planner', approved: false }
    expect(applyWorkspaceDefaultsPatch(current, { mode: 'coder', approved: null })).toEqual({ mode: 'coder' })
  })

  it('recognizes an empty record', () => {
    expect(isWorkspaceDefaultsEmpty({})).toBe(true)
    expect(isWorkspaceDefaultsEmpty({ mode: 'x' })).toBe(false)
    expect(isWorkspaceDefaultsEmpty({ approved: false })).toBe(false)
  })
})

describe('workspace-defaults runtime resolution', () => {
  it('prefers the task own targets over the workspace defaults', () => {
    const task = {
      mode: 'coder',
      model: { provider: 'deepseek', model: 'deepseek-reasoner' },
      endpoints: ['task-endpoint'],
      permission: 'danger-full-access' as const,
    }
    const defaults: WorkspaceDefaultsRecord = {
      mode: 'planner',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      endpoints: ['default-endpoint'],
      permission: 'read-only',
    }
    expect(resolveExecutionTargets(task, defaults)).toEqual(task)
  })

  it('fills blank task targets from the workspace defaults', () => {
    const defaults: WorkspaceDefaultsRecord = {
      mode: 'planner',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      endpoints: ['default-endpoint'],
      permission: 'read-only',
    }
    expect(resolveExecutionTargets({}, defaults)).toEqual(defaults)
  })

  it('keeps a mixed set per field and drops blank fields entirely', () => {
    const defaults: WorkspaceDefaultsRecord = { mode: 'planner', permission: 'read-only' }
    const task = {
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      endpoints: ['task-endpoint'],
    }
    expect(resolveExecutionTargets(task, defaults)).toEqual({
      mode: 'planner',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      endpoints: ['task-endpoint'],
      permission: 'read-only',
    })
  })

  it('returns nothing when neither the task nor the workspace carries a target', () => {
    expect(resolveExecutionTargets({}, undefined)).toEqual({})
    expect(resolveExecutionTargets({}, {})).toEqual({})
  })

  it('does not inherit the workspace approved gate (approval is task state)', () => {
    expect(resolveExecutionTargets({}, { approved: false })).toEqual({})
  })

  it('copies lists so the caller cannot mutate the resolved view into the source', () => {
    const task = { endpoints: ['task-endpoint'] }
    const defaults: WorkspaceDefaultsRecord = { endpoints: ['default-endpoint'] }
    const resolved = resolveExecutionTargets(task, defaults)
    resolved.endpoints!.push('extra')
    expect(task.endpoints).toEqual(['task-endpoint'])
    expect(defaults.endpoints).toEqual(['default-endpoint'])
  })
})
