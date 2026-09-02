/**
 * Workflows core: the workflow DAG record shape, normalization, graph
 * validation, and the pure create/update/delete transitions the Host ledger
 * and the board controller share. Framework-free (no cordis, no runtime
 * imports) so the Host, the browser controller, and unit tests share one
 * engine.
 *
 * A workflow is a directed acyclic graph (DAG) of nodes connected by edges:
 *  - `event` nodes are inbound triggers (they reference a registered event
 *    source id — http / github / slack);
 *  - `action` nodes are result-side side effects (they reference a registered
 *    action id — http / github / spawn);
 *  - `task` nodes reference an existing board task id (tasks stay independent
 *    entities; a workflow only points at them).
 *
 * The graph is constrained so that the beginning of the workflow is an event
 * and the end is an action: every source node (in-degree 0) must be an event,
 * and every sink node (out-degree 0) must be an action. Tasks therefore always
 * sit in the middle (they have both an incoming and an outgoing edge), while
 * events and actions may appear anywhere (source, interior, or sink).
 *
 * This is the definition layer only: no execution engine yet. Event webhooks
 * and the settle→action dispatcher keep working standalone.
 */

/** Bound on workflow ids / names / node refs / labels (defense-in-depth). */
export const WORKFLOW_FIELD_BOUND = 256
/** Bound on a workflow description string. */
export const WORKFLOW_DESCRIPTION_BOUND = 4096
/** Upper bound on how many nodes one workflow may define. */
export const WORKFLOW_MAX_NODES = 100
/** Upper bound on how many edges one workflow may define. */
export const WORKFLOW_MAX_EDGES = 200

/** The three node kinds a workflow DAG is composed of. */
export type WorkflowNodeType = 'event' | 'task' | 'action'

/** The closed node-kind union guard. */
export const WORKFLOW_NODE_TYPES: readonly WorkflowNodeType[] = ['event', 'task', 'action']

/** Brand an unknown value as a workflow node type. */
export function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return typeof value === 'string' && (WORKFLOW_NODE_TYPES as readonly string[]).includes(value)
}

/** Canvas position of one node (arbitrary world coordinates). */
export interface WorkflowNodePosition {
  x: number
  y: number
}

/** One node in a workflow DAG. */
export interface WorkflowNode {
  /** Stable node id (uuid). */
  id: string
  /** Node kind: trigger (event), board task, or side effect (action). */
  type: WorkflowNodeType
  /** Referenced entity id: event source id / action id / task id (by type). */
  ref: string
  /** Optional display label; defaults to the referenced entity's name. */
  label?: string
  /** Canvas position (world coordinates for the n8n-style editor). */
  position: WorkflowNodePosition
}

/** One directed connection between two nodes. */
export interface WorkflowEdge {
  /** Stable edge id (uuid). */
  id: string
  /** Source node id. */
  source: string
  /** Target node id. */
  target: string
}

/** One workflow on the board (a persisted DAG definition). */
export interface WorkflowRecord {
  /** Stable workflow id (uuid). */
  id: string
  /** Display name (not unique). */
  name: string
  /** Optional longer description. */
  description?: string
  /** The graph's nodes. */
  nodes: WorkflowNode[]
  /** The graph's directed edges. */
  edges: WorkflowEdge[]
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
}

/** Input for creating a workflow. */
export interface WorkflowCreateInput {
  name: string
  description?: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** Editable fields on a workflow (the update patch surface). */
export interface WorkflowUpdatePatch {
  name?: string
  description?: string
  nodes?: WorkflowNode[]
  edges?: WorkflowEdge[]
}

/** Normalize a workflow name: non-blank, bounded; undefined when invalid. */
export function normalizeWorkflowName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > WORKFLOW_FIELD_BOUND) return undefined
  return trimmed
}

/** Normalize a workflow description: any non-blank string, bounded; undefined otherwise. */
export function normalizeWorkflowDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return undefined
  if (value.trim() === '' || value.length > WORKFLOW_DESCRIPTION_BOUND) return undefined
  return value
}

