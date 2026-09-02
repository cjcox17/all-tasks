/**
 * Effective default display names for the blank execution-target options.
 *
 * A task that leaves an execution target blank resolves it at run time to the
 * group's default when one exists, then the workspace's execution default,
 * then the deployment default. The mode and model pickers label that blank
 * option so the user sees what a blank pin resolves to without opening the
 * defaults editor. The model's deployment default is not exposed by the
 * runtime catalog, so its name is only knowable when the group or workspace
 * pins one.
 */
import type { ExecutionModelOption, ExecutionPresetOption } from '../../core/controller.ts'
import type { TaskGroupRecord } from '../../core/groups.ts'
import type { WorkspaceDefaultsRecord } from '../../core/workspace-defaults.ts'

/** Which level supplies a defaulted model pin (blank on both sides = deployment default). */
export type DefaultSource = 'group' | 'workspace'

/** Display names of the effective execution defaults, when knowable. */
export interface EffectiveDefaultNames {
  /** Display name of the effective default agent preset (workspace default, else the deployment default). */
  mode?: string
  /** Display name of the effective default WORK model (group default, else the workspace default; the deployment default is unknowable). */
  model?: string
  /** Display name of the effective default PLAN model (group default, else the workspace default; absent = no plan phase). */
  planModel?: string
  /** Which level supplies the effective default WORK model (absent = deployment default). */
  workerModelSource?: DefaultSource
  /** Which level supplies the effective default PLAN model (absent = no plan phase). */
  planModelSource?: DefaultSource
}

/** The model display name for one selection, from the catalog when known. */
function modelName(selection: { provider: string; model: string }, models: readonly ExecutionModelOption[]): string {
  const option = models.find(candidate => candidate.provider === selection.provider && candidate.model === selection.model)
  return option?.modelName ?? `${selection.provider} · ${selection.model}`
}

/**
 * Resolve the display names of the effective execution defaults for one
 * workspace/group scope.
 * @param workspaceId - the scope whose defaults apply (undefined = unassigned).
 * @param groupId - the task's group (its defaults sit between the task and the workspace).
 * @param workspaceDefaults - the workspace-defaults map from the controller snapshot.
 * @param groups - the group roster (for the group's model defaults).
 * @param presets - the agent-preset roster (for preset names and the deployment default).
 * @param models - the model catalog (for model display names).
 * @returns the effective default display names; a field is absent when unknowable.
 */
export function effectiveDefaultNames(
  workspaceId: string | undefined,
  groupId: string | undefined,
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord>,
  groups: readonly TaskGroupRecord[],
  presets: readonly ExecutionPresetOption[],
  models: readonly ExecutionModelOption[],
): EffectiveDefaultNames {
  const defaults = workspaceId === undefined ? undefined : workspaceDefaults[workspaceId]
  const group = groupId === undefined ? undefined : groups.find(candidate => candidate.id === groupId)
  const deploymentDefault = presets.find(preset => preset.isDefault)
  const mode = defaults?.mode === undefined
    ? deploymentDefault === undefined ? undefined : deploymentDefault.name ?? deploymentDefault.id
    : presets.find(preset => preset.id === defaults.mode)?.name ?? defaults.mode
  const workerModel = group?.workerModel ?? defaults?.model
  const planModel = group?.planModel ?? defaults?.planModel
  return {
    mode,
    ...(workerModel === undefined ? {} : {
      model: modelName(workerModel, models),
      workerModelSource: group?.workerModel !== undefined ? 'group' as const : 'workspace' as const,
    }),
    ...(planModel === undefined ? {} : {
      planModel: modelName(planModel, models),
      planModelSource: group?.planModel !== undefined ? 'group' as const : 'workspace' as const,
    }),
  }
}
