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
  groupWindowOpen,
  isGroupExecutionMode,
  nextRunnableMember,
  normalizeGroupOrder,
  normalizeGroupRows,
  normalizeMaxParallel,
  orderedGroupMembers,
  withGroupMembershipChange,
  withGroupOrder,
  withGroupScheduleRoll,
  type TaskGroupRecord,
} from '../src/core/groups.ts'
import { createTask, type TaskRecord } from '../src/core/tasks.ts'

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

  it('rolls a group schedule forward and keeps lastTriggeredAt on later rolls', () => {
    const group = createGroup({ name: 'G' }, NOW, 'g1')!
    const armed = applyUpdateGroup([group], 'g1', { schedule: { enabled: true, cron: '0 9 * * *' } }, NOW)
    const rolled = withGroupScheduleRoll(armed.groups, 'g1', NOW + 86_400_000, NOW + 1, NOW + 1)
    expect(rolled[0]!.schedule).toMatchObject({ nextRunAt: NOW + 86_400_000, lastTriggeredAt: NOW + 1 })
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
      { id: 'g1', name: 'Good', mode: 'parallel', maxParallel: 2, stopped: true, order: ['t2'], schedule: { enabled: true, cron: '0 9 * * *' } },
      { id: 'g1', name: 'Duplicate' },
      { id: '', name: 'No id' },
      { id: 'g3', name: '   ' },
      { id: 'g4', name: 'Bad schedule', schedule: { enabled: true, cron: 'x' } },
      { id: 'g5', name: 'Bad max', maxParallel: 0 },
    ]
    const groups = normalizeGroupRows(rows, tasks)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ id: 'g1', name: 'Good', mode: 'parallel', maxParallel: 2, stopped: true })
    expect(groups[0]!.order).toEqual(['t2', 't1'])
    expect(groups[0]!.schedule).toMatchObject({ enabled: true, cron: '0 9 * * *' })
    // A malformed schedule is dropped with the group kept.
    expect(groups[1]!.id).toBe('g4')
    expect(groups[1]!.schedule).toBeUndefined()
    // A malformed maxParallel is dropped with the group kept.
    expect(groups[2]!.id).toBe('g5')
    expect(groups[2]!.maxParallel).toBeUndefined()
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
})
