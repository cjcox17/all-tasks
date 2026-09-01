/**
 * Task-groups core tests: normalization, membership/order transitions, update
 * semantics, and the pure execution-policy helpers (capacity, window, order).
 */
import { describe, expect, it } from 'vitest'
import {
  applyCreateGroup,
  applyDeleteGroup,
  applyUpdateGroup,
  createGroup,
  effectiveEndpointIds,
  groupCapacityFull,
  groupCompactsBetween,
  groupFinalStepBlocked,
  groupFinalStepReady,
  groupRuntimeStatus,
  groupSequenceStarted,
  groupSharesSession,
  groupWindowOpen,
  isGroupExecutionMode,
  nextRunnableMember,
  normalizeGroupOrder,
  normalizeGroupRows,
  normalizeMaxParallel,
  orderedGroupMembers,
  taskMatchesGroupScope,
  withGroupMembershipChange,
  withGroupOrder,
  withGroupScheduleRoll,
  type TaskGroupRecord,
} from '../src/core/groups.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'

const NOW = 1_700_000_000_000

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: `Task ${id}`, description: '', prompt: 'work' }, NOW, id), ...overrides }
}

describe('group normalization', () => {
  it('creates a group with sequential default, empty order, and no extras', () => {
    const group = createGroup({ name: '  Nightly  ' }, NOW, 'g1')
    expect(group).toMatchObject({ id: 'g1', name: 'Nightly', mode: 'sequential', offPeakOnly: false, order: [], createdAt: NOW, updatedAt: NOW })
    expect(group?.maxParallel).toBeUndefined()
    expect(group?.endpoints).toBeUndefined()
    expect(group?.schedule).toBeUndefined()
    expect(group?.allowedHours).toBeUndefined()
  })

  it('rejects a blank or oversized name', () => {
    expect(createGroup({ name: '   ' }, NOW, 'g1')).toBeUndefined()
    expect(createGroup({ name: 'x'.repeat(257) }, NOW, 'g1')).toBeUndefined()
  })

  it('normalizes mode, maxParallel, endpoints, window, and schedule at creation', () => {
    const group = createGroup({
      name: 'Batch',
      mode: 'parallel',
      maxParallel: 3,
      endpoints: ['cloud', '', 'cloud', 'local'],
      allowedHours: { start: '22:00', end: '06:00' },
      offPeakOnly: true,
      schedule: { enabled: true, cron: '0 2 * * *' },
    }, NOW, 'g1')!
    expect(group.mode).toBe('parallel')
    expect(group.maxParallel).toBe(3)
    expect(group.endpoints).toEqual(['cloud', 'local'])
    expect(group.allowedHours).toEqual({ start: '22:00', end: '06:00' })
    expect(group.offPeakOnly).toBe(true)
    expect(group.schedule).toMatchObject({ enabled: true, cron: '0 2 * * *' })
    expect(group.schedule?.nextRunAt).toBeDefined()
  })

  it('ignores a disabled or invalid creation schedule', () => {
    expect(createGroup({ name: 'A', schedule: { enabled: false, cron: '0 9 * * *' } }, NOW, 'g1')?.schedule).toBeUndefined()
    expect(createGroup({ name: 'B', schedule: { enabled: true, cron: 'not cron' } }, NOW, 'g1')?.schedule).toBeUndefined()
  })

  it('bounds and coerces maxParallel', () => {
    expect(normalizeMaxParallel(0)).toBeUndefined()
    expect(normalizeMaxParallel(1.5)).toBeUndefined()
    expect(normalizeMaxParallel(1025)).toBeUndefined()
    expect(normalizeMaxParallel(2)).toBe(2)
    expect(isGroupExecutionMode('sequential')).toBe(true)
    expect(isGroupExecutionMode('parallel')).toBe(true)
    expect(isGroupExecutionMode('other')).toBe(false)
  })
})

