import { describe, expect, it } from 'vitest'
import {
  applyCreateWorkflow,
  applyDeleteWorkflow,
  applyUpdateWorkflow,
  normalizeWorkflowEdges,
  normalizeWorkflowNodes,
  normalizeWorkflowRows,
  validateWorkflowGraph,
  workflowHasCycle,
  WORKFLOW_GRAPH_ERRORS,
  WORKFLOW_MAX_NODES,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowRecord,
} from '../src/core/workflows.ts'

const NOW = 1000

function node(id: string, type: WorkflowNode['type'], ref = 'http', x = 0, y = 0): WorkflowNode {
  return { id, type, ref, position: { x, y } }
}

function edge(id: string, source: string, target: string): WorkflowEdge {
  return { id, source, target }
}

const EVENT = node('e', 'event')
const TASK = node('t', 'task', 'task-1')
const ACTION = node('a', 'action')

describe('validateWorkflowGraph', () => {
  it('accepts a minimal event → action workflow', () => {
    expect(validateWorkflowGraph([EVENT, ACTION], [edge('1', 'e', 'a')])).toEqual([])
  })

  it('accepts an event → task → action chain with events/actions in the middle', () => {
    const a2 = node('a2', 'action')
    const e2 = node('e2', 'event', 'github')
    const nodes = [EVENT, e2, TASK, a2, ACTION]
    const edges = [
      edge('1', 'e', 'e2'),
      edge('2', 'e2', 't'),
      edge('3', 't', 'a2'),
      edge('4', 'a2', 'a'),
    ]
    expect(validateWorkflowGraph(nodes, edges)).toEqual([])
  })

  it('rejects an empty node list', () => {
    expect(validateWorkflowGraph([], [])).toEqual([WORKFLOW_GRAPH_ERRORS.NO_NODES])
  })

  it('rejects a task as the start node', () => {
    const result = validateWorkflowGraph([TASK, ACTION], [edge('1', 't', 'a')])
    expect(result).toContain(WORKFLOW_GRAPH_ERRORS.SOURCE_NOT_EVENT)
  })

  it('rejects a task as the end node', () => {
    const result = validateWorkflowGraph([EVENT, TASK], [edge('1', 'e', 't')])
    expect(result).toContain(WORKFLOW_GRAPH_ERRORS.SINK_NOT_ACTION)
  })

  it('rejects a cycle', () => {
    const a2 = node('a2', 'action')
    const nodes = [EVENT, TASK, a2, ACTION]
    const edges = [edge('1', 'e', 't'), edge('2', 't', 'a2'), edge('3', 'a2', 't'), edge('4', 'a2', 'a')]
    expect(workflowHasCycle(nodes, edges)).toBe(true)
    expect(validateWorkflowGraph(nodes, edges)).toEqual([WORKFLOW_GRAPH_ERRORS.CYCLE])
  })

  it('rejects a self loop', () => {
    const result = validateWorkflowGraph([EVENT, ACTION], [edge('1', 'e', 'e')])
    expect(result).toContain(WORKFLOW_GRAPH_ERRORS.SELF_LOOP)
  })

  it('rejects an edge referencing a missing node', () => {
    const result = validateWorkflowGraph([EVENT, ACTION], [edge('1', 'e', 'missing')])
    expect(result).toContain(WORKFLOW_GRAPH_ERRORS.DANGLING_EDGE)
  })

  it('rejects duplicate node ids', () => {
    const dup = node('e', 'action')
    const result = validateWorkflowGraph([EVENT, dup], [])
    expect(result).toContain(WORKFLOW_GRAPH_ERRORS.DUPLICATE_NODE)
  })

  it('requires both an event source and an action sink', () => {
    const result = validateWorkflowGraph([EVENT], [])
    expect(result).toContain(WORKFLOW_GRAPH_ERRORS.SINK_NOT_ACTION)
    expect(result).toContain(WORKFLOW_GRAPH_ERRORS.MISSING_ENDPOINTS)
  })
})

describe('normalizeWorkflowNodes / normalizeWorkflowEdges', () => {
  it('normalizes a valid node list', () => {
    const result = normalizeWorkflowNodes([EVENT, { ...TASK, label: '  Do it  ' }])
    expect(result).toHaveLength(2)
    expect(result?.[1]?.label).toBe('Do it')
  })

  it('rejects a node with a bad type', () => {
    expect(normalizeWorkflowNodes([{ ...EVENT, type: 'wat' }])).toBeUndefined()
  })

  it('rejects a node with a non-finite position', () => {
    expect(normalizeWorkflowNodes([{ ...EVENT, position: { x: NaN, y: 0 } }])).toBeUndefined()
  })

  it('rejects a node list exceeding the bound', () => {
    const many = Array.from({ length: WORKFLOW_MAX_NODES + 1 }, (_, i) => node(`n${i}`, 'event'))
    expect(normalizeWorkflowNodes(many)).toBeUndefined()
  })

  it('rejects a malformed edge', () => {
    expect(normalizeWorkflowEdges([{ id: 'e', source: 'a' }])).toBeUndefined()
  })
})

