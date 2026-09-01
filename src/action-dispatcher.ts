/**
 * Host-side action dispatch: subscribe to ledger settlements, match the
 * configured actions whose `when` includes the outcome, and run them against
 * the settled execution context. Errors are isolated per action so one failing
 * action never blocks the others or the settlement itself.
 */
import type { ActionContext, ActionRegistry } from './core/actions.ts'
import type { TaskRecord } from './core/tasks.ts'
import type { SettlementEvent } from './host-ledger.ts'

/** The ledger surface the dispatcher needs (satisfied by `HostTaskLedger`). */
export interface SettlementLedger {
  onSettled(listener: (event: SettlementEvent) => void): () => void
  taskById(id: string): TaskRecord | undefined
}

/** Resolves an action's config by id; `undefined` disables that action. */
export interface ActionConfigSource {
  get(actionId: string): unknown
}

export class ActionDispatcher {
  private dispose: (() => void) | undefined

  constructor(
    private readonly ledger: SettlementLedger,
    private readonly registry: ActionRegistry,
    private readonly config: ActionConfigSource,
  ) {}

  start(): void {
    if (this.dispose !== undefined) return
    this.dispose = this.ledger.onSettled(event => { void this.dispatch(event) })
  }

  stop(): void {
    this.dispose?.()
    this.dispose = undefined
  }

  /** Dispatch the settled execution to every matching, configured action. */
  async dispatch(event: SettlementEvent): Promise<void> {
    const task = this.ledger.taskById(event.taskId)
    if (task === undefined) return
    const execution = task.executions.find(entry => entry.id === event.executionId)
    if (execution === undefined) return
    for (const action of this.registry.all()) {
      if (!action.when.includes(event.outcome) && !action.when.includes('always')) continue
      const config = this.config.get(action.id)
      if (config === undefined) continue
      const context: ActionContext = { task, execution, sessionId: event.sessionId, config }
      try {
        await action.run(context)
      } catch (error) {
        console.error(`[dsh-task-board] action ${action.id} failed for ${event.taskId}`, error)
      }
    }
  }
}
