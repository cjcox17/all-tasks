/**
 * task-tools: the DSH tools an agent session uses to create and inspect board
 * tasks — `task_create`, `task_list`, and `task_get`. They are the Host side of
 * "an AI session can create other tasks": every mutation goes through the same
 * fail-closed protocol path as the browser (the Host ledger + action union), so
 * a disabled board refuses creates and every ledger validation (blank title,
 * unknown/mismatched group, invalid cron) applies unchanged.
 *
 * Agent-created tasks are minted with `source: 'agent'` (the board shows the
 * badge) and DEFAULT to unapproved: a task created here can never run by any
 * means until a human approves it on the board, unless the caller explicitly
 * passes `approved: true`.
 *
 * The tools are deliberately read/create only — no update, run, approve, or
 * delete: those remain human board actions, so an agent can queue work but
 * never mutate or execute existing tasks on its own.
 */
import { randomUUID } from 'node:crypto'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ALL_STATUSES, isTaskApproved, openExecutionOf, TASK_PERMISSIONS, type NewTaskInput, type TaskRecord, type TaskSource } from './core/tasks.ts'
import type { AllTasksAction } from './protocol.ts'

/** Host seam the tools call through (wired to `AllTasksHostService` in index.ts). */
export interface TaskToolsDeps {
  /** Current Host tasks (the read path for `task_list` / `task_get`). */
  snapshot(): { tasks: readonly TaskRecord[] }
  /**
   * Apply one Host action through the same fail-closed path as the browser
   * (the `task_create` write path; throws when the board is disabled).
   */
  apply(requestId: string, action: Extract<AllTasksAction, { kind: 'create' }>): { tasks: readonly TaskRecord[] }
}

/** Compact on-board row shared by `task_create` and `task_list` results. */
interface TaskRow {
  id: string
  title: string
  status: TaskRecord['status']
  workspaceId?: string
  groupId?: string
  approved: boolean
  source: TaskSource
}

function taskRow(task: TaskRecord): TaskRow {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    approved: isTaskApproved(task),
    source: task.source ?? 'user',
    ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
    ...(task.groupId === undefined ? {} : { groupId: task.groupId }),
  }
}

/** The create tool's canonical output value (see {@link TASK_CREATE_OUTPUT}). */
interface TaskCreateValue extends TaskRow {}

/** The list tool's canonical output value (see {@link TASK_LIST_OUTPUT}). */
interface TaskListValue {
  tasks: Array<TaskRow & { scheduled: boolean; running: boolean }>
  total: number
}

/** The get tool's canonical output value (see {@link TASK_GET_OUTPUT}). */
interface TaskGetValue {
  id: string
  title: string
  description: string
  prompt: string
  status: TaskRecord['status']
  createdAt: number
  updatedAt: number
  workspaceId?: string
  mode?: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  endpoints?: string[]
  groupId?: string
  permission?: string
  approved: boolean
  source: TaskSource
  archived: boolean
  scheduled: boolean
  nextRunAt?: number
  executions: Array<{
    id: string
    sessionId?: string
    startedAt: number
    endedAt?: number
    result?: 'succeeded' | 'failed' | 'cancelled'
    error?: string
  }>
}

export const TASK_CREATE_TOOL_NAME = 'task_create'
export const TASK_LIST_TOOL_NAME = 'task_list'
export const TASK_GET_TOOL_NAME = 'task_get'

const TASK_STATUS_ENUM = [...ALL_STATUSES] as const

/**
 * Build the three agent task tools against a Host seam. Each is registered on
 * `ctx.tools` by the plugin loader (see `src/index.ts`).
 * @param deps - the Host snapshot/apply seam.
 * @returns the three tool definitions, in registration order.
 */
