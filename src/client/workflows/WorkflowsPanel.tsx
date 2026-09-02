/**
 * Workflows panel — the center-column view behind the single "Workflows"
 * sidebar entry (replaces the former Events and Actions panels, which are now
 * node types inside a workflow DAG).
 *
 * List view shows one card per workflow; the editor hosts the n8n-style canvas
 * plus name/description fields and a save/delete bar. The panel reads workflows
 * and tasks from the board controller (Host-authoritative) and the event/action
 * node palette from the integrations endpoint.
 */
import { useCallback, useEffect, useSyncExternalStore, useState, type ReactElement } from 'react'
import type { BoardController } from '../../core/controller.ts'
import type { PanelController } from '../../core/panel-controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { validateWorkflowGraph, type WorkflowEdge, type WorkflowNode, type WorkflowRecord } from '../../core/workflows.ts'
import type { ActionStatus, AllTasksIntegrationsSnapshot, EventSourceStatus } from '../../protocol.ts'
import { fetchIntegrations } from '../integrations.ts'
import { t } from '../locales.ts'
import { WorkflowCanvas } from './WorkflowCanvas.tsx'
import css from './workflow.module.css'

let idCounter = 0
function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) return `${prefix}-${uuid}`
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The editor's local draft of one workflow (committed on save). */
interface EditingDraft {
  id: string
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowsPanelProps {
  panel: PanelController
  controller: BoardController
}

export function WorkflowsPanel({ panel, controller }: WorkflowsPanelProps): ReactElement {
  const snapshot = useSyncExternalStore(
    useCallback(listener => controller.subscribe(listener), [controller]),
    () => controller.getSnapshot(),
  )
  const open = useSyncExternalStore(
    useCallback(listener => panel.subscribe(listener), [panel]),
    () => panel.getSnapshot().open,
  )

  const [integrations, setIntegrations] = useState<AllTasksIntegrationsSnapshot | undefined>()
  const [integrationsError, setIntegrationsError] = useState<string | undefined>()
  const [editing, setEditing] = useState<EditingDraft | undefined>()
  const [saving, setSaving] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | undefined>()
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const reloadIntegrations = useCallback((): void => {
    setIntegrationsError(undefined)
    void fetchIntegrations().then(
      value => { setIntegrations(value) },
      error => { setIntegrationsError(messageOf(error)) },
    )
  }, [])

  useEffect(() => {
    reloadIntegrations()
    return panel.subscribe(() => {
      if (panel.getSnapshot().open) reloadIntegrations()
    })
  }, [panel, reloadIntegrations])

  const events: EventSourceStatus[] = integrations?.events ?? []
  const actions: ActionStatus[] = integrations?.actions ?? []
  const tasks: TaskRecord[] = snapshot.tasks.filter(task => task.archivedAt === undefined)
  const workflows = snapshot.workflows ?? []

  // A workflow deleted out-of-band (another tab / Host) drops out of the editor.
  const editingStillExists = editing !== undefined && workflows.some(workflow => workflow.id === editing.id)
  useEffect(() => {
    if (editing !== undefined && !editingStillExists) setEditing(undefined)
  }, [editing, editingStillExists])

  const enterEditor = (workflow: WorkflowRecord): void => {
    setEditing({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description ?? '',
      nodes: workflow.nodes.map(node => ({ ...node, position: { ...node.position } })),
      edges: [...workflow.edges],
    })
    setConfirmingDelete(false)
  }

  const closeEditor = (): void => {
    setEditing(undefined)
    setConfirmingDelete(false)
  }

  const createNew = async (): Promise<void> => {
    const eventRef = events[0]?.id ?? 'http'
    const actionRef = actions[0]?.id ?? 'http'
    const first: WorkflowNode = { id: newId('node'), type: 'event', ref: eventRef, position: { x: 60, y: 140 } }
    const second: WorkflowNode = { id: newId('node'), type: 'action', ref: actionRef, position: { x: 420, y: 140 } }
    const workflow = await controller.createWorkflow({
      name: t('workflow.untitled'),
      nodes: [first, second],
      edges: [{ id: newId('edge'), source: first.id, target: second.id }],
    })
    if (workflow !== undefined) enterEditor(workflow)
  }

  const save = async (): Promise<void> => {
    if (editing === undefined || saving) return
    setSaving(true)
    try {
      await controller.updateWorkflow(editing.id, {
        name: editing.name,
        description: editing.description,
        nodes: editing.nodes,
        edges: editing.edges,
      })
    } finally {
      setSaving(false)
    }
  }

  const removeEditing = async (): Promise<void> => {
    if (editing === undefined) return
    if (!confirmingDelete) { setConfirmingDelete(true); return }
    await controller.deleteWorkflow(editing.id)
    setEditing(undefined)
    setConfirmingDelete(false)
  }

  const removeFromList = async (workflowId: string): Promise<void> => {
    if (confirmingId !== workflowId) { setConfirmingId(workflowId); return }
    await controller.deleteWorkflow(workflowId)
    setConfirmingId(undefined)
  }

  const canSave = editing !== undefined
    && editing.name.trim() !== ''
    && validateWorkflowGraph(editing.nodes, editing.edges).length === 0

  if (editing !== undefined) {
    return (
      <div className={css.panel} data-dsh-plugin="all-tasks">
        <header className={css.header}>
          <button type="button" className={`${css.ghostButton} ${css.backButton}`} onClick={closeEditor}>
            <span aria-hidden="true">‹</span>
            <span>{t('workflow.back')}</span>
          </button>
          <input
            className={css.nameInput}
            value={editing.name}
            aria-label={t('workflow.name')}
            placeholder={t('workflow.name')}
            onChange={event => { setEditing({ ...editing, name: event.target.value }) }}
          />
          <input
            className={css.descInput}
            value={editing.description}
            aria-label={t('workflow.description')}
            placeholder={t('workflow.description')}
            onChange={event => { setEditing({ ...editing, description: event.target.value }) }}
          />
          <button type="button" className={css.primaryButton} disabled={!canSave || saving} onClick={() => { void save() }}>
            {saving ? t('workflow.saving') : t('workflow.save')}
          </button>
          <button
            type="button"
            className={`${css.ghostButton} ${css.dangerButton}`}
            onClick={() => { void removeEditing() }}
          >
            {confirmingDelete ? t('workflow.confirmDelete') : t('workflow.delete')}
          </button>
        </header>
        <WorkflowCanvas
          nodes={editing.nodes}
          edges={editing.edges}
          onNodesChange={nodes => { setEditing({ ...editing, nodes }) }}
          onEdgesChange={edges => { setEditing({ ...editing, edges }) }}
          events={events}
          actions={actions}
          tasks={tasks}
        />
      </div>
    )
  }

  return (
    <div className={css.panel} data-dsh-plugin="all-tasks">
      <header className={css.header}>
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          data-dsh-center-view-back=""
          aria-label={t('panel.close')}
          onClick={() => { panel.closePanel() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{t('panel.close')}</span>
        </button>
        <h2 className={css.title}>{t('panel.workflows.title')}</h2>
        <div className={css.spacer} />
        <button type="button" className={css.primaryButton} onClick={() => { void createNew() }}>
          {t('workflow.new')}
        </button>
      </header>
      <p className={css.intro}>{t('panel.workflows.intro')}</p>
      {integrationsError !== undefined && (
        <p className={css.error}>
          {t('workflow.loadFailed', { error: integrationsError })}{' '}
          <button type="button" className={css.linkButton} onClick={reloadIntegrations}>{t('workflow.retry')}</button>
        </p>
      )}
      <div className={css.list}>
        {workflows.length === 0
          ? <p className={css.empty}>{t('workflow.empty')}</p>
          : workflows.map(workflow => (
            <article key={workflow.id} className={css.card}>
              <div className={css.cardMain} onClick={() => { enterEditor(workflow) }}>
                <h3 className={css.cardTitle}>{workflow.name}</h3>
                <p className={css.cardMeta}>
                  {workflow.nodes.length} {t('workflow.nodes')} · {workflow.edges.length} {t('workflow.edges')}
                </p>
              </div>
              <div className={css.cardActions}>
                <button type="button" className={css.ghostButton} onClick={() => { enterEditor(workflow) }}>
                  {t('workflow.edit')}
                </button>
                <button
                  type="button"
                  className={`${css.ghostButton} ${css.dangerButton}`}
                  onClick={() => { void removeFromList(workflow.id) }}
                >
                  {confirmingId === workflow.id ? t('workflow.confirmDelete') : t('workflow.delete')}
                </button>
              </div>
            </article>
          ))}
      </div>
      <p className={css.hint}>{t('workflow.footerHint')}</p>
    </div>
  )
}
