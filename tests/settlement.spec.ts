import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger, type SettlementEvent } from '../src/host-ledger.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-settle-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('HostTaskLedger settlement', () => {
  it('stores the summary and emits one settlement event', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create-1', { kind: 'create', id: 't1', input: { source: 'user', title: 'T', description: '', prompt: 'p' } })
    ledger.applyRequest('run-1', { kind: 'run', taskId: 't1' })
    const executionId = ledger.state().tasks[0].executions[0].id
    const events: SettlementEvent[] = []
    ledger.onSettled(event => events.push(event))

    ledger.settle('t1', executionId, 'succeeded', undefined, 'the answer')

    const execution = ledger.state().tasks[0].executions[0]
    expect(execution.result).toBe('succeeded')
    expect(execution.summary).toBe('the answer')
    expect(events).toEqual([{ taskId: 't1', executionId, outcome: 'succeeded', summary: 'the answer' }])
    ledger.dispose()
  })

  it('does not emit for an unknown or already-settled execution', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create-1', { kind: 'create', id: 't1', input: { source: 'user', title: 'T', description: '', prompt: 'p' } })
    ledger.applyRequest('run-1', { kind: 'run', taskId: 't1' })
    const executionId = ledger.state().tasks[0].executions[0].id
    const events: SettlementEvent[] = []
    ledger.onSettled(event => events.push(event))

    ledger.settle('t1', 'missing', 'failed', 'nope')
    expect(events).toHaveLength(0)

    ledger.settle('t1', executionId, 'succeeded')
    ledger.settle('t1', executionId, 'failed') // already settled: no second event
    expect(events).toHaveLength(1)
    ledger.dispose()
  })
})
