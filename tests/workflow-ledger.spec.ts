import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostTaskLedger } from '../src/host-ledger.ts'
import type { WorkflowCreateInput } from '../src/core/workflows.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-all-tasks-workflows-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function input(name = 'Deploy'): WorkflowCreateInput {
  return {
    name,
    nodes: [
      { id: 'n1', type: 'event', ref: 'http', position: { x: 0, y: 0 } },
      { id: 'n2', type: 'task', ref: 'task-1', position: { x: 200, y: 0 } },
      { id: 'n3', type: 'action', ref: 'http', position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  }
}

describe('HostTaskLedger workflows', () => {
  it('persists a created workflow in the ledger state', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    try {
      const result = ledger.applyRequest('wf-create-1', { kind: 'create-workflow', id: 'wf-1', input: input() })
      expect(result.state.workflows).toHaveLength(1)
      expect(result.state.workflows[0]!.id).toBe('wf-1')
      expect(result.state.workflows[0]!.nodes).toHaveLength(3)
    } finally {
      ledger.dispose()
    }
  })

  it('rejects an invalid graph (task as the start node)', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    try {
      const bad = input()
      // Drop the event node so the first node is the task.
      bad.nodes = bad.nodes.slice(1)
      bad.edges = [{ id: 'e2', source: 'n2', target: 'n3' }]
      expect(() => ledger.applyRequest('wf-create-2', { kind: 'create-workflow', id: 'wf-2', input: bad }))
        .toThrow('invalid workflow')
    } finally {
      ledger.dispose()
    }
  })

  it('updates and deletes a workflow', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    try {
      ledger.applyRequest('wf-create-3', { kind: 'create-workflow', id: 'wf-3', input: input() })
      const updated = ledger.applyRequest('wf-update-3', {
        kind: 'update-workflow',
        workflowId: 'wf-3',
        patch: { name: 'Renamed' },
      })
      expect(updated.state.workflows[0]!.name).toBe('Renamed')

      const deleted = ledger.applyRequest('wf-delete-3', { kind: 'delete-workflow', workflowId: 'wf-3' })
      expect(deleted.state.workflows).toHaveLength(0)
    } finally {
      ledger.dispose()
    }
  })

  it('rejects an update of an unknown workflow', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    try {
      expect(() => ledger.applyRequest('wf-update-missing', {
        kind: 'update-workflow',
        workflowId: 'missing',
        patch: { name: 'X' },
      })).toThrow('workflow not found or invalid patch')
    } finally {
      ledger.dispose()
    }
  })

  it('survives a restart (loaded from the persisted document)', () => {
    const root = tempRoot()
    const first = new HostTaskLedger(root, () => NOW)
    first.applyRequest('wf-create-4', { kind: 'create-workflow', id: 'wf-4', input: input('Persisted') })
    first.dispose()

    const restarted = new HostTaskLedger(root, () => NOW)
    try {
      expect(restarted.state().workflows).toHaveLength(1)
      expect(restarted.state().workflows[0]!.name).toBe('Persisted')
    } finally {
      restarted.dispose()
    }
  })
})
