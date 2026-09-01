/**
 * Apply guard tests: the all-tasks client bundle must mount exactly once per
 * page lifetime, even when the module factory runs more than once (duplicated
 * client injection). The full apply() is not exercised here because it wires
 * DOM mounting, React portals, and the runtime context; the guard itself is
 * the unit under test, and apply() early-returns on a losing claim.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { claimAllTasksApply, releaseAllTasksApply } from '../src/client/apply-guard.ts'

describe('claimAllTasksApply', () => {
  beforeEach(() => {
    globalThis.__dshAllTasksApplied = undefined
  })

  it('grants the first claim', () => {
    expect(claimAllTasksApply()).toBe(true)
  })

  it('rejects later claims in the same page lifetime', () => {
    expect(claimAllTasksApply()).toBe(true)
    expect(claimAllTasksApply()).toBe(false)
    expect(claimAllTasksApply()).toBe(false)
  })

  it('keeps rejecting across independent module instances', () => {
    // Simulates two factory runs: each run is a separate module instance,
    // but they share one globalThis flag.
    expect(claimAllTasksApply()).toBe(true)
    expect(claimAllTasksApply()).toBe(false)
    expect(globalThis.__dshAllTasksApplied).toBe(true)
  })

  it('grants again after the claim is released (fiber unload / hot-reload)', () => {
    expect(claimAllTasksApply()).toBe(true)
    releaseAllTasksApply()
    expect(claimAllTasksApply()).toBe(true)
  })

  it('grants again after a full page reload (flag cleared)', () => {
    expect(claimAllTasksApply()).toBe(true)
    globalThis.__dshAllTasksApplied = undefined
    expect(claimAllTasksApply()).toBe(true)
  })
})
