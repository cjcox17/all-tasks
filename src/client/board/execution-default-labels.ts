/**
 * Effective default display names for the blank execution-target options.
 *
 * A task that leaves an execution target blank resolves it at run time to the
 * workspace's execution default when one exists, otherwise to the deployment
 * default. The mode and model pickers label that blank option "Workspace
 * default"; this module computes the display name of the effective default so
 * the pickers can render "Workspace default (name)" and the user sees what a
 * blank pin resolves to without opening the workspace default-settings
 * editor. The model's deployment default is not exposed by the runtime
 * catalog, so its name is only knowable when the workspace pins one.
 */
import type { ExecutionModelOption, ExecutionPresetOption } from '../../core/controller.ts'
import type { WorkspaceDefaultsRecord } from '../../core/workspace-defaults.ts'

/** Display names of the effective execution defaults, when knowable. */
export interface EffectiveDefaultNames {
  /** Display name of the effective default agent preset (workspace default, else the deployment default). */
  mode?: string
  /** Display name of the effective default model (workspace default only; the deployment default is unknowable). */
  model?: string
}

/**
 * Resolve the display names of the effective execution defaults for one
 * workspace scope.
 * @param workspaceId - the scope whose defaults apply (undefined = unassigned).
 * @param workspaceDefaults - the workspace-defaults map from the controller snapshot.
 * @param presets - the agent-preset roster (for preset names and the deployment default).
 * @param models - the model catalog (for model display names).
 * @returns the effective default display names; a field is absent when unknowable.
 */
export function effectiveDefaultNames(
  workspaceId: string | undefined,
  workspaceDefaults: Record<string, WorkspaceDefaultsRecord>,
  presets: readonly ExecutionPresetOption[],
  models: readonly ExecutionModelOption[],
): EffectiveDefaultNames {
  const defaults = workspaceId === undefined ? undefined : workspaceDefaults[workspaceId]
  const deploymentDefault = presets.find(preset => preset.isDefault)
  const mode = defaults?.mode === undefined
    ? deploymentDefault === undefined ? undefined : deploymentDefault.name ?? deploymentDefault.id
    : presets.find(preset => preset.id === defaults.mode)?.name ?? defaults.mode
  const model = defaults?.model === undefined
    ? undefined
    : (() => {
      const option = models.find(candidate =>
        candidate.provider === defaults.model!.provider && candidate.model === defaults.model!.model)
      return option?.modelName ?? `${defaults.model!.provider} · ${defaults.model!.model}`
    })()
  return { mode, model }
}
