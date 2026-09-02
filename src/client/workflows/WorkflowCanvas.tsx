/**
 * WorkflowCanvas — the n8n-style DAG editor.
 *
 * Renders a pannable/zoomable canvas with draggable nodes and SVG bezier
 * edges. Nodes are connected by dragging from a node's output port (right) to
 * another node's input port (left). A side inspector edits the selected node's
 * reference and label (or deletes a selected edge). Nodes are added through the
 * three palette buttons overlaid on the canvas.
 *
 * The component is controlled: `nodes`/`edges` live in the parent editor, and
 * every mutation round-trips through `onNodesChange`/`onEdgesChange` so the
 * parent can persist and validate.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TaskRecord } from '../../core/tasks.ts'
import {
  WORKFLOW_GRAPH_ERRORS,
  validateWorkflowGraph,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
} from '../../core/workflows.ts'
import type { ActionStatus, EventSourceStatus } from '../../protocol.ts'
import { dictionary, t, type AllTasksKey } from '../locales.ts'
import css from './workflow.module.css'

const NODE_WIDTH = 200
const NODE_HEIGHT = 64
const MIN_ZOOM = 0.4
const MAX_ZOOM = 2

let idCounter = 0
function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) return `${prefix}-${uuid}`
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

/** Friendly name of an event source / action node reference (fallback to the id). */
function integrationName(kind: 'event' | 'action', ref: string): string {
  const key = `integration.${kind}.${ref}.name` as AllTasksKey
  return dictionary()[key] ?? ref
}

function nodeTitle(node: WorkflowNode, events: EventSourceStatus[], actions: ActionStatus[], tasks: TaskRecord[]): string {
  if (node.label !== undefined && node.label.trim() !== '') return node.label
  if (node.type === 'event') return integrationName('event', node.ref)
  if (node.type === 'action') return integrationName('action', node.ref)
  return tasks.find(task => task.id === node.ref)?.title ?? node.ref
}

function nodeKindLabel(kind: WorkflowNodeType): string {
  return t(`workflow.nodeKind.${kind}` as AllTasksKey)
}

function validationMessage(code: string): string {
  const map: Record<string, AllTasksKey> = {
    [WORKFLOW_GRAPH_ERRORS.NO_NODES]: 'workflow.error.noNodes',
    [WORKFLOW_GRAPH_ERRORS.DUPLICATE_NODE]: 'workflow.error.duplicateNode',
    [WORKFLOW_GRAPH_ERRORS.DUPLICATE_EDGE]: 'workflow.error.duplicateEdge',
    [WORKFLOW_GRAPH_ERRORS.DANGLING_EDGE]: 'workflow.error.danglingEdge',
    [WORKFLOW_GRAPH_ERRORS.SELF_LOOP]: 'workflow.error.selfLoop',
    [WORKFLOW_GRAPH_ERRORS.CYCLE]: 'workflow.error.cycle',
    [WORKFLOW_GRAPH_ERRORS.SOURCE_NOT_EVENT]: 'workflow.error.sourceNotEvent',
    [WORKFLOW_GRAPH_ERRORS.SINK_NOT_ACTION]: 'workflow.error.sinkNotAction',
    [WORKFLOW_GRAPH_ERRORS.MISSING_ENDPOINTS]: 'workflow.error.missingEndpoints',
  }
  const key = map[code]
  return key === undefined ? code : t(key)
}

/** Screen-space cubic bezier between two node anchors (source output → target input). */
function edgePathD(source: WorkflowNode, target: WorkflowNode, zoom: number, pan: { x: number; y: number }): string {
  const sx = (source.position.x + NODE_WIDTH) * zoom + pan.x
  const sy = (source.position.y + NODE_HEIGHT / 2) * zoom + pan.y
  const tx = target.position.x * zoom + pan.x
  const ty = (target.position.y + NODE_HEIGHT / 2) * zoom + pan.y
  const dx = Math.max(40, Math.abs(tx - sx) * 0.5)
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
}

export interface WorkflowCanvasProps {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  onNodesChange(nodes: WorkflowNode[]): void
  onEdgesChange(edges: WorkflowEdge[]): void
  events: EventSourceStatus[]
  actions: ActionStatus[]
  tasks: TaskRecord[]
}