/** Parse one node (strict: undefined on any malformed field). */
export function parseWorkflowNode(value: unknown): WorkflowNode | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' && row.id.trim() !== '' && row.id.length <= WORKFLOW_FIELD_BOUND
    ? row.id
    : undefined
  if (id === undefined || !isWorkflowNodeType(row.type)) return undefined
  const ref = typeof row.ref === 'string' && row.ref.trim() !== '' && row.ref.length <= WORKFLOW_FIELD_BOUND
    ? row.ref
    : undefined
  if (ref === undefined) return undefined
  const position = parseWorkflowPosition(row.position)
  if (position === undefined) return undefined
  const node: WorkflowNode = { id, type: row.type, ref, position }
  if (typeof row.label === 'string' && row.label.trim() !== '' && row.label.length <= WORKFLOW_FIELD_BOUND) {
    node.label = row.label.trim()
  }
  return node
}

function parseWorkflowPosition(value: unknown): WorkflowNodePosition | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (typeof row.x !== 'number' || !Number.isFinite(row.x)) return undefined
  if (typeof row.y !== 'number' || !Number.isFinite(row.y)) return undefined
  return { x: row.x, y: row.y }
}

/** Parse one edge (strict: undefined on any malformed field). */
export function parseWorkflowEdge(value: unknown): WorkflowEdge | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' && row.id.trim() !== '' && row.id.length <= WORKFLOW_FIELD_BOUND
    ? row.id
    : undefined
  const source = typeof row.source === 'string' && row.source.trim() !== '' && row.source.length <= WORKFLOW_FIELD_BOUND
    ? row.source
    : undefined
  const target = typeof row.target === 'string' && row.target.trim() !== '' && row.target.length <= WORKFLOW_FIELD_BOUND
    ? row.target
    : undefined
  if (id === undefined || source === undefined || target === undefined) return undefined
  return { id, source, target }
}

/**
 * Normalize a nodes array (strict): undefined when the value is not an array,
 * exceeds the bound, or any entry is malformed. Duplicate ids are NOT resolved
 * here — {@link validateWorkflowGraph} rejects them.
 */
export function normalizeWorkflowNodes(value: unknown): WorkflowNode[] | undefined {
  if (!Array.isArray(value) || value.length > WORKFLOW_MAX_NODES) return undefined
  const nodes: WorkflowNode[] = []
  for (const entry of value) {
    const node = parseWorkflowNode(entry)
    if (node === undefined) return undefined
    nodes.push(node)
  }
  return nodes
}

/**
 * Normalize an edges array (strict): undefined when the value is not an array,
 * exceeds the bound, or any entry is malformed. Dangling endpoints are NOT
 * resolved here — {@link validateWorkflowGraph} rejects them.
 */
export function normalizeWorkflowEdges(value: unknown): WorkflowEdge[] | undefined {
  if (!Array.isArray(value) || value.length > WORKFLOW_MAX_EDGES) return undefined
  const edges: WorkflowEdge[] = []
  for (const entry of value) {
    const edge = parseWorkflowEdge(entry)
    if (edge === undefined) return undefined
    edges.push(edge)
  }
  return edges
}

/**
 * Stable validation error codes (see {@link validateWorkflowGraph}). The
 * browser maps these to localized copy; the Host rejects with a generic
 * "invalid workflow" error since the browser validates before saving.
 */
export const WORKFLOW_GRAPH_ERRORS = {
  NO_NODES: 'workflow has no nodes',
  DUPLICATE_NODE: 'duplicate node id',
  DUPLICATE_EDGE: 'duplicate edge id',
  DANGLING_EDGE: 'edge references a missing node',
  SELF_LOOP: 'an edge cannot connect a node to itself',
  CYCLE: 'workflow contains a cycle',
  SOURCE_NOT_EVENT: 'every starting node must be an event',
  SINK_NOT_ACTION: 'every ending node must be an action',
  MISSING_ENDPOINTS: 'workflow must start with an event and end with an action',
} as const

/** Per-node in/out degrees, used by validation and the canvas rendering. */
export interface WorkflowDegrees {
  inDegrees: Map<string, number>
  outDegrees: Map<string, number>
}

/** Compute the in/out degree of every node from the edge list. */
export function workflowDegrees(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): WorkflowDegrees {
  const inDegrees = new Map<string, number>()
  const outDegrees = new Map<string, number>()
  for (const node of nodes) {
    inDegrees.set(node.id, 0)
    outDegrees.set(node.id, 0)
  }
  for (const edge of edges) {
    outDegrees.set(edge.source, (outDegrees.get(edge.source) ?? 0) + 1)
    inDegrees.set(edge.target, (inDegrees.get(edge.target) ?? 0) + 1)
  }
  return { inDegrees, outDegrees }
}

