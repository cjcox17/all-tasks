import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import type { AllTasksAction } from '../src/protocol.ts'
import {
  createTaskTools,
  TASK_CREATE_TOOL_NAME,
  TASK_DELETE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_LIST_WORKSPACES_TOOL_NAME,
  type TaskToolsDeps,
  type WorkspaceRow,
} from '../src/task-tools.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const roots: string[] = []

/** Fake DSH workspace-registry rows (ids are UUIDs, never filesystem paths). */
const FAKE_WORKSPACES: readonly WorkspaceRow[] = [
  { workspaceId: 'f851445a-5d85-4219-8ce4-805031142726', title: 'all-tasks', path: '/Users/cjcox17/Projects/all-tasks' },
  { workspaceId: 'c0ffee00-0000-4000-8000-0000000000aa', title: 'Random Sessions', path: '/Users/cjcox17/Projects/Random Sessions' },
]

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-all-tasks-tools-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A real temp-dir ledger behind the narrow tool seam (exercises the full create path). */
function harness(): { deps: TaskToolsDeps; ledger: HostTaskLedger; tools: ToolDefinition[] } {
  const ledger = new HostTaskLedger(tempRoot())
  const deps: TaskToolsDeps = {
    snapshot: () => ({ tasks: ledger.state().tasks }),
    apply: (requestId, action) => {
      const result = ledger.applyRequest(requestId, action as AllTasksAction)
      return { tasks: result.state.tasks }
    },
    workspaces: async () => FAKE_WORKSPACES,
  }
  return { deps, ledger, tools: createTaskTools(deps) }
}

function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  expect(tool, `tool ${name} is registered`).toBeDefined()
  return tool!
}

function execute<T>(tool: ToolDefinition, args: unknown): Promise<T> {
  return tool.execute(args, {} as never) as Promise<T>
}