describe('membership and order', () => {
  it('appends a member to the order on assignment and removes it on leave', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const assigned = withGroupMembershipChange([group], 't1', undefined, 'g1', NOW + 1)
    expect(assigned[0]!.order).toEqual(['t1'])
    const moved = withGroupMembershipChange(assigned, 't1', 'g1', undefined, NOW + 2)
    expect(moved[0]!.order).toEqual([])
  })

  it('moves a member between groups (leaves the old order, joins the new)', () => {
    const a = createGroup({ name: 'A' }, NOW, 'g-a')!
    const b = createGroup({ name: 'B' }, NOW, 'g-b')!
    const withMember = withGroupMembershipChange([a, b], 't1', undefined, 'g-a', NOW + 1)
    const moved = withGroupMembershipChange(withMember, 't1', 'g-a', 'g-b', NOW + 2)
    expect(moved.find(g => g.id === 'g-a')!.order).toEqual([])
    expect(moved.find(g => g.id === 'g-b')!.order).toEqual(['t1'])
  })

  it('clears the final-step designation when the designated member leaves the group', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const withMember = withGroupOrder([group], 'g1', ['t1', 't2'], ['t1', 't2'], NOW)[0]!
    const designated = applyUpdateGroup([withMember], 'g1', { finalStepTaskId: 't2' }, NOW + 1).groups[0]!
    expect(designated.finalStepTaskId).toBe('t2')
    const removed = withGroupMembershipChange([designated], 't2', 'g1', undefined, NOW + 2)
    expect(removed[0]!.finalStepTaskId).toBeUndefined()
    expect(removed[0]!.order).toEqual(['t1'])
  })

  it('normalizes an order to exactly the members (listed first, rest appended)', () => {
    expect(normalizeGroupOrder(['t2', 'unknown', 't1', 't2'], ['t1', 't2', 't3'])).toEqual(['t2', 't1', 't3'])
    expect(normalizeGroupOrder(undefined, ['t1', 't2'])).toEqual(['t1', 't2'])
  })

  it('replaces the order via withGroupOrder and bumps updatedAt', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const reordered = withGroupOrder([group], 'g1', ['t2', 't1'], ['t1', 't2'], NOW + 1)
    expect(reordered[0]!.order).toEqual(['t2', 't1'])
    expect(reordered[0]!.updatedAt).toBe(NOW + 1)
  })

  it('lists members in group order, with stragglers appended', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const tasks = [task('t1', { groupId: 'g1' }), task('t2', { groupId: 'g1' })]
    const ordered = withGroupOrder([group], 'g1', ['t2'], ['t1', 't2'], NOW + 1)[0]!
    expect(orderedGroupMembers(ordered, tasks).map(t => t.id)).toEqual(['t2', 't1'])
  })
})

describe('group update', () => {
  it('applies a patch and rejects invalid values wholesale', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const updated = applyUpdateGroup([group], 'g1', { name: 'Renamed', mode: 'parallel', maxParallel: 4, endpoints: ['cloud'], offPeakOnly: true }, NOW + 1)
    expect(updated.applied).toBe(true)
    expect(updated.groups[0]).toMatchObject({ name: 'Renamed', mode: 'parallel', maxParallel: 4, endpoints: ['cloud'], offPeakOnly: true })

    expect(applyUpdateGroup([group], 'g1', { name: '  ' }, NOW + 1).applied).toBe(false)
    expect(applyUpdateGroup([group], 'g1', { mode: 'sideways' as never }, NOW + 1).applied).toBe(false)
    expect(applyUpdateGroup([group], 'g1', { maxParallel: 0 }, NOW + 1).applied).toBe(false)
    expect(applyUpdateGroup([group], 'g1', { allowedHours: { start: '99:99', end: '00:00' } }, NOW + 1).applied).toBe(false)
    expect(applyUpdateGroup([group], 'g1', { schedule: { enabled: true, cron: 'nope' } }, NOW + 1).applied).toBe(false)
    expect(applyUpdateGroup([group], 'missing', { name: 'X' }, NOW + 1).applied).toBe(false)
  })

  it('clears fields with null and removes the schedule with null', () => {
    const group = createGroup({
      name: 'G', mode: 'parallel', maxParallel: 3, endpoints: ['cloud'],
      allowedHours: { start: '22:00', end: '06:00' }, schedule: { enabled: true, cron: '0 2 * * *' },
    }, NOW, 'g1')!
    const cleared = applyUpdateGroup([group], 'g1', { maxParallel: null, endpoints: null, allowedHours: null, schedule: null }, NOW + 1)
    expect(cleared.applied).toBe(true)
    const next = cleared.groups[0]!
    expect(next.maxParallel).toBeUndefined()
    expect(next.endpoints).toBeUndefined()
    expect(next.allowedHours).toBeUndefined()
    expect(next.schedule).toBeUndefined()
    expect(next.mode).toBe('parallel')
  })

  it('arms a schedule only when the cron is valid and computes nextRunAt', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const armed = applyUpdateGroup([group], 'g1', { schedule: { enabled: true, cron: '0 9 * * *' } }, NOW)
    expect(armed.applied).toBe(true)
    expect(armed.groups[0]!.schedule).toMatchObject({ enabled: true, cron: '0 9 * * *' })
    expect(armed.groups[0]!.schedule?.nextRunAt).toBeDefined()
    const disarmed = applyUpdateGroup(armed.groups, 'g1', { schedule: { enabled: false, cron: '0 9 * * *' } }, NOW)
    expect(disarmed.groups[0]!.schedule?.enabled).toBe(false)
  })

  it('sets and clears the stopped flag through the update patch', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const stopped = applyUpdateGroup([group], 'g1', { stopped: true }, NOW + 1)
    expect(stopped.applied).toBe(true)
    expect(stopped.groups[0]!.stopped).toBe(true)
    const resumed = applyUpdateGroup(stopped.groups, 'g1', { stopped: false }, NOW + 2)
    expect(resumed.groups[0]!.stopped).toBeUndefined()
  })

  it('carries maintainSession and compactBetween through creation and the update patch', () => {
    const group = createGroup({ name: 'Seq', mode: 'sequential', maintainSession: true, compactBetween: true }, NOW, 'g1')!
    expect(group.maintainSession).toBe(true)
    expect(group.compactBetween).toBe(true)
    // Absent input keeps the flags off; false clears them again.
    const plain = createGroup({ name: 'Plain' }, NOW, 'g2')!
    expect(plain.maintainSession).toBeUndefined()
    expect(plain.compactBetween).toBeUndefined()

    const cleared = applyUpdateGroup([group], 'g1', { maintainSession: false, compactBetween: false }, NOW + 1)
    expect(cleared.applied).toBe(true)
    expect(cleared.groups[0]!.maintainSession).toBeUndefined()
    expect(cleared.groups[0]!.compactBetween).toBeUndefined()

    const rearmed = applyUpdateGroup(cleared.groups, 'g1', { maintainSession: true, compactBetween: true }, NOW + 2)
    expect(rearmed.groups[0]!.maintainSession).toBe(true)
    expect(rearmed.groups[0]!.compactBetween).toBe(true)
  })

  it('rolls a group schedule forward and keeps lastTriggeredAt on later rolls', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const armed = applyUpdateGroup([group], 'g1', { schedule: { enabled: true, cron: '0 9 * * *' } }, NOW)
    const rolled = withGroupScheduleRoll(armed.groups, 'g1', NOW + 86_400_000, NOW + 1, NOW + 1)
    expect(rolled[0]!.schedule).toMatchObject({ nextRunAt: NOW + 86_400_000, lastTriggeredAt: NOW + 1 })
  })

  it('sets and clears the final step through the update patch, requiring a member', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const withMember = withGroupOrder([group], 'g1', ['t1', 't2'], ['t1', 't2'], NOW)[0]!
    const designated = applyUpdateGroup([withMember], 'g1', { finalStepTaskId: 't2', finalStepRequireSuccess: true }, NOW + 1)
    expect(designated.applied).toBe(true)
    expect(designated.groups[0]).toMatchObject({ finalStepTaskId: 't2', finalStepRequireSuccess: true })

    // A non-member designation rejects the whole patch.
    expect(applyUpdateGroup([withMember], 'g1', { finalStepTaskId: 'stranger' }, NOW + 1).applied).toBe(false)

    const cleared = applyUpdateGroup(designated.groups, 'g1', { finalStepTaskId: null, finalStepRequireSuccess: false }, NOW + 2)
    expect(cleared.applied).toBe(true)
    expect(cleared.groups[0]!.finalStepTaskId).toBeUndefined()
    expect(cleared.groups[0]!.finalStepRequireSuccess).toBeUndefined()
  })
})

