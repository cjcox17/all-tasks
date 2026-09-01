/**
 * Create-task use case: mint a new task from user input, rejecting a blank
 * title. Pure ledger transition (no persistence or notify — the controller
 * orchestrates those), so it is unit-testable without any runtime face.
 */
import { isValidCron, nextRunAtMs } from '../schedule.ts'
import { createTask, withSchedule, type NewTaskInput, type TaskRecord } from '../tasks.ts'

/** Result of a create transition: the new task (when accepted) + the next ledger. */
export interface CreateTaskResult {
  /** The minted task, or undefined when the input was rejected (blank title). */
  task: TaskRecord | undefined
  /** The next ledger; identical reference when rejected. */
  tasks: readonly TaskRecord[]
}

/**
 * Apply a create against the current ledger. Returns the new task and the
 * appended ledger, or the unchanged ledger when the title is blank.
 *
 * A task minted by a non-user origin (a script, another tool, or the event
 * webhook — `source` other than `user`) is unapproved by default: it can
 * never run until a human approves it, and it lands on the board with the
 * "Not approved" badge instead of silently appearing and starting. The
 * creator can override the gate by passing `approved: true` explicitly (the
 * webhook's autoRun flow does), so the default only guards the common
 * programmatic case.
 * @param tasks - current ledger.
 * @param input - raw user input (title/description/prompt + optional schedule).
 * @param now - clock instant (ms epoch).
 * @param id - minted task id.
 */
export function applyCreateTask(
  tasks: readonly TaskRecord[],
  input: NewTaskInput,
  now: number,
  id: string,
): CreateTaskResult {
  if (input.title.trim() === '') return { task: undefined, tasks }
  // Only the board's own dialog (source `user`) or an explicit `approved: true`
  // mints an approved task; every other programmatic create lands unapproved.
  const effective: NewTaskInput = input.source === 'user' || input.approved === true
    ? input
    : { ...input, approved: false }
  let task = createTask(effective, now, id)
  // Arm the requested schedule (new-task dialog): only an enabled rule with
  // a valid cron is applied; blank, invalid, or disabled requests leave the
  // task unscheduled.
  const requested = input.schedule
  if (requested?.enabled === true && requested.cron.trim() !== '' && isValidCron(requested.cron)) {
    const cron = requested.cron.trim()
    task = withSchedule(task, { enabled: true, cron, nextRunAt: nextRunAtMs(cron, now) }, now)
  }
  return { task, tasks: [...tasks, task] }
}
