/**
 * Board view: the two-level task board.
 *
 * Landing: a workspace overview list (one row per workspace with live task
 * counts) is the first view. Opening a row switches to that workspace's
 * kanban — the multi-column board is always workspace-scoped now; the back
 * button in the header returns to the workspace list and the old workspace
 * dropdown is gone. An "All tasks" row opens the unscoped kanban (the
 * general overview, including unassigned tasks).
 *
 * Cards open the task detail (never execute directly); the kanban header
 * offers filter, unapproved-only, archive, new-task, and new-group controls.
 */
import { memo, useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactElement } from 'react'
import { selectedTaskOf, type BoardController } from '../../core/controller.ts'
import { computeDashboard } from '../../core/dashboard.ts'
import {
  groupFinalStepBlocked,
  groupRuntimeStatus,
  orderedGroupMembers,
  type ExecutionQueuedReason,
  type GroupRuntimeStatus,
  type TaskGroupRecord,
} from '../../core/groups.ts'
import { COLUMNS, canMoveManually, type TaskRecord, type TaskStatus } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { Dashboard } from './Dashboard.tsx'
import { GroupModal } from './GroupModal.tsx'
import { NewTaskModal } from './NewTaskModal.tsx'
import { STATUS_KEY } from './status-key.ts'
import { TaskCard, parseTaskDragPayload } from './TaskCard.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import { WorkspaceDefaultsModal } from './WorkspaceDefaultsModal.tsx'
import { WorkspaceList } from './WorkspaceList.tsx'
import { boardGroups, boardTasks, liveWorkspaceIds, matchesWorkspace, splitWorkspaceTasks } from './workspace-filter.ts'

/** A 1x1 transparent GIF: hides the native drag ghost so the board draws its own. */
const TRANSPARENT_DRAG_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** The drag payload for a whole group (`group:<id>`). */
function groupDragPayload(groupId: string): string {
  return `group:${groupId}`
}

/** Pointer position at drag start (viewport coordinates). */
interface DragPointer {
  x: number
  y: number
}

/** A drag in flight: what is being dragged plus the ghost position/snapshot. */
interface DragState {
  kind: 'task' | 'group'
  id: string
  /** Pointer position of the floating ghost (viewport coordinates). */
  x: number
  y: number
  /**
   * Grab offset: where the pointer sat inside the source element when the
   * drag started. The ghost is drawn at `(x - dx, y - dy)` so the grabbed
   * point stays under the cursor instead of snapping the ghost's top-left
   * corner to it — the drag feels like a native one for cards and group
   * headers alike.
   */
  dx: number
  dy: number
  width: number
  height: number
  /** OuterHTML snapshot of the dragged element (rendered as the ghost). */
  html: string
}

/** Where a task drag is hovering: which column, in which zone, at what offset. */
interface DropTarget {
  column: TaskStatus
  zone: 'column' | 'group' | 'unassigned'
  /** The hovered group (group zone only). */
  groupId?: string
  /** Pointer offset inside the hovered container (for the insertion line). */
  y: number
}

/** Case-insensitive title/description match. */
function matchesFilter(task: TaskRecord, filter: string): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  return task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle)
}

/**
 * Whether a task can be started from the board right now: on-board, approved,
 * sitting in a manual column (backlog/todo), and without an open execution.
 * Mirrors the Host ledger's runnable-member definition for group starts.
 */
function canStartTask(task: TaskRecord): boolean {
  if (task.archivedAt !== undefined || task.approved === false) return false
  if (task.status !== 'backlog' && task.status !== 'todo') return false
  return !task.executions.some(execution => execution.endedAt === undefined)
}

/** The per-card start button for standalone (ungrouped) cards: sits beside the card, like approve. */
function RunTaskButton({ task, onRun }: { task: TaskRecord; onRun: (id: string) => void }) {
  return (
    <button
      type="button"
      className={css.runButton}
      aria-label={t('card.run')}
      title={t('card.run')}
      onClick={() => { onRun(task.id) }}
    >
      ▶
    </button>
  )
}

/**
 * Memoized per-card adapter: with a stable `onOpen` from the board and an
 * immutable task record (only the changed card gets a new object ref), a card
 * re-renders only when its own task changes — not when a sibling card status,
 * the filter, or the selection moves.
 */
const MemoTaskCard = memo(function MemoTaskCard({ task, pending, timeZone, onOpen, onDragStart, hideSpinner, finalStep, finalStepWaiting }: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  onOpen: (id: string) => void
  onDragStart?: (payload: string, rect: { x: number; y: number; width: number; height: number }, html: string, pointer: DragPointer) => void
  hideSpinner?: boolean
  /** This card is the group's designated final step (merge step). */
  finalStep?: boolean
  /** The final step is gated: other group members are still unfinished. */
  finalStepWaiting?: boolean
}) {
  const onClick = useCallback(() => { onOpen(task.id) }, [task.id, onOpen])
  return <TaskCard task={task} pending={pending} timeZone={timeZone} onClick={onClick} onDragStart={onDragStart} hideSpinner={hideSpinner} finalStep={finalStep} finalStepWaiting={finalStepWaiting} />
})

/** Human hint for a pending group: the reason(s) its held members wait. */
function pendingReasonsHint(reasons: readonly ExecutionQueuedReason[]): string {
  if (reasons.length === 0) return t('group.pendingHint')
  return reasons.map(reason => t(reason === 'group'
    ? 'detail.result.waitingGroup'
    : reason === 'window' ? 'detail.result.waitingWindow' : 'detail.result.waiting')).join(' · ')
}