export function WorkflowCanvas(props: WorkflowCanvasProps): ReactElement {
  const { nodes, edges, onNodesChange, onEdgesChange, events, actions, tasks } = props

  const [pan, setPan] = useState({ x: 24, y: 24 })
  const [zoom, setZoom] = useState(1)
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>()
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectCursor, setConnectCursor] = useState<{ x: number; y: number } | null>(null)

  // Latest-value refs so the mount-once window listeners never read stale state.
  const nodesRef = useRef(nodes); nodesRef.current = nodes
  const edgesRef = useRef(edges); edgesRef.current = edges
  const zoomRef = useRef(zoom); zoomRef.current = zoom
  const panRef = useRef(pan); panRef.current = pan
  const onNodesChangeRef = useRef(onNodesChange); onNodesChangeRef.current = onNodesChange
  const onEdgesChangeRef = useRef(onEdgesChange); onEdgesChangeRef.current = onEdgesChange
  const connectingRef = useRef<string | null>(null)
  const hoverTargetRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number; nodeX: number; nodeY: number } | null>(null)
  const panningRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (dragRef.current !== null) {
        const drag = dragRef.current
        const zoomNow = zoomRef.current
        const dx = (event.clientX - drag.startX) / zoomNow
        const dy = (event.clientY - drag.startY) / zoomNow
        onNodesChangeRef.current(nodesRef.current.map(node => node.id === drag.id
          ? { ...node, position: { x: drag.nodeX + dx, y: drag.nodeY + dy } }
          : node))
      }
      if (panningRef.current !== null) {
        const panNow = panningRef.current
        setPan({ x: panNow.panX + (event.clientX - panNow.startX), y: panNow.panY + (event.clientY - panNow.startY) })
      }
      if (connectingRef.current !== null) {
        setConnectCursor({ x: event.clientX, y: event.clientY })
      }
    }
    const onUp = (): void => {
      if (connectingRef.current !== null) {
        const source = connectingRef.current
        const target = hoverTargetRef.current
        if (source !== null && target !== null && source !== target) {
          const edge: WorkflowEdge = { id: newId('edge'), source, target }
          onEdgesChangeRef.current([...edgesRef.current, edge])
        }
        connectingRef.current = null
        hoverTargetRef.current = null
        setConnecting(null)
        setConnectCursor(null)
      }
      dragRef.current = null
      panningRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // Non-passive wheel so preventDefault can stop page scroll while zooming.
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const currentZoom = zoomRef.current
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * factor))
      if (nextZoom === currentZoom) return
      const worldX = (mx - panRef.current.x) / currentZoom
      const worldY = (my - panRef.current.y) / currentZoom
      setZoom(nextZoom)
      setPan({ x: mx - worldX * nextZoom, y: my - worldY * nextZoom })
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => { wrap.removeEventListener('wheel', onWheel) }
  }, [])

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])
  const errors = useMemo(() => validateWorkflowGraph(nodes, edges), [nodes, edges])
  const selectedNode = selectedNodeId === undefined ? undefined : byId.get(selectedNodeId)
  const selectedEdge = selectedEdgeId === undefined ? undefined : edges.find(edge => edge.id === selectedEdgeId)

  const onCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if (connectingRef.current !== null) return
    panningRef.current = { startX: event.clientX, startY: event.clientY, panX: panRef.current.x, panY: panRef.current.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panningRef.current === null) return
    const start = panningRef.current
    setPan({ x: start.panX + (event.clientX - start.startX), y: start.panY + (event.clientY - start.startY) })
  }
  const onCanvasPointerUp = (): void => { panningRef.current = null }

  const onNodePointerDown = (event: React.PointerEvent<HTMLDivElement>, node: WorkflowNode): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    setSelectedNodeId(node.id)
    setSelectedEdgeId(undefined)
    dragRef.current = { id: node.id, startX: event.clientX, startY: event.clientY, nodeX: node.position.x, nodeY: node.position.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const beginConnect = (event: React.PointerEvent<HTMLElement>, nodeId: string): void => {
    event.stopPropagation()
    event.preventDefault()
    setSelectedNodeId(nodeId)
    connectingRef.current = nodeId
    setConnecting(nodeId)
    setConnectCursor({ x: event.clientX, y: event.clientY })
  }

  const addNode = (type: WorkflowNodeType): void => {
    let ref = ''
    if (type === 'event') ref = events[0]?.id ?? 'http'
    else if (type === 'action') ref = actions[0]?.id ?? 'http'
    else ref = tasks[0]?.id ?? ''

    const wrap = wrapRef.current
    const rect = wrap?.getBoundingClientRect()
    const width = rect?.width ?? 800
    const height = rect?.height ?? 500
    const worldX = (width / 2 - panRef.current.x) / zoomRef.current
    const worldY = (height / 2 - panRef.current.y) / zoomRef.current
    const jitter = (nodes.length % 5) * 40
    const node: WorkflowNode = {
      id: newId('node'),
      type,
      ref,
      position: { x: Math.round(worldX - NODE_WIDTH / 2 + jitter), y: Math.round(worldY - NODE_HEIGHT / 2 + jitter) },
    }
    onNodesChangeRef.current([...nodesRef.current, node])
    setSelectedNodeId(node.id)
    setSelectedEdgeId(undefined)
  }

  const updateNode = (id: string, patch: Partial<Pick<WorkflowNode, 'ref' | 'label'>>): void => {
    onNodesChangeRef.current(nodesRef.current.map(node => node.id === id ? { ...node, ...patch } : node))
  }

  const deleteSelectedNode = (): void => {
    if (selectedNodeId === undefined) return
    const id = selectedNodeId
    onNodesChangeRef.current(nodesRef.current.filter(node => node.id !== id))
    onEdgesChangeRef.current(edgesRef.current.filter(edge => edge.source !== id && edge.target !== id))
    setSelectedNodeId(undefined)
  }

  const deleteSelectedEdge = (): void => {
    if (selectedEdgeId === undefined) return
    onEdgesChangeRef.current(edgesRef.current.filter(edge => edge.id !== selectedEdgeId))
    setSelectedEdgeId(undefined)
  }

  const selectEdge = (edge: WorkflowEdge): void => {
    setSelectedEdgeId(edge.id)
    setSelectedNodeId(undefined)
  }

  const selectedEdgeSource = selectedEdge === undefined ? undefined : byId.get(selectedEdge.source)
  const selectedEdgeTarget = selectedEdge === undefined ? undefined : byId.get(selectedEdge.target)

  return (
    <div className={css.editorBody}>
      <div
        ref={wrapRef}
        className={css.canvasWrap}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
      >
        <svg className={css.edgesSvg}>
          {edges.map(edge => {
            const source = byId.get(edge.source)
            const target = byId.get(edge.target)
            if (source === undefined || target === undefined) return null
            const selected = edge.id === selectedEdgeId
            return (
              <path
                key={edge.id}
                className={selected ? css.edgePathSelected : css.edgePath}
                d={edgePathD(source, target, zoom, pan)}
                onPointerDown={(event) => { event.stopPropagation(); selectEdge(edge) }}
                style={{ pointerEvents: 'stroke' }}
              />
            )
          })}
          {connecting !== null && connectCursor !== null && (() => {
            const source = byId.get(connecting)
            if (source === undefined) return null
            const sx = (source.position.x + NODE_WIDTH) * zoom + pan.x
            const sy = (source.position.y + NODE_HEIGHT / 2) * zoom + pan.y
            const tx = connectCursor.x
            const ty = connectCursor.y
            const dx = Math.max(40, Math.abs(tx - sx) * 0.5)
            return <path className={css.edgePathPreview} d={`M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`} />
          })()}
        </svg>

        <div className={css.stage} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {nodes.map(node => (
            <div
              key={node.id}
              className={css.node}
              data-kind={node.type}
              data-selected={node.id === selectedNodeId ? '' : undefined}
              style={{ left: node.position.x, top: node.position.y }}
              onPointerDown={event => { onNodePointerDown(event, node) }}
            >
              <span
                className={[css.port, css.portInput].join(' ')}
                data-connect-target={connecting !== null && hoverTargetRef.current === node.id ? '' : undefined}
                onPointerDown={event => { event.stopPropagation() }}
                onPointerEnter={() => { hoverTargetRef.current = node.id }}
                onPointerLeave={() => { if (hoverTargetRef.current === node.id) hoverTargetRef.current = null }}
              />
              <span className={css.nodeKind}>{nodeKindLabel(node.type)}</span>
              <span className={css.nodeName}>{nodeTitle(node, events, actions, tasks)}</span>
              <span className={css.nodeRef}>{node.ref}</span>
              <span
                className={[css.port, css.portOutput].join(' ')}
                onPointerDown={event => { beginConnect(event, node.id) }}
              />
            </div>
          ))}
        </div>

        <div className={css.zoomBadge}>{Math.round(zoom * 100)}%</div>
      </div>

      <aside className={css.inspector}>
        {selectedNode !== undefined && (
          <>
            <h4 className={css.inspectorTitle}>{t('workflow.inspector.node')}</h4>
            <div className={css.field}>
              <span className={css.fieldLabel}>{nodeKindLabel(selectedNode.type)}</span>
              {selectedNode.type === 'event' && (
                <select
                  className={css.select}
                  value={selectedNode.ref}
                  onChange={event => { updateNode(selectedNode.id, { ref: event.target.value }) }}
                >
                  {events.map(source => <option key={source.id} value={source.id}>{integrationName('event', source.id)}</option>)}
                </select>
              )}
              {selectedNode.type === 'action' && (
                <select
                  className={css.select}
                  value={selectedNode.ref}
                  onChange={event => { updateNode(selectedNode.id, { ref: event.target.value }) }}
                >
                  {actions.map(action => <option key={action.id} value={action.id}>{integrationName('action', action.id)}</option>)}
                </select>
              )}
              {selectedNode.type === 'task' && (
                <select
                  className={css.select}
                  value={selectedNode.ref}
                  onChange={event => { updateNode(selectedNode.id, { ref: event.target.value }) }}
                >
                  {tasks.length === 0 && <option value="">{t('workflow.noTasks')}</option>}
                  {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
                </select>
              )}
            </div>
            <div className={css.field}>
              <span className={css.fieldLabel}>{t('workflow.inspector.label')}</span>
              <input
                className={css.input}
                value={selectedNode.label ?? ''}
                placeholder={nodeTitle(selectedNode, events, actions, tasks)}
                onChange={event => { updateNode(selectedNode.id, { label: event.target.value }) }}
              />
            </div>
            <button type="button" className={`${css.ghostButton} ${css.dangerButton}`} onClick={deleteSelectedNode}>
              {t('workflow.inspector.deleteNode')}
            </button>
          </>
        )}
        {selectedEdge !== undefined && selectedEdgeSource !== undefined && selectedEdgeTarget !== undefined && (
          <>
            <h4 className={css.inspectorTitle}>{t('workflow.inspector.edge')}</h4>
            <p className={css.inspectorEmpty}>
              {nodeTitle(selectedEdgeSource, events, actions, tasks)} → {nodeTitle(selectedEdgeTarget, events, actions, tasks)}
            </p>
            <button type="button" className={`${css.ghostButton} ${css.dangerButton}`} onClick={deleteSelectedEdge}>
              {t('workflow.inspector.deleteEdge')}
            </button>
          </>
        )}
        {selectedNode === undefined && selectedEdge === undefined && (
          <>
            <h4 className={css.inspectorTitle}>{t('workflow.inspector.palette')}</h4>
            <button type="button" className={css.ghostButton} onClick={() => { addNode('event') }}>{t('workflow.addEvent')}</button>
            <button type="button" className={css.ghostButton} onClick={() => { addNode('task') }}>{t('workflow.addTask')}</button>
            <button type="button" className={css.ghostButton} onClick={() => { addNode('action') }}>{t('workflow.addAction')}</button>
            <p className={css.inspectorEmpty}>{t('workflow.canvasHint')}</p>
          </>
        )}
        <div className={css.validation}>
          {errors.length === 0
            ? <p className={css.validationOk}>{t('workflow.valid')}</p>
            : errors.map(error => <p key={error} className={css.validationError}>{validationMessage(error)}</p>)}
        </div>
        <p className={css.hint}>{t('workflow.validationHint')}</p>
      </aside>
    </div>
  )
}