describe('task_create tool', () => {
  it('mints an unapproved agent-sourced task by default', async () => {
    const { ledger, tools } = harness()
    const created = await execute<{ id: string; title: string; status: string; approved: boolean; source: string }>(
      toolOf(tools, TASK_CREATE_TOOL_NAME),
      { title: 'Ship the report', prompt: 'Write the weekly report and file it' },
    )
    expect(created.title).toBe('Ship the report')
    expect(created.status).toBe('todo')
    expect(created.approved).toBe(false)
    expect(created.source).toBe('agent')
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    const task = ledger.taskById(created.id)
    expect(task?.title).toBe('Ship the report')
    expect(task?.prompt).toBe('Write the weekly report and file it')
    expect(task?.approved).toBe(false)
    expect(task?.source).toBe('agent')
    expect(task?.status).toBe('todo')
  })

  it('mints an approved task when approved: true is passed explicitly', async () => {
    const { ledger, tools } = harness()
    const created = await execute<{ id: string; approved: boolean }>(
      toolOf(tools, TASK_CREATE_TOOL_NAME),
      { title: 'Runnable now', prompt: 'go', approved: true },
    )
    expect(created.approved).toBe(true)
    // The ledger persists only the explicit unapproved state; `true` is the
    // default, so the field is absent (which reads as approved).
    expect(ledger.taskById(created.id)?.approved).toBeUndefined()
  })

  it('persists execution targets and arms a valid schedule', async () => {
    const { ledger, tools } = harness()
    const created = await execute<{ id: string }>(
      toolOf(tools, TASK_CREATE_TOOL_NAME),
      {
        title: 'Targeted',
        description: 'desc',
        prompt: 'run with targets',
        workspaceId: 'ws-1',
        mode: 'anchored',
        model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' },
        endpoints: ['deepseek-official'],
        permission: 'workspace-write',
        schedule: { enabled: true, cron: '30 8 * * *' },
      },
    )
    const task = ledger.taskById(created.id)
    expect(task?.workspaceId).toBe('ws-1')
    expect(task?.mode).toBe('anchored')
    expect(task?.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' })
    expect(task?.endpoints).toEqual(['deepseek-official'])
    expect(task?.permission).toBe('workspace-write')
    expect(task?.schedule?.enabled).toBe(true)
    expect(task?.schedule?.cron).toBe('30 8 * * *')
    expect(task?.schedule?.nextRunAt).toBeTypeOf('number')
  })

  it('joins a group the task workspace matches', async () => {
    const { ledger, tools } = harness()
    ledger.applyRequest('group', { kind: 'create-group', id: 'g1', input: { name: 'Seq', workspaceId: 'ws-a' } })
    const created = await execute<{ id: string; groupId?: string }>(
      toolOf(tools, TASK_CREATE_TOOL_NAME),
      { title: 'Member', prompt: 'work', workspaceId: 'ws-a', groupId: 'g1' },
    )
    expect(created.groupId).toBe('g1')
    expect(ledger.taskById(created.id)?.groupId).toBe('g1')
  })

  it('rejects a blank title through the ledger', async () => {
    const { tools } = harness()
    await expect(execute(toolOf(tools, TASK_CREATE_TOOL_NAME), { title: '   ', prompt: 'x' }))
      .rejects.toThrow('invalid task')
  })

  it('rejects an unknown group', async () => {
    const { tools } = harness()
    await expect(execute(toolOf(tools, TASK_CREATE_TOOL_NAME), { title: 'T', prompt: 'x', groupId: 'nope' }))
      .rejects.toThrow('group not found')
  })

  it('rejects a group that does not match the task workspace', async () => {
    const { ledger, tools } = harness()
    ledger.applyRequest('group', { kind: 'create-group', id: 'g1', input: { name: 'Seq', workspaceId: 'ws-a' } })
    await expect(execute(toolOf(tools, TASK_CREATE_TOOL_NAME), { title: 'T', prompt: 'x', workspaceId: 'ws-b', groupId: 'g1' }))
      .rejects.toThrow('group does not belong to the task workspace')
  })

  it('rejects an invalid cron', async () => {
    const { tools } = harness()
    await expect(execute(toolOf(tools, TASK_CREATE_TOOL_NAME), { title: 'T', prompt: 'x', schedule: { enabled: true, cron: 'not a cron' } }))
      .rejects.toThrow('invalid schedule')
  })

  it('propagates a disabled-board refusal', async () => {
    const ledger = new HostTaskLedger(tempRoot())
    ledger.dispose()
    const deps: TaskToolsDeps = {
      snapshot: () => ({ tasks: [] }),
      apply: () => { throw new Error('task board is disabled') },
      workspaces: async () => [],
    }
    const tools = createTaskTools(deps)
    await expect(execute(toolOf(tools, TASK_CREATE_TOOL_NAME), { title: 'T', prompt: 'x' }))
      .rejects.toThrow('task board is disabled')
  })
})

describe('task_list tool', () => {
  it('lists on-board tasks as compact rows with approval, source, and running state', async () => {
    const { ledger, tools } = harness()
    ledger.applyRequest('create-a', { kind: 'create', id: 't1', input: { title: 'A', description: '', prompt: 'a', source: 'agent', approved: false } })
    ledger.applyRequest('create-b', { kind: 'create', id: 't2', input: { title: 'B', description: '', prompt: 'b', source: 'user' } })
    const list = await execute<{ tasks: Array<{ id: string; title: string; approved: boolean; source: string; running: boolean; scheduled: boolean }>; total: number }>(
      toolOf(tools, TASK_LIST_TOOL_NAME),
      {},
    )
    expect(list.total).toBe(2)
    const byId = new Map(list.tasks.map(row => [row.id, row]))
    expect(byId.get('t1')).toMatchObject({ title: 'A', approved: false, source: 'agent', running: false, scheduled: false })
    expect(byId.get('t2')).toMatchObject({ title: 'B', approved: true, source: 'user', running: false, scheduled: false })
  })

  it('filters by status and excludes archived tasks', async () => {
    const { ledger, tools } = harness()
    ledger.applyRequest('create-a', { kind: 'create', id: 't1', input: { title: 'A', description: '', prompt: 'a' } })
    ledger.applyRequest('create-b', { kind: 'create', id: 't2', input: { title: 'B', description: '', prompt: 'b' } })
    // Settle t2 into done, then archive it: archived tasks leave the list.
    const run = ledger.applyRequest('run-t2', { kind: 'run', taskId: 't2' }).run
    ledger.settle('t2', run!.execution.id, 'succeeded')
    ledger.applyRequest('archive-t2', { kind: 'archive', taskId: 't2' })
    ledger.applyRequest('move-t1', { kind: 'move', taskId: 't1', status: 'backlog' })
    const all = await execute<{ tasks: Array<{ id: string }> }>(toolOf(tools, TASK_LIST_TOOL_NAME), {})
    expect(all.tasks.map(row => row.id)).toEqual(['t1'])
    const backlog = await execute<{ tasks: Array<{ id: string }> }>(toolOf(tools, TASK_LIST_TOOL_NAME), { status: 'backlog' })
    expect(backlog.tasks.map(row => row.id)).toEqual(['t1'])
    const todo = await execute<{ tasks: Array<{ id: string }> }>(toolOf(tools, TASK_LIST_TOOL_NAME), { status: 'todo' })
    expect(todo.tasks).toEqual([])
  })
})

describe('task_get tool', () => {
  it('returns full detail including prompt, targets, and execution summary', async () => {
    const { ledger, tools } = harness()
    ledger.applyRequest('create', {
      kind: 'create',
      id: 't1',
      input: { title: 'Deep', description: 'desc', prompt: 'do it', workspaceId: 'ws-1', source: 'agent', approved: false },
    })
    const detail = await execute<{ id: string; title: string; prompt: string; workspaceId: string; approved: boolean; source: string; archived: boolean; scheduled: boolean; executions: unknown[] }>(
      toolOf(tools, TASK_GET_TOOL_NAME),
      { taskId: 't1' },
    )
    expect(detail).toMatchObject({
      id: 't1',
      title: 'Deep',
      description: 'desc',
      prompt: 'do it',
      workspaceId: 'ws-1',
      approved: false,
      source: 'agent',
      archived: false,
      scheduled: false,
      executions: [],
    })
  })

  it('throws for an unknown task id', async () => {
    const { tools } = harness()
    await expect(execute(toolOf(tools, TASK_GET_TOOL_NAME), { taskId: 'missing' }))
      .rejects.toThrow('no task with id')
  })
})

describe('task_list_workspaces tool', () => {
  it('returns every workspace row (UUID id, title, path) with a matching total', async () => {
    const { tools } = harness()
    const list = await execute<{ workspaces: Array<{ workspaceId: string; title: string; path: string }>; total: number }>(
      toolOf(tools, TASK_LIST_WORKSPACES_TOOL_NAME),
      {},
    )
    expect(list.total).toBe(2)
    expect(list.workspaces).toEqual([
      { workspaceId: 'f851445a-5d85-4219-8ce4-805031142726', title: 'all-tasks', path: '/Users/cjcox17/Projects/all-tasks' },
      { workspaceId: 'c0ffee00-0000-4000-8000-0000000000aa', title: 'Random Sessions', path: '/Users/cjcox17/Projects/Random Sessions' },
    ])
  })

  it('case-insensitively substring-filters over id, title, and path and recounts total', async () => {
    const { tools } = harness()
    const tool = toolOf(tools, TASK_LIST_WORKSPACES_TOOL_NAME)
    const byId = await execute<{ workspaces: Array<{ workspaceId: string }>; total: number }>(tool, { query: 'F851445A' })
    expect(byId.total).toBe(1)
    expect(byId.workspaces.map(row => row.workspaceId)).toEqual(['f851445a-5d85-4219-8ce4-805031142726'])
    const byTitle = await execute<{ workspaces: Array<{ title: string }>; total: number }>(tool, { query: 'random' })
    expect(byTitle.total).toBe(1)
    expect(byTitle.workspaces[0]?.title).toBe('Random Sessions')
    const byPath = await execute<{ workspaces: Array<{ workspaceId: string }>; total: number }>(tool, { query: 'Projects/Random' })
    expect(byPath.total).toBe(1)
    expect(byPath.workspaces[0]?.workspaceId).toBe('c0ffee00-0000-4000-8000-0000000000aa')
    const none = await execute<{ workspaces: unknown[]; total: number }>(tool, { query: 'no such workspace' })
    expect(none.total).toBe(0)
    expect(none.workspaces).toEqual([])
  })

  it('maps seam rows with an optional path (no live ApiProxy needed)', async () => {
    const ledger = new HostTaskLedger(tempRoot())
    const deps: TaskToolsDeps = {
      snapshot: () => ({ tasks: ledger.state().tasks }),
      apply: (requestId, action) => {
        const result = ledger.applyRequest(requestId, action as AllTasksAction)
        return { tasks: result.state.tasks }
      },
      workspaces: async () => [{ workspaceId: '11111111-2222-4333-8444-555555555555', title: 'Solo' }],
    }
    const list = await execute<{ workspaces: Array<{ workspaceId: string; title: string; path?: string }>; total: number }>(
      toolOf(createTaskTools(deps), TASK_LIST_WORKSPACES_TOOL_NAME),
      {},
    )
    expect(list.total).toBe(1)
    expect(list.workspaces).toEqual([{ workspaceId: '11111111-2222-4333-8444-555555555555', title: 'Solo' }])
    expect(list.workspaces[0]?.path).toBeUndefined()
  })
})

describe('task_delete tool', () => {
  it('registers task_delete as a fourth tool', () => {
    const { tools } = harness()
    expect(tools.map(tool => tool.name)).toContain(TASK_DELETE_TOOL_NAME)
    expect(toolOf(tools, TASK_DELETE_TOOL_NAME).name).toBe(TASK_DELETE_TOOL_NAME)
  })

  it('deletes an existing task and returns the confirmation', async () => {
    const { ledger, tools } = harness()
    const created = await execute<{ id: string; title: string }>(
      toolOf(tools, TASK_CREATE_TOOL_NAME),
      { title: 'Remove me', prompt: 'work' },
    )
    const deleted = await execute<{ deleted: boolean; id: string; title: string }>(
      toolOf(tools, TASK_DELETE_TOOL_NAME),
      { taskId: created.id },
    )
    expect(deleted).toEqual({ deleted: true, id: created.id, title: 'Remove me' })
    // The ledger really dropped the task (the tool must go through the Host
    // delete path, not hide the row).
    expect(ledger.taskById(created.id)).toBeUndefined()
  })

  it('throws when the id is unknown', async () => {
    const { tools } = harness()
    await expect(execute(toolOf(tools, TASK_DELETE_TOOL_NAME), { taskId: 'missing' }))
      .rejects.toThrow('task not found')
  })

  it('throws when the task is running', async () => {
    const { ledger, tools } = harness()
    // Create an approved task and open an execution on it (ledger `run` moves
    // it to running), then delete must refuse through the same ledger rule.
    ledger.applyRequest('create', { kind: 'create', id: 't-busy', input: { title: 'Busy', description: '', prompt: 'go' } })
    ledger.applyRequest('run', { kind: 'run', taskId: 't-busy' })
    await expect(execute(toolOf(tools, TASK_DELETE_TOOL_NAME), { taskId: 't-busy' }))
      .rejects.toThrow('running task cannot be deleted')
    // The running task survives the refused delete.
    expect(ledger.taskById('t-busy')?.title).toBe('Busy')
  })
})