describe('group deletion and persisted rows', () => {
  it('deletes a group and ungroups its members (tasks stay)', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const withMember = withGroupMembershipChange([group], 't1', undefined, 'g1', NOW + 1)
    const tasks = [task('t1', { groupId: 'g1' }), task('t2')]
    const result = applyDeleteGroup(tasks, withMember, 'g1', NOW + 2)
    expect(result.applied).toBe(true)
    expect(result.groups).toHaveLength(0)
    expect(result.tasks.find(t => t.id === 't1')!.groupId).toBeUndefined()
    expect(result.tasks.find(t => t.id === 't2')!.groupId).toBeUndefined()
    expect(applyDeleteGroup(tasks, withMember, 'missing', NOW + 2).applied).toBe(false)
  })

  it('normalizes persisted rows (drops malformed, dedupes ids, repairs schedules, re-derives order)', () => {
    const tasks = [task('t1', { groupId: 'g1' }), task('t2', { groupId: 'g1' })]
    const rows = [
      { id: 'g1', name: 'Good', mode: 'parallel', maxParallel: 2, stopped: true, maintainSession: true, compactBetween: true, order: ['t2'], schedule: { enabled: true, cron: '0 9 * * *' } },
      { id: 'g1', name: 'Duplicate' },
      { id: '', name: 'No id' },
      { id: 'g3', name: '   ' },
      { id: 'g4', name: 'Bad schedule', schedule: { enabled: true, cron: 'x' } },
      { id: 'g5', name: 'Bad max', maxParallel: 0 },
    ]
    const groups = normalizeGroupRows(rows, tasks)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ id: 'g1', name: 'Good', mode: 'parallel', maxParallel: 2, stopped: true, maintainSession: true, compactBetween: true })
    expect(groups[0]!.order).toEqual(['t2', 't1'])
    expect(groups[0]!.schedule).toMatchObject({ enabled: true, cron: '0 9 * * *' })
    // A malformed schedule is dropped with the group kept.
    expect(groups[1]!.id).toBe('g4')
    expect(groups[1]!.schedule).toBeUndefined()
    // A malformed maxParallel is dropped with the group kept.
    expect(groups[2]!.id).toBe('g5')
    expect(groups[2]!.maxParallel).toBeUndefined()
  })

  it('normalizes the final-step designation from persisted rows and drops dangling references', () => {
    const withMember = task('t1', { groupId: 'g1' })
    const rows = [
      { id: 'g1', name: 'G', mode: 'parallel', offPeakOnly: false, order: ['t1'], finalStepTaskId: 't1', finalStepRequireSuccess: true },
      { id: 'g2', name: 'Dangling', mode: 'parallel', offPeakOnly: false, order: ['t1'], finalStepTaskId: 'stranger', finalStepRequireSuccess: true },
    ]
    const groups = normalizeGroupRows(rows, [withMember])
    expect(groups[0]!.finalStepTaskId).toBe('t1')
    expect(groups[0]!.finalStepRequireSuccess).toBe(true)
    // A reference that is not a member of the group's scope is dropped.
    expect(groups[1]!.finalStepTaskId).toBeUndefined()
    expect(groups[1]!.finalStepRequireSuccess).toBeUndefined()
  })
})