/** Whether the edge list contains a directed cycle (Kahn's algorithm). */
export function workflowHasCycle(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): boolean {
  const { inDegrees } = workflowDegrees(nodes, edges)
  const queue: string[] = []
  for (const node of nodes) {
    if ((inDegrees.get(node.id) ?? 0) === 0) queue.push(node.id)
  }
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()!
    visited += 1
    for (const edge of edges) {
      if (edge.source !== id) continue
      const next = (inDegrees.get(edge.target) ?? 0) - 1
      inDegrees.set(edge.target, next)
      if (next === 0) queue.push(edge.target)
    }
  }
  return visited !== nodes.length
}

/**
 * Validate a workflow graph against the DAG constraints. Returns a list of
 * stable error codes (empty = valid). Structural normalization is the
 * caller's responsibility — this is the pure graph check.
 */
export function validateWorkflowGraph(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): string[] {
  const errors: string[] = []
  if (nodes.length === 0) return [WORKFLOW_GRAPH_ERRORS.NO_NODES]

  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (nodeIds.has(node.id)) errors.push(WORKFLOW_GRAPH_ERRORS.DUPLICATE_NODE)
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) errors.push(WORKFLOW_GRAPH_ERRORS.DUPLICATE_EDGE)
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      errors.push(WORKFLOW_GRAPH_ERRORS.DANGLING_EDGE)
    } else if (edge.source === edge.target) {
      errors.push(WORKFLOW_GRAPH_ERRORS.SELF_LOOP)
    }
  }

  if (errors.length > 0) return errors
  if (workflowHasCycle(nodes, edges)) return [WORKFLOW_GRAPH_ERRORS.CYCLE]

  const { inDegrees, outDegrees } = workflowDegrees(nodes, edges)
  let hasEventSource = false
  let hasActionSink = false
  for (const node of nodes) {
    const inDegree = inDegrees.get(node.id) ?? 0
    const outDegree = outDegrees.get(node.id) ?? 0
    if (inDegree === 0) {
      if (node.type === 'event') hasEventSource = true
      else errors.push(WORKFLOW_GRAPH_ERRORS.SOURCE_NOT_EVENT)
    }
    if (outDegree === 0) {
      if (node.type === 'action') hasActionSink = true
      else errors.push(WORKFLOW_GRAPH_ERRORS.SINK_NOT_ACTION)
    }
  }
  if (!hasEventSource || !hasActionSink) {
    errors.push(WORKFLOW_GRAPH_ERRORS.MISSING_ENDPOINTS)
  }
  return errors
}

/** Whether a normalized node+edge pair forms a valid workflow DAG. */
export function isWorkflowGraphValid(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  return validateWorkflowGraph(nodes, edges).length === 0
}

/** Result of a create transition: the new workflow (when accepted) + the next list. */
export interface CreateWorkflowResult {
  workflow: WorkflowRecord | undefined
  workflows: readonly WorkflowRecord[]
}

/**
 * Apply a create against the current workflow list. Rejected (workflow
 * undefined) when the name, nodes, or edges are malformed, or the graph is
 * not a valid workflow DAG.
 */
export function applyCreateWorkflow(
  workflows: readonly WorkflowRecord[],
  input: WorkflowCreateInput,
  now: number,
  id: string,
): CreateWorkflowResult {
  const name = normalizeWorkflowName(input.name)
  const nodes = normalizeWorkflowNodes(input.nodes)
  const edges = normalizeWorkflowEdges(input.edges)
  const description = normalizeWorkflowDescription(input.description)
  if (name === undefined || nodes === undefined || edges === undefined) {
    return { workflow: undefined, workflows }
  }
  if (!isWorkflowGraphValid(nodes, edges)) return { workflow: undefined, workflows }
  const workflow: WorkflowRecord = {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    nodes,
    edges,
    createdAt: now,
    updatedAt: now,
  }
  return { workflow, workflows: [...workflows, workflow] }
}

/** Result of an update transition. */
export interface UpdateWorkflowResult {
  workflows: readonly WorkflowRecord[]
  /** Whether the patch was applied (false = unknown workflow / invalid value). */
  applied: boolean
}

/**
 * Apply an update across the workflow list. A blank name, a malformed
 * node/edge list, or a resulting graph that is not a valid workflow DAG
 * rejects the whole patch (state untouched).
 */
