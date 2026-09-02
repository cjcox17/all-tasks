import { describe, expect, it } from 'vitest'
import { parseActionEnvelope } from '../src/protocol.ts'

const NODES = [
  { id: 'n1', type: 'event', ref: 'http', position: { x: 0, y: 0 } },
  { id: 'n2', type: 'action', ref: 'http', position: { x: 300, y: 0 } },
]
const EDGES = [{ id: 'e1', source: 'n1', target: 'n2' }]

describe('workflow actions protocol', () => {
  it('accepts a create-workflow action and trims the name', () => {
    const parsed = parseActionEnvelope({
      requestId: 'wf-1',
      action: { kind: 'create-workflow', id: 'wf-a', input: { name: '  Deploy  ', nodes: NODES, edges: EDGES } },
    })
    expect(parsed?.action.kind).toBe('create-workflow')
    if (parsed?.action.kind === 'create-workflow') {
      expect(parsed.action.input.name).toBe('Deploy')
      expect(parsed.action.input.nodes).toHaveLength(2)
    }
  })

  it('rejects a create-workflow with malformed nodes', () => {
    expect(parseActionEnvelope({
      requestId: 'wf-2',
      action: { kind: 'create-workflow', id: 'wf-b', input: { name: 'X', nodes: [{ id: 'n1' }], edges: [] } },
    })).toBeUndefined()
  })

  it('rejects a create-workflow with a too-long description', () => {
    expect(parseActionEnvelope({
      requestId: 'wf-3',
      action: { kind: 'create-workflow', id: 'wf-c', input: { name: 'X', description: 'x'.repeat(5000), nodes: NODES, edges: EDGES } },
    })).toBeUndefined()
  })

  it('rejects a create-workflow missing the edges field', () => {
    expect(parseActionEnvelope({
      requestId: 'wf-4',
      action: { kind: 'create-workflow', id: 'wf-d', input: { name: 'X', nodes: NODES } },
    })).toBeUndefined()
  })

  it('accepts an update-workflow patch with partial fields', () => {
    const parsed = parseActionEnvelope({
      requestId: 'wf-5',
      action: { kind: 'update-workflow', workflowId: 'wf-a', patch: { name: 'Renamed' } },
    })
    expect(parsed?.action.kind).toBe('update-workflow')
  })

  it('rejects an update-workflow patch with an unknown field', () => {
    expect(parseActionEnvelope({
      requestId: 'wf-6',
      action: { kind: 'update-workflow', workflowId: 'wf-a', patch: { bogus: true } },
    })).toBeUndefined()
  })

  it('rejects an update-workflow patch with a null-free malformed description', () => {
    expect(parseActionEnvelope({
      requestId: 'wf-7',
      action: { kind: 'update-workflow', workflowId: 'wf-a', patch: { description: 42 } },
    })).toBeUndefined()
  })

  it('accepts a delete-workflow action', () => {
    expect(parseActionEnvelope({
      requestId: 'wf-8',
      action: { kind: 'delete-workflow', workflowId: 'wf-a' },
    })?.action.kind).toBe('delete-workflow')
  })

  it('rejects a delete-workflow action without a workflowId', () => {
    expect(parseActionEnvelope({
      requestId: 'wf-9',
      action: { kind: 'delete-workflow' },
    })).toBeUndefined()
  })
})