export function createTaskTools(deps: TaskToolsDeps): ToolDefinition[] {
  return [
    defineTool({
      name: TASK_CREATE_TOOL_NAME,
      description: 'Create a task on the all-tasks board (the kanban of DSH agent tasks). The task is queued as backlog work for a future run: it is minted UNAPPROVED by default, so it can never run by any means (manual, cron, or group) until a human approves it on the board — pass `approved: true` only when the user explicitly wants it immediately runnable. The created task is marked with the `agent` source badge. Check `task_list` first to avoid duplicates, and `task_get` to read a task afterwards. The `prompt` is what a DSH agent session will receive when the task runs.',
      parameters: {
        title: {
          type: 'string',
          required: true,
          description: 'Short display title for the task.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: 'The run prompt the task sends to a DSH agent session when it executes.',
        },
        description: {
          type: 'string',
          description: 'Optional longer description shown on the board; empty means none.',
        },
        workspaceId: {
          type: 'string',
          description: 'Workspace the task must run in (a DSH workspace-list id); omit for the default/recent workspace.',
        },
        mode: {
          type: 'string',
          description: 'Agent preset the execution session must be composed from (an agentPreset.list id); omit for the deployment default.',
        },
        model: {
          type: 'object',
          additionalProperties: false,
          description: 'Provider + model the execution session must be pinned to; omit for the deployment default model.',
          properties: {
            provider: {
              type: 'string',
              required: true,
              description: 'Registered provider route id (for example `deepseek`).',
            },
            model: {
              type: 'string',
              required: true,
              description: 'Provider-owned model id (for example `deepseek-chat`).',
            },
            reasoningEffort: {
              type: 'string',
              description: 'Optional reasoning-effort level: minimal, low, medium, high, or the provider\'s own value.',
            },
          },
        },
        endpoints: {
          type: 'array',
          description: 'Priority-ordered endpoint ids the router must route this task through; omit for the global default list.',
          items: { type: 'string' },
        },
        groupId: {
          type: 'string',
          description: 'Task group to join (a group id, workspace-scoped); omit to leave the task ungrouped.',
        },
        permission: {
          type: 'string',
          enum: TASK_PERMISSIONS,
          description: 'Permission preset applied to the execution session (`/permission <id>`); omit for the session default.',
        },
        schedule: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional schedule: arm the task\'s cron at creation time (the ledger only arms valid 5-field expressions).',
          properties: {
            enabled: {
              type: 'boolean',
              required: true,
              description: 'Whether the schedule is armed.',
            },
            cron: {
              type: 'string',
              required: true,
              description: '5-field cron expression in the Host local time zone: minute hour day-of-month month day-of-week.',
            },
          },
        },
        approved: {
          type: 'boolean',
          description: 'Defaults to `false`. `true` mints the task approved (immediately runnable) — use only when the user explicitly asked for that.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: TASK_STATUS_ENUM },
            workspaceId: { type: 'string' },
            groupId: { type: 'string' },
            approved: { type: 'boolean', required: true },
            source: { type: 'string', required: true },
          },
        },
        render: (_args, value: TaskCreateValue) => [{
          type: 'text',
          text: `Created task ${JSON.stringify(value.title)} (${value.id}) — status ${value.status}, ${value.approved ? 'approved (may run)' : 'unapproved (cannot run until a human approves it on the board)'}.`,
        }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Create a board task',
        kind: 'other',
        rawInput: args.title,
      }),
      async execute(args): Promise<TaskCreateValue> {
        const input: NewTaskInput = {
          title: args.title,
          description: args.description ?? '',
          prompt: args.prompt,
          // Agent-created tasks carry the `agent` origin badge; they default
          // to unapproved (human sign-off) unless the caller opted in.
          source: 'agent',
          approved: args.approved === true,
          ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
          ...(args.mode === undefined ? {} : { mode: args.mode }),
          ...(args.model === undefined ? {} : {
            model: {
              provider: args.model.provider,
              model: args.model.model,
              ...(args.model.reasoningEffort === undefined ? {} : { reasoningEffort: args.model.reasoningEffort }),
            },
          }),
          ...(args.endpoints === undefined ? {} : { endpoints: args.endpoints }),
          ...(args.groupId === undefined ? {} : { groupId: args.groupId }),
          ...(args.permission === undefined ? {} : { permission: args.permission }),
          ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
        }
        const taskId = randomUUID()
        const snapshot = deps.apply(randomUUID(), { kind: 'create', id: taskId, input })
        const task = snapshot.tasks.find(candidate => candidate.id === taskId)
        if (task === undefined) throw new Error('task_create: the ledger did not return the created task')
        return taskRow(task)
      },
    }),
    defineTool({
      name: TASK_LIST_TOOL_NAME,
      description: 'List the tasks currently on the all-tasks board (the kanban of DSH agent tasks), most recent first. Every row carries the task id (use it with `task_get`), status, approval state, and origin badge. Archived tasks and execution history are excluded; use `task_get` for one task\'s full detail. Check this before `task_create` to avoid duplicates.',
      parameters: {
        status: {
          type: 'string',
          enum: TASK_STATUS_ENUM,
          description: 'Only tasks in this column: backlog, todo, running, done, or failed. Omit for every on-board task.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tasks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true, enum: TASK_STATUS_ENUM },
                  workspaceId: { type: 'string' },
                  groupId: { type: 'string' },
                  approved: { type: 'boolean', required: true },
                  source: { type: 'string', required: true },
                  scheduled: { type: 'boolean', required: true },
                  running: { type: 'boolean', required: true },
                },
              },
            },
            total: { type: 'integer', required: true },
          },
        },
        render: (_args, value: TaskListValue) => [{
          type: 'text',
          text: value.total === 0
            ? 'The board has no matching tasks.'
            : `Found ${value.total} task(s): ${value.tasks.map(row => `${JSON.stringify(row.title)} (${row.id}, ${row.status}${row.approved ? '' : ', unapproved'})`).join('; ')}`,
        }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'List board tasks',
        kind: 'other',
        rawInput: args.status ?? 'all statuses',
      }),
      async execute(args): Promise<TaskListValue> {
        const tasks = deps.snapshot().tasks
          .filter(task => task.archivedAt === undefined && (args.status === undefined || task.status === args.status))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(task => ({
            ...taskRow(task),
            scheduled: task.schedule?.enabled === true,
            running: openExecutionOf(task) !== undefined,
          }))
        return { tasks, total: tasks.length }
      },
    }),
    defineTool({
      name: TASK_GET_TOOL_NAME,
      description: 'Read one task from the all-tasks board in full: its title, description, run prompt, status, execution targets (workspace, mode, model, endpoints, group, permission), approval state, origin badge, schedule, and execution history summary. Use the id from `task_create` or `task_list`. Throws when the id is unknown.',
      parameters: {
        taskId: {
          type: 'string',
          required: true,
          description: 'The task id to read.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            description: { type: 'string', required: true },
            prompt: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: TASK_STATUS_ENUM },
            createdAt: { type: 'integer', required: true },
            updatedAt: { type: 'integer', required: true },
            workspaceId: { type: 'string' },
            mode: { type: 'string' },
            model: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                reasoningEffort: { type: 'string' },
              },
            },
            endpoints: { type: 'array', items: { type: 'string' } },
            groupId: { type: 'string' },
            permission: { type: 'string' },
            approved: { type: 'boolean', required: true },
            source: { type: 'string', required: true },
            archived: { type: 'boolean', required: true },
            scheduled: { type: 'boolean', required: true },
            nextRunAt: { type: 'integer' },
            executions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  sessionId: { type: 'string' },
                  startedAt: { type: 'integer', required: true },
                  endedAt: { type: 'integer' },
                  result: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value: TaskGetValue) => [{
          type: 'text',
          text: `Task ${JSON.stringify(value.title)} (${value.id}) — status ${value.status}, ${value.approved ? 'approved' : 'unapproved'}, source ${value.source}, ${value.executions.length} execution(s).`,
        }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Get board task',
        kind: 'other',
        rawInput: args.taskId,
      }),
      async execute(args): Promise<TaskGetValue> {
        const task = deps.snapshot().tasks.find(candidate => candidate.id === args.taskId)
        if (task === undefined) throw new Error(`task_get: no task with id ${JSON.stringify(args.taskId)}`)
        return {
          id: task.id,
          title: task.title,
          description: task.description,
          prompt: task.prompt,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          approved: isTaskApproved(task),
          source: task.source ?? 'user',
          archived: task.archivedAt !== undefined,
          scheduled: task.schedule?.enabled === true,
          ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
          ...(task.mode === undefined ? {} : { mode: task.mode }),
          ...(task.model === undefined ? {} : { model: task.model }),
          ...(task.endpoints === undefined ? {} : { endpoints: task.endpoints }),
          ...(task.groupId === undefined ? {} : { groupId: task.groupId }),
          ...(task.permission === undefined ? {} : { permission: task.permission }),
          ...(task.schedule?.nextRunAt === undefined ? {} : { nextRunAt: task.schedule.nextRunAt }),
          executions: task.executions.map(execution => ({
            id: execution.id,
            startedAt: execution.startedAt,
            ...(execution.sessionId === undefined ? {} : { sessionId: execution.sessionId }),
            ...(execution.endedAt === undefined ? {} : { endedAt: execution.endedAt }),
            ...(execution.result === undefined ? {} : { result: execution.result }),
            ...(execution.error === undefined ? {} : { error: execution.error }),
          })),
        }
      },
    }),
  ]
}
