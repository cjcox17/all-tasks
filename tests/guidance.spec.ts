import { describe, expect, it } from 'vitest'
import { ALL_TASKS_GUIDANCE } from '../src/index.ts'

describe('all-tasks model guidance', () => {
  it('tells agents to close visible todo_write plans before the final answer', () => {
    expect(ALL_TASKS_GUIDANCE).toContain('todo_write')
    expect(ALL_TASKS_GUIDANCE).toContain('最终回复前')
    expect(ALL_TASKS_GUIDANCE).toContain('completed')
  })

  it('announces the agent task-creation tools and their unapproved default', () => {
    expect(ALL_TASKS_GUIDANCE).toContain('task_create')
    expect(ALL_TASKS_GUIDANCE).toContain('task_list')
    expect(ALL_TASKS_GUIDANCE).toContain('task_get')
    expect(ALL_TASKS_GUIDANCE).toContain('approved: true')
  })
})