describe('applyCreateWorkflow / applyUpdateWorkflow / applyDeleteWorkflow', () => {
  it('creates a workflow when the graph is valid', () => {
    const result = applyCreateWorkflow([], { name: '  Deploy  ', nodes: [EVENT, ACTION], edges: [edge('1', 'e', 'a')] }, NOW, 'w1')
    expect(result.workflow).toMatchObject({ id: 'w1', name: 'Deploy' })
    expect(result.workflows).toHaveLength(1)
  })

  it('rejects a blank name', () => {
    const result = applyCreateWorkflow([], { name: '  ', nodes: [EVENT, ACTION], edges: [edge('1', 'e', 'a')] }, NOW, 'w1')
    expect(result.workflow).toBeUndefined()
  })

  it('rejects an invalid graph', () => {
    const result = applyCreateWorkflow([], { name: 'X', nodes: [TASK, ACTION], edges: [edge('1', 't', 'a')] }, NOW, 'w1')
    expect(result.workflow).toBeUndefined()
  })

  it('updates name, clears description, and replaces nodes/edges', () => {
    const created = applyCreateWorkflow([], { name: 'A', description: 'desc', nodes: [EVENT, ACTION], edges: [edge('1', 'e', 'a')] }, NOW, 'w1')
    const base: WorkflowRecord[] = [...created.workflows]
    const result = applyUpdateWorkflow(base, 'w1', {
      name: 'B',
      description: '',
      nodes: [EVENT, TASK, ACTION],
      edges: [edge('1', 'e', 't'), edge('2', 't', 'a')],
    }, NOW + 1)
    expect(result.applied).toBe(true)
    const updated = result.workflows[0]!
    expect(updated.name).toBe('B')
    expect(updated.description).toBeUndefined()
    expect(updated.nodes).toHaveLength(3)
    expect(updated.edges).toHaveLength(2)
  })

  it('rejects an update that produces an invalid graph', () => {
    const created = applyCreateWorkflow([], { name: 'A', nodes: [EVENT, ACTION], edges: [edge('1', 'e', 'a')] }, NOW, 'w1')
    const result = applyUpdateWorkflow([...created.workflows], 'w1', { nodes: [TASK], edges: [] }, NOW + 1)
    expect(result.applied).toBe(false)
  })

  it('rejects an update of an unknown workflow', () => {
    expect(applyUpdateWorkflow([], 'missing', { name: 'X' }, NOW).applied).toBe(false)
  })

  it('deletes a workflow', () => {
    const created = applyCreateWorkflow([], { name: 'A', nodes: [EVENT, ACTION], edges: [edge('1', 'e', 'a')] }, NOW, 'w1')
    const result = applyDeleteWorkflow([...created.workflows], 'w1')
    expect(result.applied).toBe(true)
    expect(result.workflows).toHaveLength(0)
  })
})

describe('normalizeWorkflowRows', () => {
  it('keeps valid rows, drops malformed nodes and dangling edges', () => {
    const rows = [
      { id: 'w1', name: 'A', nodes: [EVENT, ACTION], edges: [edge('1', 'e', 'a')], createdAt: 1, updatedAt: 2 },
      { id: 'w2', name: 'B', nodes: [EVENT, TASK, ACTION], edges: [edge('1', 'e', 't'), edge('2', 't', 'missing'), edge('3', 't', 'a')], createdAt: 1, updatedAt: 2 },
      { id: 'w3', name: 'C', nodes: [], edges: [], createdAt: 1, updatedAt: 2 },
      { id: 'w4', name: '', nodes: [EVENT, ACTION], edges: [], createdAt: 1, updatedAt: 2 },
    ]
    const result = normalizeWorkflowRows(rows)
    expect(result.map(w => w.id)).toEqual(['w1', 'w2'])
    // The dangling edge referencing `missing` is dropped.
    expect(result[1]!.edges.map(e => e.id)).toEqual(['1', '3'])
  })

  it('drops duplicate ids', () => {
    const row = { id: 'w1', name: 'A', nodes: [EVENT, ACTION], edges: [edge('1', 'e', 'a')], createdAt: 1, updatedAt: 2 }
    const result = normalizeWorkflowRows([row, row])
    expect(result).toHaveLength(1)
  })
})