/**
 * Group section header inside a column: name, member count, mode badge, live
 * Running/Pending status, start/stop/resume, manage. The whole header is a
 * drag source so a group can be moved between manual columns in one action
 * (see the column drop handler).
 */
function GroupBanner({ group, count, status, canStart, onStart, onStop, onPause, onContinue, onResume, onManage, onDragStart }: {
  group: TaskGroupRecord
  count: number
  /** Open-execution status (running/queued members) of the whole group. */
  status: GroupRuntimeStatus
  /** Whether any on-board member can be started right now. */
  canStart: boolean
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onContinue: () => void
  onResume: () => void
  onManage: () => void
  onDragStart?: (payload: string, rect: { x: number; y: number; width: number; height: number }, html: string, pointer: DragPointer) => void
}) {
  const stopped = group.stopped === true
  // Any open execution — running or queued — holds the group's attention: the
  // banner is not draggable and the stop button is live (a queued member is
  // stopped just like a launched one).
  const paused = group.paused === true
  const hasOpen = status.running > 0 || status.pending > 0
  const draggable = !hasOpen && !stopped && !paused
  // A drag gesture may start on one of the header's action buttons (▶ ⏹ ⚙);
  // once a real drag begins, the browser must not also fire that button's
  // click when the pointer is released. Record the release instant at
  // dragend and swallow a click that lands right after it, so "anywhere in
  // the header" moves the group and never triggers start/stop/manage.
  const lastDragRelease = useRef(0)
  return (
    <header
      className={css.groupHeader}
      data-dsh-part="group"
      draggable={draggable}
      onDragStart={draggable ? (event) => {
        event.dataTransfer.setData('text/plain', groupDragPayload(group.id))
        event.dataTransfer.effectAllowed = 'move'
        // Hide the native square ghost; the board draws a fluid clone instead.
        const image = new Image()
        image.src = TRANSPARENT_DRAG_IMAGE
        event.dataTransfer.setDragImage(image, 0, 0)
        const rect = event.currentTarget.getBoundingClientRect()
        onDragStart?.(groupDragPayload(group.id), {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }, event.currentTarget.outerHTML, { x: event.clientX, y: event.clientY })
      } : undefined}
      onDragEnd={draggable ? () => { lastDragRelease.current = Date.now() } : undefined}
      onClickCapture={draggable ? (event) => {
        if (Date.now() - lastDragRelease.current < 250) {
          event.preventDefault()
          event.stopPropagation()
        }
      } : undefined}
      title={draggable ? t('group.dragHint') : undefined}
    >
      <span className={css.groupName} title={group.name}>{group.name}</span>
      <span className={css.groupBadge} data-mode={group.mode}>
        {group.mode === 'sequential' ? t('group.sequentialBadge') : t('group.parallelBadge')}
      </span>
      {status.running > 0 && (
        <span className={css.groupStatus} data-kind="running" title={t('group.runningHint')}>
          <span className={css.groupStatusSpinner} aria-hidden="true" />
          {t('group.running')}
          {status.running > 1 ? ` ${status.running}` : ''}
        </span>
      )}
      {status.pending > 0 && (
        <span className={css.groupStatus} data-kind="pending" title={pendingReasonsHint(status.pendingReasons)}>
          {t('group.pending')}
          {status.pending > 1 ? ` ${status.pending}` : ''}
        </span>
      )}
      {status.finalStepWaiting && (
        <span className={css.groupStatus} data-kind="finalstep" title={t('card.finalStepWaitingHint')}>
          {t('group.finalStepWaitingBadge')}
        </span>
      )}
      {stopped && <span className={css.groupStopped}>{t('group.stopped')}</span>}
      {paused && <span className={css.groupPaused}>{t('group.paused')}</span>}
      {group.schedule?.enabled === true && <span className={css.cardSchedule}>{t('card.scheduled')}</span>}
      <span className={css.groupCount}>{count}</span>
      {!stopped && !paused && (
        <button
          type="button"
          className={css.ghostButton}
          aria-label={t('group.start')}
          title={t('group.startHint')}
          disabled={!canStart}
          onClick={onStart}
        >
          ▶
        </button>
      )}
      {paused ? (
        <button
          type="button"
          className={css.ghostButton}
          aria-label={t('group.continue')}
          title={t('group.continue')}
          onClick={onContinue}
        >
          ▶
        </button>
      ) : stopped ? (
        <button
          type="button"
          className={css.ghostButton}
          aria-label={t('group.resume')}
          onClick={onResume}
        >
          ▶
        </button>
      ) : (
        <>
          <button
            type="button"
            className={css.ghostButton}
            aria-label={t('group.pause')}
            title={t('group.pause')}
            disabled={!hasOpen}
            onClick={onPause}
          >
            ⏸
          </button>
          <button
            type="button"
            className={css.ghostButton}
            aria-label={t('group.stop')}
            disabled={!hasOpen}
            onClick={onStop}
          >
            ⏹
          </button>
        </>
      )}
      {paused && (
        <button
          type="button"
          className={css.ghostButton}
          aria-label={t('group.stop')}
          disabled={!hasOpen}
          onClick={onStop}
        >
          ⏹
        </button>
      )}
      <button
        type="button"
        className={css.ghostButton}
        aria-label={t('group.manage')}
        onClick={onManage}
      >
        ⚙
      </button>
    </header>
  )
}

