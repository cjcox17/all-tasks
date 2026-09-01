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
import { memo, useCallback, useEffect, useState } from 'react'
import { selectedTaskOf, type BoardController } from '../../core/controller.ts'
import { orderedGroupMembers, type TaskGroupRecord } from '../../core/groups.ts'
import { COLUMNS, canMoveManually, type TaskRecord } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { GroupModal } from './GroupModal.tsx'
import { NewTaskModal } from './NewTaskModal.tsx'
import { STATUS_KEY } from './status-key.ts'
import { TaskCard } from './TaskCard.tsx'
import { TaskDetail } from './TaskDetail.tsx'
import { WorkspaceDefaultsModal } from './WorkspaceDefaultsModal.tsx'
import { WorkspaceList } from './WorkspaceList.tsx'
import { matchesWorkspace, splitWorkspaceTasks } from './workspace-filter.ts'

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

/** The per-card start button (sits beside the card, like stop/approve). */
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
const MemoTaskCard = memo(function MemoTaskCard({ task, pending, timeZone, onOpen }: { task: TaskRecord; pending: boolean; timeZone?: string; onOpen: (id: string) => void }) {
  const onClick = useCallback(() => { onOpen(task.id) }, [task.id, onOpen])
  return <TaskCard task={task} pending={pending} timeZone={timeZone} onClick={onClick} />
})

/**
 * Group section header inside a column: name, member count, mode badge,
 * start/stop/resume, manage. The whole header is a drag source so a group can
 * be moved between manual columns in one action (see the column drop handler).
 */