describe('workspace-scoped groups', () => {
  it('stores a normalized workspace scope at creation and drops a blank one', () => {
    const scoped = createGroup({ name: 'G', workspaceId: ' ws-1 ' }, NOW, 'g1')
    expect(scoped?.workspaceId).toBe('ws-1')
    const unassigned = createGroup({ name: 'G', workspaceId: '   ' }, NOW, 'g1')
    expect(unassigned?.workspaceId).toBeUndefined()
    const absent = createGroup({ name: 'G' }, NOW, 'g1')
    expect(absent?.workspaceId).toBeUndefined()
  })

  it('matches a task to a group only when the workspace pins agree (absent = unassigned)', () => {
    expect(taskMatchesGroupScope({ workspaceId: 'ws-a' }, { workspaceId: 'ws-a' })).toBe(true)
    expect(taskMatchesGroupScope({ workspaceId: 'ws-a' }, {})).toBe(false)
    expect(taskMatchesGroupScope({ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' })).toBe(false)
    expect(taskMatchesGroupScope({}, {})).toBe(true)
    expect(taskMatchesGroupScope({}, { workspaceId: 'ws-a' })).toBe(false)
  })

  it('orders members within the group scope only (foreign-workspace tasks never join the order)', () => {
    const group = createGroup({ name: 'G', workspaceId: 'ws-a' }, NOW, 'g1')!
    const tasks = [
      task('t-a', { workspaceId: 'ws-a', groupId: 'g1' }),
      task('t-u', { groupId: 'g1' }),
      task('t-b', { workspaceId: 'ws-b', groupId: 'g1' }),
    ]
    expect(orderedGroupMembers(group, tasks).map(t => t.id)).toEqual(['t-a'])
    const unassigned = createGroup({ name: 'U' }, NOW, 'g-u')!
    const unassignedTasks = [task('t-u2', { groupId: 'g-u' }), task('t-a', { workspaceId: 'ws-a', groupId: 'g1' })]
    expect(orderedGroupMembers(unassigned, unassignedTasks).map(t => t.id)).toEqual(['t-u2'])
  })

  it('keeps an explicit row scope and excludes foreign members from the order', () => {
    const tasks = [
      task('t-a', { workspaceId: 'ws-a', groupId: 'g1' }),
      task('t-u', { groupId: 'g1' }),
    ]
    const rows = [{ id: 'g1', name: 'A', workspaceId: 'ws-a', order: ['t-a', 't-u'] }]
    const groups = normalizeGroupRows(rows, tasks)
    expect(groups[0]!.workspaceId).toBe('ws-a')
    expect(groups[0]!.order).toEqual(['t-a'])
  })

  it('migrates a legacy row without a scope to its members\' single workspace', () => {
    const tasks = [
      task('t1', { workspaceId: 'ws-1', groupId: 'g1' }),
      task('t2', { workspaceId: 'ws-1', groupId: 'g1' }),
    ]
    const rows = [{ id: 'g1', name: 'Legacy', order: ['t2'] }]
    const groups = normalizeGroupRows(rows, tasks)
    expect(groups[0]!.workspaceId).toBe('ws-1')
    expect(groups[0]!.order).toEqual(['t2', 't1'])
  })

  it('flattens a mixed-workspace legacy row to the unassigned scope, keeping only unassigned members', () => {
    const tasks = [
      task('t1', { workspaceId: 'ws-1', groupId: 'g1' }),
      task('t2', { workspaceId: 'ws-2', groupId: 'g1' }),
      task('t3', { groupId: 'g1' }),
    ]
    const rows = [{ id: 'g1', name: 'Mixed', order: ['t1', 't2', 't3'] }]
    const groups = normalizeGroupRows(rows, tasks)
    expect(groups[0]!.workspaceId).toBeUndefined()
    expect(groups[0]!.order).toEqual(['t3'])
  })
})

describe('execution policy helpers', () => {
  it('resolves effective endpoints: task pin > group list > none', () => {
    const taskPin = { endpoints: ['task-endpoint'] }
    const groupList = { endpoints: ['group-endpoint'] }
    expect(effectiveEndpointIds(taskPin, groupList)).toEqual(['task-endpoint'])
    expect(effectiveEndpointIds({}, groupList)).toEqual(['group-endpoint'])
    expect(effectiveEndpointIds({}, undefined)).toBeUndefined()
  })

  it('lays the workspace default list after the task pin and the group list', () => {
    const taskPin = { endpoints: ['task-endpoint'] }
    const groupList = { endpoints: ['group-endpoint'] }
    const workspaceDefault = ['workspace-endpoint']
    expect(effectiveEndpointIds(taskPin, groupList, workspaceDefault)).toEqual(['task-endpoint'])
    expect(effectiveEndpointIds({}, groupList, workspaceDefault)).toEqual(['group-endpoint'])
    expect(effectiveEndpointIds({}, undefined, workspaceDefault)).toEqual(['workspace-endpoint'])
    // An empty or absent workspace list never fills in.
    expect(effectiveEndpointIds({}, undefined, [])).toBeUndefined()
    expect(effectiveEndpointIds({}, undefined, undefined)).toBeUndefined()
  })

  it('checks sequential/parallel capacity', () => {
    const sequential = { mode: 'sequential' as const }
    expect(groupCapacityFull(sequential, 0)).toBe(false)
    expect(groupCapacityFull(sequential, 1)).toBe(true)
    const parallel = { mode: 'parallel' as const, maxParallel: 2 }
    expect(groupCapacityFull(parallel, 0)).toBe(false)
    expect(groupCapacityFull(parallel, 2)).toBe(true)
    expect(groupCapacityFull(parallel, 3)).toBe(true)
    expect(groupCapacityFull({ mode: 'parallel' as const }, 100)).toBe(false)
  })

  it('gates the window by allowed hours and off-peak (weekday-aware DeepSeek schedule)', () => {
    const windowed = { allowedHours: { start: '12:00', end: '14:00' }, offPeakOnly: false }
    // Wed 2026-07-15 13:00 UTC = allowed-hours open.
    expect(groupWindowOpen(windowed, 13 * 60, new Date(Date.UTC(2026, 6, 15, 13)))).toBe(true)
    expect(groupWindowOpen(windowed, 10 * 60, new Date(Date.UTC(2026, 6, 15, 13)))).toBe(false)
    // Off-peak only: Wed 12:00 UTC is inside a peak block (06:00–10:00? no — 12:00 is off-peak).
    expect(groupWindowOpen({ allowedHours: undefined, offPeakOnly: true }, undefined, new Date(Date.UTC(2026, 6, 15, 12)))).toBe(true)
    // Wed 02:00 UTC is inside the first peak block (01:00–04:00) → blocked.
    expect(groupWindowOpen({ allowedHours: undefined, offPeakOnly: true }, undefined, new Date(Date.UTC(2026, 6, 15, 2)))).toBe(false)
    // Sat 02:00 UTC is fully off-peak (weekends unified since 2026-08-23).
    expect(groupWindowOpen({ allowedHours: undefined, offPeakOnly: true }, undefined, new Date(Date.UTC(2026, 6, 18, 2)))).toBe(true)
    // A missing local-minute probe skips the allowed-hours constraint.
    expect(groupWindowOpen(windowed, undefined, new Date(Date.UTC(2026, 6, 15, 13)))).toBe(true)
  })

  it('picks the next runnable member in order, skipping running/done/failed/archived', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const t1 = task('t1', { groupId: 'g1', status: 'done' })
    const t2 = task('t2', { groupId: 'g1', status: 'todo' })
    const t3 = task('t3', { groupId: 'g1', status: 'failed' })
    const t4 = task('t4', { groupId: 'g1', status: 'backlog' })
    const ordered = withGroupOrder([group], 'g1', ['t1', 't2', 't3', 't4'], ['t1', 't2', 't3', 't4'], NOW)[0]!
    expect(nextRunnableMember(ordered, [t1, t2, t3, t4])?.id).toBe('t2')

    const runningT2 = { ...t2, status: 'running' as const }
    expect(nextRunnableMember(ordered, [t1, runningT2, t3, t4])?.id).toBe('t4')

    const archivedT4 = { ...t4, archivedAt: NOW }
    expect(nextRunnableMember(ordered, [t1, runningT2, t3, archivedT4])).toBeUndefined()
  })

  it('shares a session only for sequential groups with maintainSession, and compacts only when both flags are set', () => {
    expect(groupSharesSession({ mode: 'sequential', maintainSession: true })).toBe(true)
    expect(groupSharesSession({ mode: 'sequential', maintainSession: false })).toBe(false)
    // Parallel groups never share a session (the flag is sequential-only).
    expect(groupSharesSession({ mode: 'parallel', maintainSession: true })).toBe(false)
    expect(groupCompactsBetween({ mode: 'sequential', maintainSession: true, compactBetween: true })).toBe(true)
    // Compaction requires the shared session; the flag alone is inert.
    expect(groupCompactsBetween({ mode: 'sequential', maintainSession: false, compactBetween: true })).toBe(false)
    expect(groupCompactsBetween({ mode: 'sequential', maintainSession: true, compactBetween: false })).toBe(false)
    expect(groupCompactsBetween({ mode: 'parallel', maintainSession: true, compactBetween: true })).toBe(false)
  })

  it('skips a held member (deferAutoStart) and picks the next runnable one', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const held = task('t1', { groupId: 'g1', status: 'todo', deferAutoStart: true })
    const t2 = task('t2', { groupId: 'g1', status: 'todo' })
    const ordered = withGroupOrder([group], 'g1', ['t1', 't2'], ['t1', 't2'], NOW)[0]!
    expect(nextRunnableMember(ordered, [held, t2])?.id).toBe('t2')

    // A group whose only runnable members are held advances nothing.
    expect(nextRunnableMember(ordered, [held])).toBeUndefined()
  })

  it('detects whether a group sequence has started (any member has an execution)', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const fresh = task('t1', { groupId: 'g1', status: 'todo' })
    expect(groupSequenceStarted(group, [fresh])).toBe(false)

    const ran = { ...fresh, executions: [{
      id: 'e1', sessionId: 's1', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined,
    }] }
    expect(groupSequenceStarted(group, [ran])).toBe(true)

    const settled = { ...fresh, executions: [{
      id: 'e2', sessionId: 's2', startedAt: NOW, endedAt: NOW + 1, result: 'succeeded' as const, error: undefined,
    }] }
    expect(groupSequenceStarted(group, [settled])).toBe(true)

    // Only members of THIS group count.
    const other = task('t2', { status: 'todo', executions: [{
      id: 'e3', sessionId: 's3', startedAt: NOW, endedAt: NOW + 1, result: 'succeeded' as const, error: undefined,
    }] })
    expect(groupSequenceStarted(group, [fresh, other])).toBe(false)
  })

  it('never auto-starts the group final step through the regular chain', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const ordered = withGroupOrder([group], 'g1', ['t1', 't2', 'final'], ['t1', 't2', 'final'], NOW)[0]!
    const designated = applyUpdateGroup([ordered], 'g1', { finalStepTaskId: 'final' }, NOW + 1).groups[0]!
    const t1 = task('t1', { groupId: 'g1', status: 'todo' })
    const t2 = task('t2', { groupId: 'g1', status: 'todo' })
    const finalStep = task('final', { groupId: 'g1', status: 'todo' })
    expect(nextRunnableMember(designated, [t1, t2, finalStep])?.id).toBe('t1')
    // Only the final step left: the chain advances nothing.
    const doneT1 = { ...t1, status: 'done' as const }
    const doneT2 = { ...t2, status: 'done' as const }
    expect(nextRunnableMember(designated, [doneT1, doneT2, finalStep])).toBeUndefined()
  })
})