export function applyUpdateWorkflow(
  workflows: readonly WorkflowRecord[],
  workflowId: string,
  patch: WorkflowUpdatePatch,
  now: number,
): UpdateWorkflowResult {
  const workflow = workflows.find(candidate => candidate.id === workflowId)
  if (workflow === undefined) return { workflows, applied: false }
  const name = 'name' in patch ? normalizeWorkflowName(patch.name) : undefined
  if ('name' in patch && name === undefined) return { workflows, applied: false }
  // A null/blank description clears it; a too-long string rejects the patch.
  let nextDescription = workflow.description
  if ('description' in patch) {
    const raw = patch.description
    if (raw === undefined || raw === null || raw.trim() === '') {
      nextDescription = undefined
    } else if (raw.length > WORKFLOW_DESCRIPTION_BOUND) {
      return { workflows, applied: false }
    } else {
      nextDescription = raw
    }
  }
  const nodes = 'nodes' in patch ? normalizeWorkflowNodes(patch.nodes) : undefined
  if ('nodes' in patch && nodes === undefined) return { workflows, applied: false }
  const edges = 'edges' in patch ? normalizeWorkflowEdges(patch.edges) : undefined
  if ('edges' in patch && edges === undefined) return { workflows, applied: false }

  const nextNodes = nodes ?? workflow.nodes
  const nextEdges = edges ?? workflow.edges
  if (!isWorkflowGraphValid(nextNodes, nextEdges)) return { workflows, applied: false }

  const next: WorkflowRecord = {
    ...workflow,
    ...('name' in patch ? { name: name! } : {}),
    ...('nodes' in patch ? { nodes } : {}),
    ...('edges' in patch ? { edges } : {}),
    updatedAt: now,
  }
  if ('description' in patch) {
    if (nextDescription === undefined) delete next.description
    else next.description = nextDescription
  }
  return { workflows: workflows.map(candidate => candidate.id === workflowId ? next : candidate), applied: true }
}

/** Result of a delete transition. */
export interface DeleteWorkflowResult {
  workflows: readonly WorkflowRecord[]
  applied: boolean
}

/** Delete a workflow (referenced tasks are untouched — tasks stay independent). */
export function applyDeleteWorkflow(
  workflows: readonly WorkflowRecord[],
  workflowId: string,
): DeleteWorkflowResult {
  if (!workflows.some(workflow => workflow.id === workflowId)) {
    return { workflows: [...workflows], applied: false }
  }
  return { workflows: workflows.filter(workflow => workflow.id !== workflowId), applied: true }
}

/**
 * Normalize a persisted workflow list: valid rows are kept (deduplicated by
 * id), malformed nodes/edges are dropped, and dangling edges are dropped so a
 * manually edited ledger never leaves an inconsistent graph in memory. A row
 * whose nodes all dropped is itself dropped. This is structural repair only —
 * the write path validates the graph, so a loaded row is trusted to have been
 * valid when stored.
 */
export function normalizeWorkflowRows(value: unknown): WorkflowRecord[] {
  if (!Array.isArray(value)) return []
  const workflows: WorkflowRecord[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = typeof row.id === 'string' && row.id !== '' && row.id.length <= WORKFLOW_FIELD_BOUND
      ? row.id
      : undefined
    const name = normalizeWorkflowName(row.name)
    if (id === undefined || name === undefined || seen.has(id)) continue
    const nodes: WorkflowNode[] = []
    if (Array.isArray(row.nodes) && row.nodes.length <= WORKFLOW_MAX_NODES) {
      for (const nodeValue of row.nodes) {
        const node = parseWorkflowNode(nodeValue)
        if (node !== undefined) nodes.push(node)
      }
    }
    if (nodes.length === 0) continue
    const nodeIds = new Set(nodes.map(node => node.id))
    const edges: WorkflowEdge[] = []
    if (Array.isArray(row.edges) && row.edges.length <= WORKFLOW_MAX_EDGES) {
      for (const edgeValue of row.edges) {
        const edge = parseWorkflowEdge(edgeValue)
        if (edge === undefined) continue
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
        edges.push(edge)
      }
    }
    const createdAt = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0
    const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : createdAt
    const description = normalizeWorkflowDescription(row.description)
    seen.add(id)
    workflows.push({
      id,
      name,
      ...(description === undefined ? {} : { description }),
      nodes,
      edges,
      createdAt,
      updatedAt,
    })
  }
  return workflows
}