function GroupBanner({ group, count, running, canStart, onStart, onStop, onResume, onManage }: {
  group: TaskGroupRecord
  count: number
  /** Whether any member has an open (running/queued) execution. */
  running: boolean
  /** Whether any on-board member can be started right now. */
  canStart: boolean
  onStart: () => void
  onStop: () => void
  onResume: () => void
  onManage: () => void
}) {
  const stopped = group.stopped === true
  const draggable = !running && !stopped
  return (
    <header
      className={css.groupHeader}
      data-dsh-part="group"
      draggable={draggable}
      onDragStart={draggable ? (event) => {
        event.dataTransfer.setData('text/plain', `group:${group.id}`)
        event.dataTransfer.effectAllowed = 'move'
      } : undefined}
      title={draggable ? t('group.dragHint') : undefined}
    >
      <span className={css.groupName} title={group.name}>{group.name}</span>
      <span className={css.groupBadge} data-mode={group.mode}>
        {group.mode === 'sequential' ? t('group.sequentialBadge') : t('group.parallelBadge')}
      </span>
      {stopped && <span className={css.groupStopped}>{t('group.stopped')}</span>}
      {group.schedule?.enabled === true && <span className={css.cardSchedule}>{t('card.scheduled')}</span>}
      <span className={css.groupCount}>{count}</span>
      {!stopped && (
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
      {stopped ? (
        <button
          type="button"
          className={css.ghostButton}
          aria-label={t('group.resume')}
          onClick={onResume}
        >
          ▶
        </button>
      ) : (
        <button
          type="button"
          className={css.ghostButton}
          aria-label={t('group.stop')}
          disabled={!running}
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
 * Every running/queued member gets a per-card stop button (so a group can be
 * stopped member-by-member from the board, without opening a session).
 */
function GroupSection({ group, members, hasRunning, canStart, pendingIds, timeZone, onOpen, onManage, onRunMember, onStopMember, onApproveMember, onStartGroup, onStopGroup, onResume }: {
  group: TaskGroupRecord
  members: readonly TaskRecord[]
  /** Whether any board-wide member has a running execution (enables stop-group). */
  hasRunning: boolean
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
  onStopGroup: () => void
  onResume: () => void
}) {
  return (
    <div className={css.groupSection} data-group={group.id}>
      <GroupBanner
        group={group}
        count={members.length}
        running={hasRunning}
        canStart={canStart}
        onStart={onStartGroup}
        onStop={onStopGroup}
        onResume={onResume}
        onManage={onManage}
      />
      {members.length === 0 && <p className={css.groupEmpty}>{t('group.emptyMembers')}</p>}
      {members.map(task => (
        <div key={task.id} className={css.groupMember}>
          <MemoTaskCard task={task} pending={pendingIds.includes(task.id)} timeZone={timeZone} onOpen={onOpen} />
          {task.status === 'running' && (
            <button
              type="button"
              className={css.stopButton}
              aria-label={t('group.stopMember')}
              title={t('group.stopMember')}
              onClick={() => { onStopMember(task.id) }}
            >
              ⏹
            </button>
          )}
          {task.approved === false ? (
            <button
              type="button"
              className={css.approveButton}
              aria-label={t('card.approve')}
              title={t('card.approve')}
              onClick={() => { onApproveMember(task.id) }}
            >
              ✓
            </button>
          ) : canStartTask(task) ? (
            <RunTaskButton task={task} onRun={onRunMember} />
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** The kanban view (always scoped to one workspace, or the All overview). */
function KanbanView({ controller, snapshot, workspaceId, onBack }: {
  controller: BoardController
  snapshot: ReturnType<BoardController['getSnapshot']>
  /** The active workspace id; undefined = the All-tasks overview. */
  workspaceId: string | undefined
  onBack: () => void
}) {
  const [filter, setFilter] = useState('')
  const [unapprovedOnly, setUnapprovedOnly] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [groupEditor, setGroupEditor] = useState<{ group?: TaskGroupRecord } | undefined>(undefined)
  const [showDefaults, setShowDefaults] = useState(false)
  const selected = selectedTaskOf(snapshot)
  const archiveView = snapshot.archiveView
  // Archived tasks leave the columns; the archive view shows them instead.
  // The workspace scoping applies to both views: filtered views keep the
  // workspace's pinned tasks plus the unassigned remainder (never hidden).
  // The unapproved-only filter narrows to tasks waiting for approval (their
  // gate blocks every run path until approved).
  const visible = snapshot.tasks.filter(task =>
    (archiveView ? task.archivedAt !== undefined : task.archivedAt === undefined)
    && matchesFilter(task, filter)
    && matchesWorkspace(task, workspaceId)
    && (!unapprovedOnly || task.approved === false),
  )
  const openTask = useCallback((id: string): void => { controller.openTask(id) }, [controller])
  /** Whether any on-board member of a group can be started right now. */
  const canStartGroup = useCallback((groupId: string): boolean =>
    snapshot.tasks.some(task => task.groupId === groupId && canStartTask(task)),
  [snapshot.tasks])

  const workspaceTitle = workspaceId === undefined
    ? t('board.title')
    : snapshot.executionOptions.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.title ?? workspaceId
  const defaults = workspaceId === undefined ? undefined : snapshot.workspaceDefaults[workspaceId]

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
            : t('board.archiveView', { count: String(snapshot.tasks.filter(task => task.archivedAt !== undefined).length) })}
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

      <div className={css.columns}>
        {archiveView ? (
          <section className={css.column} data-status="archived" data-dsh-part="column">
            <header className={css.columnHeader}>
              <h3 className={css.columnTitle}>{t('board.archive')}</h3>
              <span className={css.columnCount}>{visible.length}</span>
            </header>
            <div className={css.cards}>
              {visible.map(task => (
                <MemoTaskCard key={task.id} task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} />
              ))}
              {visible.length === 0 && <div className={css.columnEmpty}>{t('archive.empty')}</div>}
            </div>
          </section>
        ) : (
          COLUMNS.map(column => {
            const tasks = visible.filter(task => task.status === column.status)
            const { pinned, unassigned } = splitWorkspaceTasks(tasks, workspaceId)
            const ungrouped = pinned.filter(task => task.groupId === undefined)
            const unassignedFlat = unassigned.filter(task => task.groupId === undefined)
            const grouped = snapshot.groups
              .map(group => ({ group, members: orderedGroupMembers(group, tasks) }))
              .filter(entry => entry.members.length > 0)
            // Groups with no members anywhere still show (in the todo column)
            // so they stay visible and manageable after creation.
            const emptyGroups = column.status === 'todo'
              ? snapshot.groups.filter(group => !snapshot.tasks.some(task => task.groupId === group.id))
              : []
            const isManualDropTarget = column.status === 'backlog' || column.status === 'todo'
            return (
              <section
                key={column.status}
                className={css.column}
                data-status={column.status}
                data-dsh-part="column"
                onDragOver={isManualDropTarget ? (event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                } : undefined}
                onDrop={isManualDropTarget ? (event) => {
                  event.preventDefault()
                  const payload = event.dataTransfer.getData('text/plain')
                  if (!payload) return
                  if (payload.startsWith('group:')) {
                    const groupId = payload.slice('group:'.length)
                    const droppedGroup = snapshot.groups.find(g => g.id === groupId)
                    if (droppedGroup && droppedGroup.stopped !== true) {
                      const members = snapshot.tasks.filter(t => t.groupId === groupId && t.archivedAt === undefined)
                      if (members.every(m => m.status !== 'running')) {
                        void controller.moveGroup(groupId, column.status)
                      }
                    }
                    return
                  }
                  const dropped = snapshot.tasks.find(t => t.id === payload)
                  if (dropped && canMoveManually(dropped.status, column.status) && dropped.status !== column.status) {
                    controller.moveTask(payload, column.status)
                  }
                } : undefined}
              >
                <header className={css.columnHeader}>
                  <span className={css.statusDot} data-status={column.status} aria-hidden="true" />
                  <h3 className={css.columnTitle}>{t(STATUS_KEY[column.status])}</h3>
                  <span className={css.columnCount}>{tasks.length}</span>
                </header>
                <div className={css.cards}>
                  {ungrouped.map(task => {
                    const showAction = task.approved === false || canStartTask(task)
                    return (
                      <div key={task.id} className={showAction ? css.cardWrap : undefined}>
                        <MemoTaskCard task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} />
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
                        ) : null}
                      </div>
                    )
                  })}
                  {workspaceId !== undefined && unassignedFlat.length > 0 && (
                    <div className={css.unassignedSection} data-dsh-part="unassigned">
                      <header className={css.unassignedHeader}>
                        <span className={css.unassignedName}>{t('board.unassigned')}</span>
                        <span className={css.groupCount}>{unassignedFlat.length}</span>
                      </header>
                      {unassignedFlat.map(task => {
                        const showAction = task.approved === false || canStartTask(task)
                        return (
                          <div key={task.id} className={showAction ? css.cardWrap : undefined}>
                            <MemoTaskCard task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} />
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
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {grouped.map(({ group, members }) => (
                    <GroupSection
                      key={group.id}
                      group={group}
                      members={members}
                      hasRunning={snapshot.tasks.some(t => t.groupId === group.id && t.status === 'running')}
                      canStart={canStartGroup(group.id)}
                      pendingIds={snapshot.pendingTaskIds}
                      timeZone={snapshot.host?.scheduler.timeZone}
                      onOpen={openTask}
                      onManage={() => { setGroupEditor({ group }) }}
                      onRunMember={id => { void controller.runTask(id) }}
                      onStopMember={id => { void controller.stopTask(id) }}
                      onApproveMember={id => { controller.setApproved(id, true) }}
                      onStartGroup={() => { void controller.runGroup(group.id) }}
                      onStopGroup={() => { void controller.stopGroup(group.id) }}
                      onResume={() => { void controller.resumeGroup(group.id) }}
                    />
                  ))}
                  {emptyGroups.map(group => (
                    <GroupSection
                      key={group.id}
                      group={group}
                      members={[]}
                      hasRunning={snapshot.tasks.some(t => t.groupId === group.id && t.status === 'running')}
                      canStart={canStartGroup(group.id)}
                      pendingIds={snapshot.pendingTaskIds}
                      timeZone={snapshot.host?.scheduler.timeZone}
                      onOpen={openTask}
                      onManage={() => { setGroupEditor({ group }) }}
                      onRunMember={id => { void controller.runTask(id) }}
                      onStopMember={id => { void controller.stopTask(id) }}
                      onApproveMember={id => { controller.setApproved(id, true) }}
                      onStartGroup={() => { void controller.runGroup(group.id) }}
                      onStopGroup={() => { void controller.stopGroup(group.id) }}
                      onResume={() => { void controller.resumeGroup(group.id) }}
                    />
                  ))}
                  {tasks.length === 0 && emptyGroups.length === 0 && <div className={css.columnEmpty}>{t('board.empty')}</div>}
                </div>
              </section>
            )
          })
        )}
      </div>

      {selected !== undefined && (
        <TaskDetail controller={controller} task={selected} />
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
          onClose={() => { setGroupEditor(undefined) }}
        />
      )}
    </>
  )
}

/** Board component; subscribes to the controller snapshot. */
export function TaskBoard({ controller }: { controller: BoardController }) {
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

  return (
    <div className={css.board} data-dsh-taskboard-board="" data-dsh-plugin="task-board">
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
        <WorkspaceList
          tasks={snapshot.tasks}
          workspaces={snapshot.executionOptions.workspaces}
          onOpen={openWorkspace}
          onOpenAll={openAll}
          onSettings={workspaceId => { setDefaultsEditor({ workspaceId }) }}
        />
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