describe('group final step gate', () => {
  /** A parallel group with members a+b and 'final' designated as the final step. */
  function gateGroup(): { group: TaskGroupRecord; tasks: TaskRecord[] } {
    const group = createGroup({ name: 'FanIn', mode: 'parallel' }, NOW, 'g1')!
    const ordered = withGroupOrder([group], 'g1', ['a', 'b', 'final'], ['a', 'b', 'final'], NOW)[0]!
    const designated = applyUpdateGroup([ordered], 'g1', { finalStepTaskId: 'final' }, NOW + 1).groups[0]!
    const tasks = [
      task('a', { groupId: 'g1', status: 'todo' }),
      task('b', { groupId: 'g1', status: 'todo' }),
      task('final', { groupId: 'g1', status: 'todo' }),
    ]
    return { group: designated, tasks }
  }

  /** A member that settled (done or failed) with one settled execution. */
  function settled(id: string, status: 'done' | 'failed'): TaskRecord {
    return {
      ...task(id, { groupId: 'g1', status }),
      executions: [{
        id: `e-${id}`, sessionId: 's', startedAt: NOW, endedAt: NOW + 1,
        result: status === 'done' ? 'succeeded' as const : 'failed' as const, error: undefined,
      }],
    }
  }

  it('is blocked while any member is unfinished and open once all settle', () => {
    const { group, tasks } = gateGroup()
    expect(groupFinalStepBlocked(group, tasks)).toBe(true)
    expect(groupFinalStepReady(group, tasks)).toBe(false)

    const midway = [settled('a', 'done'), tasks[1]!, tasks[2]!]
    expect(groupFinalStepBlocked(group, midway)).toBe(true)

    const allDone = [settled('a', 'done'), settled('b', 'done'), tasks[2]!]
    expect(groupFinalStepBlocked(group, allDone)).toBe(false)
    expect(groupFinalStepReady(group, allDone)).toBe(true)
  })

  it('treats a failed member as settled by default, but blocks under finalStepRequireSuccess', () => {
    const { group, tasks } = gateGroup()
    const oneFailed = [settled('a', 'done'), settled('b', 'failed'), tasks[2]!]
    expect(groupFinalStepBlocked(group, oneFailed)).toBe(false)
    expect(groupFinalStepReady(group, oneFailed)).toBe(true)

    const strict = applyUpdateGroup([group], 'g1', { finalStepRequireSuccess: true }, NOW + 1).groups[0]!
    expect(groupFinalStepBlocked(strict, oneFailed)).toBe(true)
    expect(groupFinalStepReady(strict, oneFailed)).toBe(false)
    // A successful rerun opens the gate again.
    const rerunSucceeded = [settled('a', 'done'), settled('b', 'done'), tasks[2]!]
    expect(groupFinalStepReady(strict, rerunSucceeded)).toBe(true)
  })

  it('a member with an open execution blocks the gate', () => {
    const { group, tasks } = gateGroup()
    const runningB = {
      ...tasks[1]!,
      status: 'running' as const,
      executions: [{ id: 'e-b', sessionId: 's', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }],
    }
    const state = [settled('a', 'done'), runningB, tasks[2]!]
    expect(groupFinalStepBlocked(group, state)).toBe(true)
    expect(groupFinalStepReady(group, state)).toBe(false)
  })

  it('archived members are out of the sequence and never block', () => {
    const { group, tasks } = gateGroup()
    const archivedB = { ...tasks[1]!, archivedAt: NOW }
    const state = [settled('a', 'done'), archivedB, tasks[2]!]
    expect(groupFinalStepBlocked(group, state)).toBe(false)
    expect(groupFinalStepReady(group, state)).toBe(true)
  })

  it('a settled final step itself is not ready again (one launch per cycle)', () => {
    const { group, tasks } = gateGroup()
    const ranFinal = settled('final', 'done')
    const state = [settled('a', 'done'), settled('b', 'done'), ranFinal]
    expect(groupFinalStepReady(group, state)).toBe(false)
    // Reset to a pre-execution column: ready for the next cycle.
    const resetFinal = { ...ranFinal, status: 'todo' as const }
    expect(groupFinalStepReady(group, [settled('a', 'done'), settled('b', 'done'), resetFinal])).toBe(true)
  })

  it('an unapproved, held, or open final step is not ready', () => {
    const { group, tasks } = gateGroup()
    const others = [settled('a', 'done'), settled('b', 'done')]
    expect(groupFinalStepReady(group, [...others, { ...tasks[2]!, approved: false }])).toBe(false)
    expect(groupFinalStepReady(group, [...others, { ...tasks[2]!, deferAutoStart: true }])).toBe(false)
    const openFinal = {
      ...tasks[2]!,
      status: 'running' as const,
      executions: [{ id: 'e-f', sessionId: 's', startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }],
    }
    expect(groupFinalStepReady(group, [...others, openFinal])).toBe(false)
  })

  it('a group with only the final step is ready as soon as it can run', () => {
    const group = createGroup({ name: 'Only' }, NOW, 'g1')!
    const ordered = withGroupOrder([group], 'g1', ['final'], ['final'], NOW)[0]!
    const designated = applyUpdateGroup([ordered], 'g1', { finalStepTaskId: 'final' }, NOW + 1).groups[0]!
    const finalStep = task('final', { groupId: 'g1', status: 'todo' })
    expect(groupFinalStepBlocked(designated, [finalStep])).toBe(false)
    expect(groupFinalStepReady(designated, [finalStep])).toBe(true)
  })
})