/**
 * One group's section inside a column: the banner plus its member cards.
 * Every member card carries one contextual action circle on its right edge,
 * inside the card: stop for a running/queued member (so a group can be stopped
 * member-by-member from the board, without opening a session), approve for an
 * unapproved member, or run for a runnable one. The circle's ring doubles as
 * the running/pending indicator while the task is open or an action is in
 * flight. Single-member pause/continue stays available through the group
 * banner (Pause group) and the task detail's open-execution row.
 */
function GroupSection({ group, members, status, canStart, pendingIds, timeZone, onOpen, onManage, onRunMember, onStopMember, onApproveMember, onStartGroup, onPauseGroup, onContinueGroup, onStopGroup, onResume, onDragStart, dropTarget, finalStepBlocked }: {
  group: TaskGroupRecord
  members: readonly TaskRecord[]
  /** Open-execution status of the whole group (running/queued members). */
  status: GroupRuntimeStatus
  /** Whether any on-board member can be started right now (enables start-group). */
  canStart: boolean
  pendingIds: readonly string[]
  timeZone?: string
  onOpen: (id: string) => void
  onManage: () => void
  onRunMember: (id: string) => void
  onStopMember: (id: string) => void
  onApproveMember: (id: string) => void
  onStartGroup: () => void
  onPauseGroup: () => void
  onContinueGroup: () => void
  onStopGroup: () => void
  onResume: () => void
  onDragStart?: (payload: string, rect: { x: number; y: number; width: number; height: number }, html: string, pointer: DragPointer) => void
  /** Whether a task drag is hovering this group's section (highlight + line). */
  dropTarget?: DropTarget
  /** Whether the group's final step is gated on unsettled members (all tasks considered). */
  finalStepBlocked: boolean
}) {
  const overGroup = dropTarget?.zone === 'group' && dropTarget.groupId === group.id
  return (
    <div className={css.groupSection} data-group={group.id} data-droptarget={overGroup || undefined}>
      <GroupBanner
        group={group}
        count={members.length}
        status={status}
        canStart={canStart}
        onStart={onStartGroup}
        onStop={onStopGroup}
        onPause={onPauseGroup}
        onContinue={onContinueGroup}
        onResume={onResume}
        onManage={onManage}
        onDragStart={onDragStart}
      />
      {members.length === 0 && <p className={css.groupEmpty}>{t('group.emptyMembers')}</p>}
      {members.map(task => {
        // The final step is gated: while other members are still unfinished it
        // carries no run action (the Host refuses a manual start; the badge on
        // the card explains the wait). Stop/approve stay available.
        const isFinalStep = group.finalStepTaskId === task.id
        const finalStepWaiting = isFinalStep && finalStepBlocked
        // One contextual action per member, shown as a circle on the card's
        // right edge (inside the card — the card itself is a button, so the
        // action stays a sibling in the DOM and is overlaid by the wrapper).
        const action = task.status === 'running'
          ? { kind: 'stop' as const, label: t('group.stopMember'), glyph: '⏹', onAct: () => { onStopMember(task.id) } }
          : task.approved === false
            ? { kind: 'approve' as const, label: t('card.approve'), glyph: '✓', onAct: () => { onApproveMember(task.id) } }
            : finalStepWaiting
              ? undefined
              : canStartTask(task)
                ? { kind: 'run' as const, label: t('card.run'), glyph: '▶', onAct: () => { onRunMember(task.id) } }
                : undefined
        // While the task is running or an action is pending, the circle's ring
        // spins — the pending indicator merged around the action icon.
        const active = action !== undefined && (task.status === 'running' || pendingIds.includes(task.id))
        return (
          <div key={task.id} className={css.groupMember} data-action={action?.kind}>
            <MemoTaskCard
              task={task}
              pending={pendingIds.includes(task.id)}
              timeZone={timeZone}
              onOpen={onOpen}
              onDragStart={onDragStart}
              hideSpinner={action !== undefined}
              finalStep={isFinalStep}
              finalStepWaiting={finalStepWaiting}
            />
            {action !== undefined && (
              <button
                type="button"
                className={css.cardAction}
                data-action={action.kind}
                data-active={active || undefined}
                aria-label={action.label}
                title={action.label}
                onClick={action.onAct}
              >
                {action.glyph}
              </button>
            )}
          </div>
        )
      })}
      {overGroup && dropTarget?.groupId === group.id && (
        <div className={css.dropIndicator} style={{ top: Math.max(2, dropTarget.y) }} aria-hidden="true" />
      )}
    </div>
  )
}

