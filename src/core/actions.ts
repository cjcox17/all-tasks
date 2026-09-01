/**
 * Actions framework: the outbound/result-side contract and its registry. An
 * action runs when an execution settles with a matching outcome. Pure and
 * framework-free; the Host dispatcher supplies the ledger-backed context.
 */
import type { ExecutionRecord, NewTaskInput, TaskRecord } from './tasks.ts'

export type ActionWhen = 'succeeded' | 'failed' | 'cancelled' | 'always'

/** The settled-execution context handed to an action. */
export interface ActionContext {
  task: TaskRecord
  execution: ExecutionRecord
  sessionId: string | undefined
  /** The action's own validated config (shape owned by the plugin). */
  config: unknown
  /**
   * Create a new task (and optionally run it), returning its id. Provided by
   * the Host dispatcher so an action can chain work (e.g. triage → work task).
   */
  spawn?: (input: NewTaskInput, opts?: { autoRun?: boolean }) => string
}

/** One result-side action (a plugin). */
export interface Action {
  /** Stable plugin id (e.g. `http`, `github`, `spawn`). */
  id: string
  /** Outcomes that trigger this action; `always` fires on every settle. */
  when: readonly ActionWhen[]
  run(context: ActionContext): void | Promise<void>
}

export class ActionRegistry {
  private readonly actions = new Map<string, Action>()

  register(action: Action): void {
    if (this.actions.has(action.id)) throw new Error(`action ${action.id} is already registered`)
    this.actions.set(action.id, action)
  }

  get(id: string): Action | undefined {
    return this.actions.get(id)
  }

  all(): Action[] {
    return [...this.actions.values()]
  }
}
