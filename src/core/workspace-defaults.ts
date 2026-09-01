/**
 * Per-workspace execution defaults.
 *
 * A workspace may carry a defaults record that the new-task dialog applies
 * whenever a task is created inside that workspace: the execution targets
 * (agent preset / model / endpoints / permission) pre-fill, and a workspace
 * may default its new tasks to unapproved so nothing runs without review.
 * The defaults are authoritative Host-ledger state keyed by workspace id
 * (a workspace-list id, which may outlive a workspace that is later deleted
 * or recreated — the record simply stays dormant).
 *
 * Semantics mirror the task fields: blank values are "no default" (the
 * runtime default applies at execution time, exactly like an unpinned task).
 * Only explicit values are stored; `approved: false` defaults new tasks to
 * unapproved, absent defaults them to approved.
 */
import { normalizeEndpointList } from './endpoints.ts'
import {
  isTaskPermission,
  MODEL_FIELD_BOUND,
  normalizeModelSelection,
  type TaskModelSelection,
  type TaskPermission,
} from './tasks.ts'

/** Bound on the workspace id and agent-preset id length. */
export const WORKSPACE_DEFAULTS_ID_BOUND = MODEL_FIELD_BOUND

/** Per-workspace execution defaults applied to new tasks in that workspace. */
export interface WorkspaceDefaultsRecord {
  /** Agent-preset id the new task's session is composed from; absent = deployment default. */
  mode?: string
  /** Model selection pinned to the new task; absent = deployment default. */
  model?: TaskModelSelection
  /** Priority-ordered endpoint ids the new task routes through; absent = no pin. */
  endpoints?: string[]
  /** Permission preset applied to the new task's session; absent = session default. */
  permission?: TaskPermission
  /**
   * `false`: new tasks in this workspace start unapproved (they cannot run
   * until approved). Absent: new tasks start approved (the default).
   */
  approved?: boolean
}

/** A workspace-defaults edit: every field optional; `null` clears a field (`approved: true` also clears — approved is the default). */
export interface WorkspaceDefaultsPatch {
  mode?: string | null
  model?: TaskModelSelection | null
  endpoints?: string[] | null
  permission?: TaskPermission | null
  approved?: boolean | null
}

/** True when a record carries no effective defaults (an empty entry). */
export function isWorkspaceDefaultsEmpty(record: WorkspaceDefaultsRecord): boolean {
  return record.mode === undefined
    && record.model === undefined
    && record.endpoints === undefined
    && record.permission === undefined
    && record.approved === undefined
}

/**
 * Normalize one defaults record from the wire: bounded, trimmed ids; a model
 * selection through the shared model gate; endpoints through the shared list
 * normalizer; a known permission. An empty record collapses to undefined.
 */
export function normalizeWorkspaceDefaults(value: unknown): WorkspaceDefaultsRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const mode = boundedString(raw.mode)
  const model = normalizeModelSelection(raw.model)
  const endpoints = normalizeEndpointList(raw.endpoints)
  const permission = isTaskPermission(raw.permission) ? raw.permission : undefined
  // Only the explicit `false` is stored (mirroring the task approval flag);
  // `true` means "approved default" = no field at all.
  const approved = raw.approved === false ? false : undefined
  const record: WorkspaceDefaultsRecord = {
    ...(mode === undefined ? {} : { mode }),
    ...(model === undefined ? {} : { model }),
    ...(endpoints === undefined ? {} : { endpoints }),
    ...(permission === undefined ? {} : { permission }),
    ...(approved === undefined ? {} : { approved }),
  }
  return isWorkspaceDefaultsEmpty(record) ? undefined : record
}

/**
 * Normalize a defaults patch from the wire. Every field is optional; `null`
 * clears the field, a valid value sets it, and an invalid value for a
 * present key rejects the whole patch (fail closed — never silently drop a
 * malformed execution target). An empty patch is rejected: a no-op edit must
 * not mint or touch an entry.
 */
export function normalizeWorkspaceDefaultsPatch(value: unknown): WorkspaceDefaultsPatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const patch: WorkspaceDefaultsPatch = {}
  for (const key of ['mode', 'model', 'endpoints', 'permission', 'approved'] as const) {
    if (!(key in raw)) continue
    const field = raw[key]
    if (field === null) {
      patch[key] = null
      continue
    }
    if (key === 'mode') {
      const mode = boundedString(field)
      if (mode === undefined) return undefined
      patch.mode = mode
    } else if (key === 'model') {
      const model = normalizeModelSelection(field)
      if (model === undefined) return undefined
      patch.model = model
    } else if (key === 'endpoints') {
      const endpoints = normalizeEndpointList(field)
      if (endpoints === undefined) return undefined
      patch.endpoints = endpoints
    } else if (key === 'permission') {
      if (!isTaskPermission(field)) return undefined
      patch.permission = field
    } else {
      if (typeof field !== 'boolean') return undefined
      patch.approved = field
    }
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/**
 * Apply a patch onto the current record: `null` (or an absent key) keeps the
 * current value, a present value overwrites it. Returns the next record, or
 * undefined when the result carries no defaults (the entry is then removed).
 */
export function applyWorkspaceDefaultsPatch(
  current: WorkspaceDefaultsRecord | undefined,
  patch: WorkspaceDefaultsPatch,
): WorkspaceDefaultsRecord | undefined {
  const next: WorkspaceDefaultsRecord = { ...current }
  if (patch.mode !== undefined && patch.mode !== null) next.mode = patch.mode
  else if (patch.mode === null) delete next.mode
  if (patch.model !== undefined && patch.model !== null) next.model = patch.model
  else if (patch.model === null) delete next.model
  if (patch.endpoints !== undefined && patch.endpoints !== null) next.endpoints = patch.endpoints
  else if (patch.endpoints === null) delete next.endpoints
  if (patch.permission !== undefined && patch.permission !== null) next.permission = patch.permission
  else if (patch.permission === null) delete next.permission
  // `false` sets the unapproved default; `true` and `null` both clear it
  // (approved is the default state, so it stores nothing).
  if (patch.approved === false) next.approved = false
  else if (patch.approved === true || patch.approved === null) delete next.approved
  return isWorkspaceDefaultsEmpty(next) ? undefined : next
}

/** Bounded non-blank string (workspace ids, preset ids); undefined otherwise. */
function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > WORKSPACE_DEFAULTS_ID_BOUND) return undefined
  return trimmed
}