/** The kanban view (always scoped to one workspace, or the All overview). */
function KanbanView({ controller, snapshot, tasks, groups, workspaceId, onBack }: {
  controller: BoardController
  snapshot: ReturnType<BoardController['getSnapshot']>
  /**
   * The board's visible tasks (see boardTasks): tasks of workspaces deleted
   * from the runtime list are already filtered out, so they never surface in
   * any column, group, Unassigned section, or the archive.
   */
  tasks: readonly TaskRecord[]
  /** The board's visible groups (see boardGroups): vanished-workspace groups filtered out. */
  groups: readonly TaskGroupRecord[]
  /** The active workspace id; undefined = the All-tasks overview. */
  workspaceId: string | undefined
  onBack: () => void
}) {
  const [filter, setFilter] = useState('')
  const [unapprovedOnly, setUnapprovedOnly] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [groupEditor, setGroupEditor] = useState<{ group?: TaskGroupRecord } | undefined>(undefined)
  const [showDefaults, setShowDefaults] = useState(false)
  const archiveView = snapshot.archiveView
  // Archived tasks leave the columns; the archive view shows them instead.
  // The workspace scoping applies to both views: filtered views keep the
  // workspace's pinned tasks plus the unassigned remainder (never hidden).
  // The unapproved-only filter narrows to tasks waiting for approval (their
  // gate blocks every run path until approved).
  const visible = tasks.filter(task =>
    (archiveView ? task.archivedAt !== undefined : task.archivedAt === undefined)
    && matchesFilter(task, filter)
    && matchesWorkspace(task, workspaceId)
    && (!unapprovedOnly || task.approved === false),
  )
  const openTask = useCallback((id: string): void => { controller.openTask(id) }, [controller])
  /** Whether any on-board member of a group can be started right now. */
  const canStartGroup = useCallback((groupId: string): boolean =>
    tasks.some(task => task.groupId === groupId && canStartTask(task)),
  [tasks])

  // Groups are workspace-scoped: a workspace kanban shows only the groups of
  // that workspace (the unassigned-scope groups render inside its Unassigned
  // section below); the All overview spans every workspace's groups.
  const scopeGroups = workspaceId === undefined
    ? groups
    : groups.filter(group => group.workspaceId === workspaceId)

  const workspaceTitle = workspaceId === undefined
    ? t('board.title')
    : snapshot.executionOptions.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.title ?? workspaceId
  const defaults = workspaceId === undefined ? undefined : snapshot.workspaceDefaults[workspaceId]

  // --- drag & drop -----------------------------------------------------------
  // One drag at a time. `drag` drives the floating ghost clone; `dropTarget`
  // drives the insertion line / target highlight. Both are cleared on
  // dragend (and on drop).
  const [drag, setDrag] = useState<DragState | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<DropTarget | undefined>(undefined)
  const dragging = drag !== undefined

  const startDrag = useCallback((payload: string, rect: { x: number; y: number; width: number; height: number }, html: string, pointer: DragPointer): void => {
    const kind = payload.startsWith('group:') ? 'group' : 'task'
    const id = kind === 'group' ? payload.slice('group:'.length) : payload.slice('task:'.length)
    // Seed the ghost at the pointer so it opens exactly over the grabbed
    // element (`pointer - grabOffset` = the source rect origin).
    setDrag({
      kind,
      id,
      x: pointer.x,
      y: pointer.y,
      dx: pointer.x - rect.x,
      dy: pointer.y - rect.y,
      width: rect.width,
      height: rect.height,
      html,
    })
  }, [])

  // Follow the pointer with the ghost and stop the drag on release. `drag`
  // events fire on the drag source and bubble to the window.
  useEffect(() => {
    if (!dragging) return
    const onDragMove = (event: DragEvent): void => {
      setDrag(current => current === undefined ? current : { ...current, x: event.clientX, y: event.clientY })
    }
    const onDragEnd = (): void => {
      setDrag(undefined)
      setDropTarget(undefined)
    }
    window.addEventListener('drag', onDragMove)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener('drag', onDragMove)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [dragging])

  /**
   * Hover handling for one column's card stack. Gates whether the drop is
   * allowed at all (a task reorders inside its own column or moves to a
   * manual column; a whole group moves only to the manual columns), then
   * classifies the pointer into the column / group / unassigned zone.
   */
  const handleCardsDragOver = useCallback((column: TaskStatus) => (event: ReactDragEvent<HTMLDivElement>): void => {
    if (drag === undefined) return
    if (drag.kind === 'group') {
      if (column !== 'backlog' && column !== 'todo') return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTarget({ column, zone: 'column', y: 0 })
      return
    }
    const dragged = tasks.find(task => task.id === drag.id)
    if (dragged === undefined) return
    const moveAllowed = canMoveManually(dragged.status, column)
    if (dragged.status !== column && !moveAllowed) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const containerRect = event.currentTarget.getBoundingClientRect()
    const y = event.clientY - containerRect.top
    const target = event.target as Element
    const groupEl = target.closest('[data-group]')
    if (groupEl instanceof HTMLElement && groupEl.dataset.group !== undefined) {
      // A group of another workspace scope is not a drop target for this task
      // (membership is workspace-locked); treat the hover as the column.
      const group = groups.find(candidate => candidate.id === groupEl.dataset.group)
      if (group !== undefined && dragged.workspaceId === group.workspaceId) {
        setDropTarget({
          column,
          zone: 'group',
          groupId: groupEl.dataset.group,
          y: event.clientY - groupEl.getBoundingClientRect().top,
        })
        return
      }
    }
    if (target.closest('[data-dsh-part="unassigned"]') !== null) {
      setDropTarget({ column, zone: 'unassigned', y })
      return
    }
    setDropTarget({ column, zone: 'column', y })
  }, [drag, tasks, groups])

  const handleCardsDragLeave = useCallback((column: TaskStatus) => (event: ReactDragEvent<HTMLDivElement>): void => {
    const related = event.relatedTarget as Node | null
    if (related === null || !event.currentTarget.contains(related)) {
      setDropTarget(current => current?.column === column ? undefined : current)
    }
  }, [])

  /**
   * The first ungrouped card of the drop column whose vertical midpoint lies
   * below the pointer — the card the dragged task should land directly above.
   * Undefined means the end of the column's ungrouped stack.
   */
  const taskBeforePointer = useCallback((column: TaskStatus, taskId: string, pointerY: number): string | undefined => {
    const candidates = visible.filter(task =>
      task.status === column && task.groupId === undefined && task.id !== taskId)
    for (const candidate of candidates) {
      const element = document.querySelector<HTMLElement>(`[data-task-id="${candidate.id}"]`)
      if (element === null) continue
      const rect = element.getBoundingClientRect()
      if (pointerY < rect.top + rect.height / 2) return candidate.id
    }
    return undefined
  }, [visible])

  /**
   * The first card inside the drop column's Unassigned section whose vertical
   * midpoint lies below the pointer — where a drop in that section lands.
   * Undefined means the end of the section's stack.
   */
  const unassignedCardBeforePointer = useCallback((column: TaskStatus, taskId: string, pointerY: number): string | undefined => {
    const candidates = visible.filter(task =>
      task.status === column && task.groupId === undefined && task.workspaceId === undefined && task.id !== taskId)
    for (const candidate of candidates) {
      const element = document.querySelector<HTMLElement>(`[data-task-id="${candidate.id}"]`)
      if (element === null) continue
      if (element.closest('[data-dsh-part="unassigned"]') === null) continue
      const rect = element.getBoundingClientRect()
      if (pointerY < rect.top + rect.height / 2) return candidate.id
    }
    return undefined
  }, [visible])

  /** Drop on a column's card stack: group move, group join/reorder, ungroup, status move, reorder. */
  const handleCardsDrop = useCallback((column: TaskStatus) => (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const raw = event.dataTransfer.getData('text/plain')
    setDropTarget(undefined)
    if (raw === '') return
    if (raw.startsWith('group:')) {
      if (column !== 'backlog' && column !== 'todo') return
      const groupId = raw.slice('group:'.length)
      const droppedGroup = groups.find(group => group.id === groupId)
      if (droppedGroup !== undefined && droppedGroup.stopped !== true) {
        const members = tasks.filter(task => task.groupId === groupId && task.archivedAt === undefined)
        if (members.every(member => member.status !== 'running')) {
          // Dropping the group back onto its own column is a no-op: a status
          // rewrite would bump every member's updatedAt and make the cards
          // look freshly edited even though nothing changed.
          if (members.length === 0 || members.every(member => member.status === column)) return
          void controller.moveGroup(groupId, column)
        }
      }
      return
    }
    const taskId = parseTaskDragPayload(raw)
    if (taskId === undefined) return
    const dragged = tasks.find(task => task.id === taskId)
    if (dragged === undefined) return
    const target = event.target as Element
    const groupEl = target.closest('[data-group]')
    if (groupEl instanceof HTMLElement && groupEl.dataset.group !== undefined) {
      const group = groups.find(candidate => candidate.id === groupEl!.dataset.group)
      // Membership is workspace-locked: a task can only join (or reorder
      // inside) a group of its own workspace scope; a foreign-scope group
      // falls through to the column/unassigned handling below.
      if (group !== undefined && dragged.workspaceId === group.workspaceId) {
        if (dragged.groupId === group.id) {
          // Reorder inside the group: the dragged member lands directly above
          // the member card under the pointer (midpoint split), mapped onto
          // the group's global member order.
          const memberElements = Array.from(groupEl.querySelectorAll('[data-dsh-part="card"]'))
          let beforeId: string | undefined
          for (const element of memberElements) {
            const rect = element.getBoundingClientRect()
            if (event.clientY < rect.top + rect.height / 2) {
              beforeId = (element as HTMLElement).dataset.taskId
              break
            }
          }
          if (beforeId === taskId) return
          const current = group.order
          const next = current.filter(id => id !== taskId)
          const at = beforeId === undefined ? next.length : next.indexOf(beforeId)
          if (at === -1) next.push(taskId)
          else next.splice(at, 0, taskId)
          if (next.length !== current.length || next.some((id, index) => id !== current[index])) {
            void controller.setGroupOrder(group.id, next)
          }
        } else {
          // Join the group (appended to its member order) — no need to edit
          // the task's group in the detail view.
          void controller.updateTask(taskId, { groupId: group.id })
        }
        return
      }
    }
    if (target.closest('[data-dsh-part="unassigned"]') !== null) {
      if (dragged.groupId !== undefined) void controller.updateTask(taskId, { groupId: null })
      if (dragged.status !== column && canMoveManually(dragged.status, column)) controller.moveTask(taskId, column)
      // Reorder among the Unassigned cards too: dragging above/below a
      // sibling inside the section changes the order exactly like the
      // pinned stack.
      if (dragged.status === column || canMoveManually(dragged.status, column)) {
        controller.reorderTask(taskId, unassignedCardBeforePointer(column, taskId, event.clientY))
      }
      return
    }
    // Column background: leave any group, move status when allowed, and
    // reorder among the drop column's ungrouped cards.
    if (dragged.groupId !== undefined) void controller.updateTask(taskId, { groupId: null })
    if (dragged.status !== column && canMoveManually(dragged.status, column)) controller.moveTask(taskId, column)
    if (dragged.status === column || canMoveManually(dragged.status, column)) {
      controller.reorderTask(taskId, taskBeforePointer(column, taskId, event.clientY))
    }
  }, [tasks, groups, controller, taskBeforePointer, unassignedCardBeforePointer])

  return (
    <>
      <header className={css.boardHeader}>
        {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          data-dsh-center-view-back=""
          aria-label={t('board.backToWorkspaces')}
          onClick={onBack}
        >
          <span aria-hidden="true">‹</span>
          <span>{t('board.backToWorkspaces')}</span>
        </button>
        <h2 className={css.boardTitle} title={workspaceTitle}>{workspaceTitle}</h2>
        {snapshot.host !== undefined && (
          <span className={css.detailMeta}>
            {t('board.hostMeta', {
              revision: String(snapshot.host.revision),
              timeZone: snapshot.host.scheduler.timeZone,
            })}
          </span>
        )}
        <input
          className={css.search}
          type="search"
          placeholder={t('board.search')}
          value={filter}
          onChange={event => { setFilter(event.target.value) }}
          aria-label={t('board.search')}
        />
        <button
          type="button"
          className={unapprovedOnly ? css.primaryButton : css.ghostButton}
          aria-pressed={unapprovedOnly}
          title={t('board.unapprovedHint')}
          onClick={() => { setUnapprovedOnly(value => !value) }}
        >
          {t('board.unapprovedFilter')}
        </button>
        <button
          type="button"
          className={archiveView ? css.primaryButton : css.ghostButton}
          onClick={() => { controller.toggleArchiveView() }}
        >
          {archiveView
            ? t('board.backToBoard')
            : t('board.archiveView', { count: String(tasks.filter(task => task.archivedAt !== undefined).length) })}
        </button>
        {workspaceId !== undefined && (
          <button
            type="button"
            className={css.ghostButton}
            aria-label={t('grid.workspaceSettings')}
            title={t('grid.workspaceSettings')}
            onClick={() => { setShowDefaults(true) }}
          >
            ⚙
          </button>
        )}
        <button
          type="button"
          className={css.ghostButton}
          onClick={() => { setGroupEditor({}) }}
        >
          + {t('board.newGroup')}
        </button>
        <button
          type="button"
          className={css.primaryButton}
          onClick={() => { setShowNew(true) }}
        >
          + {t('board.new')}
        </button>
      </header>

      <div className={css.columns} data-dragging={dragging || undefined}>
        {archiveView ? (
          <section className={css.column} data-status="archived" data-dsh-part="column">
            <header className={css.columnHeader}>
              <h3 className={css.columnTitle}>{t('board.archive')}</h3>
              <span className={css.columnCount}>{visible.length}</span>
            </header>
            <div className={css.cards}>
              {visible.map(task => (
                <MemoTaskCard key={task.id} task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} onDragStart={startDrag} />
              ))}
              {visible.length === 0 && <div className={css.columnEmpty}>{t('archive.empty')}</div>}
            </div>
          </section>
        ) : (
          COLUMNS.map(column => {
            const columnTasks = visible.filter(task => task.status === column.status)
            const { pinned, unassigned } = splitWorkspaceTasks(columnTasks, workspaceId)
            const ungrouped = pinned.filter(task => task.groupId === undefined)
            const unassignedFlat = unassigned.filter(task => task.groupId === undefined)
            const grouped = scopeGroups
              .map(group => ({ group, members: orderedGroupMembers(group, columnTasks) }))
              .filter(entry => entry.members.length > 0)
            // In a workspace-scoped view the Unassigned section also hosts the
            // unassigned-scope groups (only unassigned tasks can be members),
            // so grouped unassigned tasks never disappear from the board.
            const unassignedGrouped = workspaceId !== undefined
              ? groups
                .filter(group => group.workspaceId === undefined)
                .map(group => ({ group, members: orderedGroupMembers(group, unassigned) }))
                .filter(entry => entry.members.length > 0)
              : []
            // Groups with no members anywhere still show (in the todo column)
            // so they stay visible and manageable after creation. "Anywhere"
            // spans the whole board-visible task list (`tasks`), not this
            // column — a group whose members sit in another column must not
            // be duplicated as an empty shell here.
            const emptyGroups = column.status === 'todo'
              ? scopeGroups.filter(group => !tasks.some(task => task.groupId === group.id))
              : []
            const overColumn = dropTarget?.column === column.status
            // One group section renderer shared by the main, unassigned, and
            // empty-group render sites (the callbacks are identical).
            const renderGroupSection = (group: TaskGroupRecord, members: readonly TaskRecord[]): ReactElement => (
              <GroupSection
                key={group.id}
                group={group}
                members={members}
                status={groupRuntimeStatus(group, tasks)}
                canStart={canStartGroup(group.id)}
                pendingIds={snapshot.pendingTaskIds}
                timeZone={snapshot.host?.scheduler.timeZone}
                onOpen={openTask}
                onManage={() => { setGroupEditor({ group }) }}
                onRunMember={id => { void controller.runTask(id) }}
                onStopMember={id => { void controller.stopTask(id) }}
                onApproveMember={id => { controller.setApproved(id, true) }}
                onStartGroup={() => { void controller.runGroup(group.id) }}
                onPauseGroup={() => { void controller.pauseGroup(group.id) }}
                onContinueGroup={() => { void controller.continueGroup(group.id) }}
                onStopGroup={() => { void controller.stopGroup(group.id) }}
                onResume={() => { void controller.resumeGroup(group.id) }}
                onDragStart={startDrag}
                dropTarget={dropTarget}
                finalStepBlocked={groupFinalStepBlocked(group, tasks)}
              />
            )
            return (
              <section
                key={column.status}
                className={css.column}
                data-status={column.status}
                data-dsh-part="column"
              >
                <header className={css.columnHeader}>
                  <span className={css.statusDot} data-status={column.status} aria-hidden="true" />
                  <h3 className={css.columnTitle}>{t(STATUS_KEY[column.status])}</h3>
                  <span className={css.columnCount}>{columnTasks.length}</span>
                </header>
                <div
                  className={css.cards}
                  data-dsh-part="cards"
                  data-dragover={overColumn && dropTarget?.zone === 'column' ? true : undefined}
                  onDragOver={handleCardsDragOver(column.status)}
                  onDragLeave={handleCardsDragLeave(column.status)}
                  onDrop={handleCardsDrop(column.status)}
                >
                  {ungrouped.map(task => {
                    const showAction = task.approved === false || canStartTask(task) || task.status === 'running'
                    const open = task.executions.find(execution => execution.endedAt === undefined)
                    const paused = task.status === 'running' && open?.pausedAt !== undefined
                    return (
                      <div key={task.id} className={showAction ? css.cardWrap : undefined}>
                        <MemoTaskCard task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} onDragStart={startDrag} />
                        {task.approved === false ? (
                          <button
                            type="button"
                            className={css.approveButton}
                            aria-label={t('card.approve')}
                            title={t('card.approve')}
                            onClick={() => { controller.setApproved(task.id, true) }}
                          >
                            ✓
                          </button>
                        ) : canStartTask(task) ? (
                          <RunTaskButton task={task} onRun={id => { void controller.runTask(id) }} />
                        ) : task.status === 'running' ? (
                          paused ? (
                            <button
                              type="button"
                              className={css.continueButton}
                              aria-label={t('card.continue')}
                              title={t('card.continue')}
                              onClick={() => { void controller.continueTask(task.id) }}
                            >
                              ▶
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={css.pauseButton}
                              aria-label={t('card.pause')}
                              title={t('card.pause')}
                              onClick={() => { void controller.pauseTask(task.id) }}
                            >
                              ⏸
                            </button>
                          )
                        ) : null}
                      </div>
                    )
                  })}
                  {workspaceId !== undefined && (unassignedFlat.length > 0 || unassignedGrouped.length > 0) && (
                    <div
                      className={css.unassignedSection}
                      data-dsh-part="unassigned"
                      data-droptarget={overColumn && dropTarget?.zone === 'unassigned' ? true : undefined}
                    >
                      <header className={css.unassignedHeader}>
                        <span className={css.unassignedName}>{t('board.unassigned')}</span>
                        <span className={css.groupCount}>{unassigned.length}</span>
                      </header>
                      {unassignedGrouped.map(({ group, members }) => renderGroupSection(group, members))}
                      {unassignedFlat.map(task => {
                        const showAction = task.approved === false || canStartTask(task) || task.status === 'running'
                        const open = task.executions.find(execution => execution.endedAt === undefined)
                        const paused = task.status === 'running' && open?.pausedAt !== undefined
                        return (
                          <div key={task.id} className={showAction ? css.cardWrap : undefined}>
                            <MemoTaskCard task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} onDragStart={startDrag} />
                            {task.approved === false ? (
                              <button
                                type="button"
                                className={css.approveButton}
                                aria-label={t('card.approve')}
                                title={t('card.approve')}
                                onClick={() => { controller.setApproved(task.id, true) }}
                              >
                                ✓
                              </button>
                            ) : canStartTask(task) ? (
                              <RunTaskButton task={task} onRun={id => { void controller.runTask(id) }} />
                            ) : task.status === 'running' ? (
                              paused ? (
                                <button
                                  type="button"
                                  className={css.continueButton}
                                  aria-label={t('card.continue')}
                                  title={t('card.continue')}
                                  onClick={() => { void controller.continueTask(task.id) }}
                                >
                                  ▶
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className={css.pauseButton}
                                  aria-label={t('card.pause')}
                                  title={t('card.pause')}
                                  onClick={() => { void controller.pauseTask(task.id) }}
                                >
                                  ⏸
                                </button>
                              )
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {grouped.map(({ group, members }) => renderGroupSection(group, members))}
                  {emptyGroups.map(group => renderGroupSection(group, []))}
                  {overColumn && dropTarget?.zone === 'column' && (
                    <div className={css.dropIndicator} style={{ top: Math.max(0, dropTarget.y) }} aria-hidden="true" />
                  )}
                  {columnTasks.length === 0 && emptyGroups.length === 0 && <div className={css.columnEmpty}>{t('board.empty')}</div>}
                </div>
              </section>
            )
          })
        )}
      </div>

      {drag !== undefined && (
        <div
          className={css.dragGhost}
          data-dsh-part="drag-ghost"
          style={{
            // Keep the grabbed point under the cursor (fluid ghost) instead
            // of snapping the ghost's top-left corner to the pointer.
            left: drag.x - drag.dx,
            top: drag.y - drag.dy,
            width: drag.width,
            height: drag.height,
          }}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: drag.html }}
        />
      )}

      {showNew && (
        <NewTaskModal
          controller={controller}
          onClose={() => { setShowNew(false) }}
          defaultWorkspaceId={workspaceId}
          defaults={defaults}
        />
      )}
      {showDefaults && workspaceId !== undefined && (
        <WorkspaceDefaultsModal
          controller={controller}
          workspaceId={workspaceId}
          title={workspaceTitle}
          onClose={() => { setShowDefaults(false) }}
        />
      )}
      {groupEditor !== undefined && (
        <GroupModal
          controller={controller}
          group={groupEditor.group}
          workspaceId={workspaceId}
          onClose={() => { setGroupEditor(undefined) }}
        />
      )}
    </>
  )
}

/** Board component; subscribes to the controller snapshot. */
export function AllTasks({ controller }: { controller: BoardController }) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )
  /** undefined = the workspace landing list; otherwise the open kanban. */
  const [view, setView] = useState<{ workspaceId: string | undefined } | undefined>(undefined)
  const [showNew, setShowNew] = useState(false)
  const [defaultsEditor, setDefaultsEditor] = useState<{ workspaceId: string } | undefined>(undefined)

  const openWorkspace = useCallback((workspaceId: string): void => {
    // A leftover selection from a previous kanban must not pop open over the
    // newly opened workspace's board.
    controller.closeTask()
    setView({ workspaceId })
  }, [controller])
  const openAll = useCallback((): void => {
    controller.closeTask()
    setView({ workspaceId: undefined })
  }, [controller])
  const backToWorkspaces = useCallback((): void => {
    controller.closeTask()
    setView(undefined)
  }, [controller])
  /** Open a task's detail from the landing directory (the kanban opens its own). */
  const openTask = useCallback((id: string): void => { controller.openTask(id) }, [controller])
  const selected = selectedTaskOf(snapshot)

  // Board-visible tasks and groups: once the runtime workspace baseline has
  // loaded, a task or group pinned to a workspace missing from that list
  // (deleted in the sidebar) is hidden from the board entirely. Until the
  // baseline is ready the list may be empty or stale (startup / reconnect),
  // so nothing is filtered — the ledger pins stay untouched either way.
  const liveIds = liveWorkspaceIds(snapshot.executionOptions.workspaces)
  const hideVanished = snapshot.executionOptions.workspacesReady === true
  const tasks = hideVanished ? boardTasks(snapshot.tasks, liveIds) : snapshot.tasks
  const groups = hideVanished ? boardGroups(snapshot.groups, liveIds) : snapshot.groups

  return (
    <div className={css.board} data-dsh-all-tasks-board="" data-dsh-plugin="all-tasks">
      {view === undefined ? (
        <header className={css.boardHeader}>
          {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
          <button
            type="button"
            className={`${css.ghostButton} ${css.backButton}`}
            data-dsh-center-view-back=""
            aria-label={t('board.close')}
            onClick={() => { controller.closeBoard() }}
          >
            <span aria-hidden="true">‹</span>
            <span>{t('board.close')}</span>
          </button>
          <h2 className={css.boardTitle}>{t('board.title')}</h2>
          {snapshot.host !== undefined && (
            <span className={css.detailMeta}>
              {t('board.hostMeta', {
                revision: String(snapshot.host.revision),
                timeZone: snapshot.host.scheduler.timeZone,
              })}
            </span>
          )}
          <button
            type="button"
            className={css.primaryButton}
            onClick={() => { setShowNew(true) }}
          >
            + {t('board.new')}
          </button>
        </header>
      ) : (
        <KanbanView
          controller={controller}
          snapshot={snapshot}
          tasks={tasks}
          groups={groups}
          workspaceId={view.workspaceId}
          onBack={backToWorkspaces}
        />
      )}

      {snapshot.transportError !== undefined && (
        <div className={css.formError}>
          {t('board.hostError', { error: snapshot.transportError })}{' '}
          <button type="button" className={css.linkButton} onClick={() => { void controller.retryHostSync() }}>
            {t('board.retryHost')}
          </button>
        </div>
      )}

      {view === undefined && (
        <>
          <Dashboard metrics={computeDashboard(tasks, groups, snapshot.pricing)} />
          <WorkspaceList
            tasks={tasks}
            workspaces={snapshot.executionOptions.workspaces}
            groups={groups}
            pendingTaskIds={snapshot.pendingTaskIds}
            workspacePaused={snapshot.workspacePaused}
            onOpen={openWorkspace}
            onOpenAll={openAll}
            onSettings={workspaceId => { setDefaultsEditor({ workspaceId }) }}
            onOpenTask={openTask}
            onRun={workspaceId => { void controller.runWorkspace(workspaceId) }}
            onStop={workspaceId => { void controller.stopWorkspace(workspaceId) }}
            onPauseWorkspace={workspaceId => { void controller.pauseWorkspace(workspaceId) }}
            onContinueWorkspace={workspaceId => { void controller.continueWorkspace(workspaceId) }}
          />
        </>
      )}

      {/* The task detail overlays the board from either view (landing or kanban). */}
      {selected !== undefined && (
        <TaskDetail controller={controller} task={selected} />
      )}

      {view === undefined && showNew && (
        <NewTaskModal
          controller={controller}
          onClose={() => { setShowNew(false) }}
        />
      )}
      {defaultsEditor !== undefined && (
        <WorkspaceDefaultsModal
          controller={controller}
          workspaceId={defaultsEditor.workspaceId}
          title={snapshot.executionOptions.workspaces.find(workspace => workspace.workspaceId === defaultsEditor.workspaceId)?.title ?? defaultsEditor.workspaceId}
          onClose={() => { setDefaultsEditor(undefined) }}
        />
      )}
    </div>
  )
}