describe('group runtime status', () => {
  const group = createGroup({ name: 'G' }, NOW, 'g1')!

  /** An open (unsettled) execution; default = the brief pre-route window. */
  function openExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
    return {
      id: 'x1',
      sessionId: undefined,
      startedAt: NOW,
      endedAt: undefined,
      result: undefined,
      error: undefined,
      ...overrides,
    }
  }

  it('reports nothing for a group without open executions (or members)', () => {
    const member = task('t1', { groupId: 'g1', status: 'todo' })
    const ungrouped = task('t2', { status: 'todo' })
    expect(groupRuntimeStatus(group, [member, ungrouped])).toEqual({ running: 0, pending: 0, pendingReasons: [], finalStepWaiting: false })
    expect(groupRuntimeStatus(group, [])).toEqual({ running: 0, pending: 0, pendingReasons: [], finalStepWaiting: false })
  })

  it('counts launched members as running', () => {
    const t1 = task('t1', { groupId: 'g1', status: 'running', executions: [openExecution({ sessionId: 's1' })] })
    const t2 = task('t2', { groupId: 'g1', status: 'running', executions: [openExecution({ sessionId: 's2' })] })
    expect(groupRuntimeStatus(group, [t1, t2])).toEqual({ running: 2, pending: 0, pendingReasons: [], finalStepWaiting: false })
  })

  it('counts queued members as pending and collects their reasons in first-seen order', () => {
    const t1 = task('t1', { groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: NOW, queuedReason: 'group' })] })
    const t2 = task('t2', { groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: NOW, queuedReason: 'window' })] })
    const t3 = task('t3', { groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: NOW, queuedReason: 'endpoint' })] })
    expect(groupRuntimeStatus(group, [t1, t2, t3])).toEqual({
      running: 0,
      pending: 3,
      pendingReasons: ['group', 'window', 'endpoint'],
      finalStepWaiting: false,
    })
  })

  it('deduplicates pending reasons', () => {
    const t1 = task('t1', { groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: NOW, queuedReason: 'window' })] })
    const t2 = task('t2', { groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: NOW, queuedReason: 'window' })] })
    expect(groupRuntimeStatus(group, [t1, t2])).toEqual({ running: 0, pending: 2, pendingReasons: ['window'], finalStepWaiting: false })
  })

  it('treats an open pre-route execution without a reason as pending', () => {
    const t1 = task('t1', { groupId: 'g1', status: 'running', executions: [openExecution()] })
    expect(groupRuntimeStatus(group, [t1])).toEqual({ running: 0, pending: 1, pendingReasons: [], finalStepWaiting: false })
  })

  it('ignores settled executions and other groups', () => {
    const settled = task('t1', { groupId: 'g1', status: 'done', executions: [openExecution({ sessionId: 's1', endedAt: NOW + 1, result: 'succeeded' })] })
    const elsewhere = task('t2', { status: 'running', executions: [openExecution({ sessionId: 's9' })] })
    expect(groupRuntimeStatus(group, [settled, elsewhere])).toEqual({ running: 0, pending: 0, pendingReasons: [], finalStepWaiting: false })
  })

  it('mixes running and pending members (sequential hand-off)', () => {
    const launched = task('t1', { groupId: 'g1', status: 'running', executions: [openExecution({ sessionId: 's1' })] })
    const queued = task('t2', { groupId: 'g1', status: 'running', executions: [openExecution({ queuedAt: NOW, queuedReason: 'endpoint' })] })
    expect(groupRuntimeStatus(group, [launched, queued])).toEqual({ running: 1, pending: 1, pendingReasons: ['endpoint'], finalStepWaiting: false })
  })

  it('flags the final step as waiting while other members are unfinished', () => {
    const withFinalStep = (() => {
      const g = createGroup({ name: 'G' }, NOW, 'g2')!
      const ordered = withGroupOrder([g], 'g2', ['t1', 't2'], ['t1', 't2'], NOW)[0]!
      return applyUpdateGroup([ordered], 'g2', { finalStepTaskId: 't2' }, NOW + 1).groups[0]!
    })()
    const t1 = task('t1', { groupId: 'g2', status: 'todo' })
    const t2 = task('t2', { groupId: 'g2', status: 'todo' })
    expect(groupRuntimeStatus(withFinalStep, [t1, t2]).finalStepWaiting).toBe(true)
    const settledT1 = {
      ...t1,
      status: 'done' as const,
      executions: [{ id: 'e1', sessionId: 's1', startedAt: NOW, endedAt: NOW + 1, result: 'succeeded' as const, error: undefined }],
    }
    expect(groupRuntimeStatus(withFinalStep, [settledT1, t2]).finalStepWaiting).toBe(false)
  })
})

describe('group paused flag persistence', () => {
  it('normalizes a persisted paused flag and drops non-boolean values', () => {
    const task = createTask({ title: 'A', description: '', prompt: '' }, 1, 'task-a')
    const paused = normalizeGroupRows([{ id: 'g1', name: 'G', mode: 'sequential', offPeakOnly: false, paused: true, order: [] }], [task])
    expect(paused[0]?.paused).toBe(true)
    const absent = normalizeGroupRows([{ id: 'g2', name: 'G', mode: 'sequential', offPeakOnly: false, paused: 'yes', order: [] }], [task])
    expect(absent[0]?.paused).toBeUndefined()
    expect(absent[0]?.stopped).toBeUndefined()
  })
})
