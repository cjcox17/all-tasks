import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTask, EXECUTION_HISTORY_LIMIT, startExecution, withSchedule, type TaskRecord } from '../src/core/tasks.ts'
import { HostTaskLedger, processIsAlive, processState } from '../src/host-ledger.ts'

const roots: string[] = []
const NOW = new Date(2026, 7, 16, 10, 0, 30).getTime()

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-board-ledger-'))
  roots.push(root)
  return root
}

function task(id: string, updatedAt = NOW): TaskRecord {
  return { ...createTask({ title: id, description: '', prompt: id }, NOW - 1000, id), updatedAt }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The start time of a live process exactly as the legacy `ps -o lstart=`
 * probe recorded it: whole-second resolution. Used to simulate locks written
 * by the pre-ms-probe implementation during a rolling upgrade.
 */
function secondGranularStartMs(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined
  try {
    const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } })
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const started = Date.parse(probe.stdout.toString('utf8').trim())
    return Number.isFinite(started) ? started : undefined
  } catch {
    return undefined
  }
}

/**
 * Try to leave a short-lived orphan behind whose exit is not reaped, so it
 * occupies the PID table as a zombie (`process.kill(pid, 0)` then reports it
 * alive). Works on Linux where PID 1 does not reap promptly (containers, some
 * CI inits); returns undefined where init reaps orphans immediately, so
 * callers skip rather than flake.
 */
function spawnZombie(): number | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const probeFile = join(tmpdir(), `dsh-task-board-zombie-${process.pid}-${Math.random().toString(36).slice(2)}`)
    const shell = spawn('sh', ['-c', `sleep 0.2 & echo $! > "${probeFile}"`], { stdio: 'ignore' })
    shell.unref()
    const deadline = Date.now() + 3000
    let pid: number | undefined
    while (Date.now() < deadline) {
      try {
        const raw = readFileSync(probeFile, 'utf8').trim()
        if (raw !== '') {
          const parsed = Number(raw)
          if (Number.isSafeInteger(parsed)) pid = parsed
          break
        }
      } catch { /* shell still starting */ }
      sleepSync(50)
    }
    if (pid === undefined) return undefined
    const zombieDeadline = Date.now() + 2500
    while (Date.now() < zombieDeadline) {
      if (processState(pid) === 'Z') return pid
      sleepSync(50)
    }
    return undefined // init reaped it before we could observe the zombie
  } catch {
    return undefined
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('HostTaskLedger', () => {
  it('imports each source once and merges newer fields with the execution union', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    const old = task('same', NOW - 100)
    const opened = startExecution(old, NOW - 90, 'exec-a').task
    const newer = { ...task('same', NOW + 1), title: 'newer', executions: [
      { id: 'exec-b', sessionId: 'session-b', startedAt: NOW - 80, endedAt: NOW - 70, result: 'succeeded' as const, error: undefined },
    ] }
    ledger.applyRequest('request-a', { kind: 'import', sourceId: 'browser-a', tasks: [opened] })
    ledger.applyRequest('request-b', { kind: 'import', sourceId: 'browser-b', tasks: [newer] })
    const revision = ledger.state().revision
    ledger.applyRequest('request-c', { kind: 'import', sourceId: 'browser-a', tasks: [task('ignored')] })
    ledger.applyRequest('request-d', {
      kind: 'import', sourceId: 'browser-equal', tasks: [{ ...task('same', NOW + 1), title: 'equal-time browser copy' }],
    })
    const merged = ledger.state().tasks[0]
    expect(merged.title).toBe('newer')
    expect(merged.executions.map(entry => entry.id)).toEqual(['exec-a', 'exec-b'])
    expect(ledger.state().revision).toBe(revision + 1)
  })

  it('persists atomically, restores revision, and returns the first duplicate request result', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    const first = ledger.applyRequest('same-request', {
      kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' },
    })
    const duplicate = ledger.applyRequest('same-request', {
      kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' },
    })
    expect(duplicate.state).toEqual(first.state)
    expect(ledger.state().tasks.map(value => value.id)).toEqual(['task-a'])
    expect(() => ledger.applyRequest('same-request', {
      kind: 'create', id: 'task-b', input: { title: 'B', description: '', prompt: '' },
    })).toThrow('different action')
    expect(readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([])
    ledger.dispose()
    const restored = new HostTaskLedger(root, () => NOW + 1000)
    expect(restored.state().revision).toBe(1)
    expect(restored.state().tasks[0].title).toBe('A')
  })

  it('quarantines a corrupt document without overwriting it and reports the error', () => {
    const root = tempRoot()
    const file = join(root, 'ledger-v2.json')
    writeFileSync(file, '{not json', 'utf8')
    const ledger = new HostTaskLedger(root, () => NOW)
    const recoveredId = ledger.state().scheduler.ledgerId
    expect(ledger.state().tasks).toEqual([])
    expect(ledger.state().scheduler.error).toContain('quarantined')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 2, tasks: [] })
    const quarantined = readdirSync(root).find(name => name.startsWith('ledger-v2.json.corrupt-'))
    expect(quarantined).toBeDefined()
    expect(readFileSync(join(root, quarantined!), 'utf8')).toBe('{not json')
    ledger.dispose()
    const restarted = new HostTaskLedger(root, () => NOW + 1)
    expect(restarted.state().scheduler.ledgerId).toBe(recoveredId)
    expect(restarted.state().scheduler.error).toContain('quarantined')
  })

  it('opens one due execution and rolls a running task without queuing another', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    const due = withSchedule(task('scheduled'), {
      enabled: true, cron: '* * * * *', nextRunAt: NOW, lastTriggeredAt: undefined,
    }, NOW)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'source', tasks: [due] })
    const opened = ledger.openScheduled('scheduled', NOW + 60_000, NOW)
    expect(opened).toBeDefined()
    expect(ledger.openScheduled('scheduled', NOW + 120_000, NOW + 60_000)).toBeUndefined()
    const current = ledger.state().tasks[0]
    expect(current.executions).toHaveLength(1)
    expect(current.schedule?.nextRunAt).toBe(NOW + 120_000)
  })

  it('derives detached runtime projections without copying settled execution details', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    const history = Array.from({ length: 2_000 }, (_, index) => ({
      id: `settled-${index}`,
      sessionId: `session-${index}`,
      startedAt: NOW - 4_000 - index * 2,
      endedAt: NOW - 3_999 - index * 2,
      result: 'succeeded' as const,
      error: undefined,
    }))
    const running = startExecution({ ...task('running'), executions: history }, NOW - 1_000, 'open').task
    const awaitingSession = {
      ...startExecution(task('awaiting-session'), NOW - 500, 'awaiting-session-open').task,
      status: 'todo' as const,
    }
    const archivedSchedule = {
      ...withSchedule(task('archived-schedule'), {
        enabled: true, cron: '* * * * *', nextRunAt: NOW, lastTriggeredAt: undefined,
      }, NOW),
      status: 'done' as const,
      archivedAt: NOW - 1,
    }
    ledger.applyRequest('import-running', {
      kind: 'import',
      sourceId: 'browser',
      tasks: [
        {
          ...running,
          executions: running.executions.map(execution => execution.id === 'open'
            ? { ...execution, sessionId: 'session-open' }
            : execution),
        },
        awaitingSession,
        archivedSchedule,
      ],
    })
    ledger.applyRequest('create-scheduled', {
      kind: 'create',
      id: 'scheduled',
      input: { title: 'Scheduled', description: '', prompt: '', schedule: { enabled: true, cron: '* * * * *' } },
    })

    const runtime = ledger.runtimeView()
    expect(runtime).toEqual({
      armedSchedules: 1,
      openExecutions: [{
        taskId: 'running',
        executionId: 'open',
        sessionId: 'session-open',
        startedAt: NOW - 1_000,
      }, {
        taskId: 'awaiting-session',
        executionId: 'awaiting-session-open',
        sessionId: undefined,
        startedAt: NOW - 500,
      }],
    })
    expect(ledger.armedScheduleCount()).toBe(1)
    expect(ledger.dueSchedules(NOW + 60_000)).toEqual([{
      taskId: 'scheduled',
      cron: '* * * * *',
      nextRunAt: NOW + 30_000,
    }])
    expect(ledger.runtimeView().openExecutions[0]).not.toBe(runtime.openExecutions[0])
  })

  it('cancels a running record without a session id after restart instead of resending it', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })
    ledger.dispose()
    const restarted = new HostTaskLedger(root, () => NOW + 1000)
    const execution = restarted.state().tasks[0].executions[0]
    expect(execution.result).toBe('cancelled')
    expect(execution.error).toContain('restarted')
  })

  it('persists request fingerprints and scheduler metadata across Host restarts', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })
    ledger.setScheduler({ lastTickAt: NOW })
    ledger.dispose()

    const restarted = new HostTaskLedger(root, () => NOW + 1_000)
    const beforeRetry = restarted.state()
    const duplicate = restarted.applyRequest('run', { kind: 'run', taskId: 'task-a' })
    expect(duplicate.state).toEqual(beforeRetry)
    expect(duplicate.state.tasks[0].executions).toHaveLength(1)
    expect(duplicate.state.tasks[0].executions[0].result).toBe('cancelled')
    expect(duplicate.state.scheduler.lastTickAt).toBe(NOW)
    expect(() => restarted.applyRequest('run', {
      kind: 'rerun', taskId: 'task-a',
    })).toThrow('different action')
    restarted.dispose()
  })

  it('trims an over-limit execution history when loading an old ledger file', () => {
    const root = tempRoot()
    const executions = Array.from({ length: 30 }, (_, index) => ({
      id: `old-${index}`,
      sessionId: `session-${index}`,
      startedAt: NOW - 100 - index,
      endedAt: NOW - 50 - index,
      result: 'succeeded' as const,
      error: undefined,
    }))
    writeFileSync(join(root, 'ledger-v2.json'), JSON.stringify({
      schemaVersion: 2,
      revision: 7,
      tasks: [{ ...task('fat'), executions }],
      scheduler: { timeZone: 'UTC', ledgerId: 'ledger-fat' },
      recentRequests: [],
    }), 'utf8')

    const ledger = new HostTaskLedger(root, () => NOW + 1000)
    const loaded = ledger.state().tasks[0]
    expect(loaded.executions).toHaveLength(EXECUTION_HISTORY_LIMIT)
    expect(loaded.executions[0].id).toBe('old-10')
    expect(loaded.executions.at(-1)?.id).toBe('old-29')
    // The initial commit persists the trimmed view, so the read and write
    // paths agree on the retention limit.
    const onDisk = JSON.parse(readFileSync(join(root, 'ledger-v2.json'), 'utf8')) as { tasks: { executions: unknown[] }[] }
    expect(onDisk.tasks[0].executions).toHaveLength(EXECUTION_HISTORY_LIMIT)
    ledger.dispose()
  })

  it('fails closed on a second live owner of the same ledger directory', () => {
    const root = tempRoot()
    const first = new HostTaskLedger(root, () => NOW)
    expect(() => new HostTaskLedger(root, () => NOW)).toThrow('already owned')
    first.dispose()
    const successor = new HostTaskLedger(root, () => NOW)
    expect(successor.state().scheduler.ledgerId).toBeDefined()
    successor.dispose()
  })

  it('takes over a stale legacy lock whose pid was reused by a newer process', () => {
    const root = tempRoot()
    const lockFile = join(root, 'ledger-v2.lock')
    // Legacy lock from a crashed owner: no recorded start time, old mtime.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'stale-owner' }), { encoding: 'utf8' })
    const past = Date.now() - 60 * 60 * 1000
    utimesSync(lockFile, past / 1000, past / 1000)
    const ledger = new HostTaskLedger(root, () => NOW)
    expect(ledger.state().scheduler.ledgerId).toBeDefined()
    ledger.dispose()
  })

  it('takes over a lock whose recorded start time does not match the live pid', () => {
    const root = tempRoot()
    const lockFile = join(root, 'ledger-v2.lock')
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() + 86_400_000 }), { encoding: 'utf8' })
    const ledger = new HostTaskLedger(root, () => NOW)
    expect(ledger.state().scheduler.ledgerId).toBeDefined()
    ledger.dispose()
  })

  it('fails closed with a recovery hint when a fresh legacy lock cannot be disproved', () => {
    const root = tempRoot()
    const lockFile = join(root, 'ledger-v2.lock')
    // A legacy lock with a fresh mtime cannot be proven stale by ordering,
    // so the ledger must refuse to start and explain how to recover.
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { encoding: 'utf8' })
    let message = ''
    try {
      new HostTaskLedger(root, () => NOW)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('already owned by process')
    expect(message).toContain('remove')
    expect(message).toContain(lockFile)
  })

  it('takes over a legacy lock whose recorded pid is dead (power-loss leftover)', () => {
    const root = tempRoot()
    const lockFile = join(root, 'ledger-v2.lock')
    // Issue #886: an unclean shutdown (power loss) leaves a lock whose pid
    // is no longer alive after the next boot. The dead pid must not block
    // startup: the lock is stale by liveness alone.
    const dead = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 })
    expect(dead.pid).toBeDefined()
    writeFileSync(lockFile, JSON.stringify({ pid: dead.pid, token: 'power-loss-owner' }), { encoding: 'utf8' })
    const ledger = new HostTaskLedger(root, () => NOW)
    expect(ledger.state().scheduler.ledgerId).toBeDefined()
    ledger.dispose()
  })

  it('names the lock file and a recovery hint when the lock is unreadable', () => {
    const root = tempRoot()
    const lockFile = join(root, 'ledger-v2.lock')
    // A power-loss mid-write can leave a truncated lock. The same event
    // killed the writer, so the next start must fail closed but explain
    // exactly how to recover instead of a bare "unreadable" error.
    writeFileSync(lockFile, '{not-json', { encoding: 'utf8' })
    let message = ''
    try {
      new HostTaskLedger(root, () => NOW)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('unreadable')
    expect(message).toContain('remove')
    expect(message).toContain(lockFile)
  })

  it('takes over a lock owned by an unreaped zombie process', () => {
    const zombie = spawnZombie()
    if (zombie === undefined) return // environment reaps orphans; cannot exercise
    const root = tempRoot()
    // Record the zombie's REAL (legacy second-granularity) start time, so the
    // identity comparison alone would look like a live owner. Only the
    // zombie-state check (processIsAlive === false) lets this lock be taken
    // over — the test fails without it.
    const startedAt = secondGranularStartMs(zombie)
    if (startedAt === undefined) return // cannot simulate the legacy record
    writeFileSync(join(root, 'ledger-v2.lock'), JSON.stringify({ pid: zombie, token: 'zombie-owner', startedAt }), 'utf8')
    const ledger = new HostTaskLedger(root, () => NOW)
    expect(ledger.state().scheduler.ledgerId).toBeDefined()
    ledger.dispose()
  })

  it('fails closed on a live owner whose lock records a second-granularity (legacy ps) start time', () => {
    const root = tempRoot()
    // A live old-version owner wrote its own start time through `ps -o
    // lstart=` (whole-second resolution). The new ms-precise /proc probe
    // reports the same process with a sub-second remainder; strict equality
    // would read that as PID reuse, unlink the live owner's lock and start a
    // second ledger writer during a rolling upgrade. The bounded legacy
    // tolerance must keep this owner protected (fail closed).
    const startedAt = secondGranularStartMs(process.pid)
    if (startedAt === undefined) return // ps unavailable — cannot exercise
    const lockFile = join(root, 'ledger-v2.lock')
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'legacy-live-owner', startedAt }), 'utf8')
    let message = ''
    try {
      new HostTaskLedger(root, () => NOW)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('already owned by process')
    // The tolerance classifies the owner as confirmed (sub-second probe
    // difference), so no misleading "PID was reused — remove the lock"
    // recovery hint is appended.
    expect(message).not.toContain('remove')
  })

  it('treats an unreaped zombie as dead even though kill(0) reports it alive', () => {
    const zombie = spawnZombie()
    if (zombie === undefined) return // environment reaps orphans; cannot exercise
    expect(processState(zombie)).toBe('Z')
    let killSaysAlive = false
    try { process.kill(zombie, 0); killSaysAlive = true } catch { /* absent */ }
    expect(killSaysAlive).toBe(true) // the lie the old probe fell for
    expect(processIsAlive(zombie)).toBe(false)
  })

  it('reports live and absent processes correctly for the liveness probe', () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' })
    try {
      if (child.pid === undefined) throw new Error('spawn did not yield a pid')
      expect(processIsAlive(child.pid)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
    expect(processIsAlive(process.pid)).toBe(true)
    expect(processIsAlive(2_000_000_000)).toBe(false)
  })

  it('rejects moving or deleting a task while any execution remains open', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })
    expect(() => ledger.applyRequest('move', { kind: 'move', taskId: 'task-a', status: 'todo' })).toThrow('cannot be moved')
    expect(() => ledger.applyRequest('delete', { kind: 'delete', taskId: 'task-a' })).toThrow('cannot be deleted')
    expect(ledger.state().tasks[0].executions).toHaveLength(1)
  })

  it('cancels an imported interrupted start and preserves an invalid cron as disabled', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    const interrupted = startExecution(task('legacy'), NOW - 100, 'legacy-execution').task
    const invalid = withSchedule(task('invalid'), {
      enabled: true,
      cron: '0 0 30 2 *',
      nextRunAt: NOW - 1,
      lastTriggeredAt: undefined,
    }, NOW)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'legacy-browser', tasks: [interrupted, invalid] })
    const state = ledger.state()
    expect(state.tasks.find(value => value.id === 'legacy')?.executions[0].result).toBe('cancelled')
    expect(state.tasks.find(value => value.id === 'invalid')?.schedule).toMatchObject({
      enabled: false,
      cron: '0 0 30 2 *',
    })
    expect(state.tasks.find(value => value.id === 'invalid')?.schedule?.nextRunAt).toBeUndefined()
    expect(state.scheduler.error).toContain('invalid')
  })

  it('keeps archived tasks read-only at the Host boundary', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    const settled = { ...task('archived'), status: 'done' as const }
    ledger.applyRequest('import-archived', { kind: 'import', sourceId: 'browser', tasks: [settled] })
    ledger.applyRequest('archive', { kind: 'archive', taskId: 'archived' })

    expect(ledger.state().tasks[0].archivedAt).toBe(NOW)
    expect(() => ledger.applyRequest('update-archived', {
      kind: 'update', taskId: 'archived', patch: { title: 'renamed' },
    })).toThrow('archived task is read-only')
    expect(() => ledger.applyRequest('move-archived', {
      kind: 'move', taskId: 'archived', status: 'todo',
    })).toThrow('archived task is read-only')
    expect(() => ledger.applyRequest('schedule-archived', {
      kind: 'set-schedule', taskId: 'archived', patch: { enabled: true, cron: '* * * * *' },
    })).toThrow('archived task is read-only')
    expect(() => ledger.applyRequest('run-archived', {
      kind: 'run', taskId: 'archived',
    })).toThrow('archived task is read-only')
    expect(() => ledger.applyRequest('rerun-archived', {
      kind: 'rerun', taskId: 'archived',
    })).toThrow('archived task is read-only')
    expect(ledger.openScheduled('archived', NOW + 60_000, NOW)).toBeUndefined()
    expect(ledger.state().tasks[0].executions).toEqual([])
  })

  it('edits task content only before the first execution and keeps targets editable after', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: 'd', prompt: 'p' } })
    const edited = ledger.applyRequest('update', { kind: 'update', taskId: 'task-a', patch: { title: 'B', description: 'd2', prompt: 'p2' } })
    expect(edited.state.tasks[0]).toMatchObject({ title: 'B', description: 'd2', prompt: 'p2' })

    expect(() => ledger.applyRequest('update-blank-title', { kind: 'update', taskId: 'task-a', patch: { title: '   ' } })).toThrow('title is required')

    const opened = ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })
    const executionId = opened.state.tasks[0].executions[0].id
    expect(() => ledger.applyRequest('update-running', { kind: 'update', taskId: 'task-a', patch: { prompt: 'live' } })).toThrow('task has already been executed')

    ledger.settle('task-a', executionId, 'failed', 'boom')
    expect(() => ledger.applyRequest('update-done', { kind: 'update', taskId: 'task-a', patch: { title: 'C' } })).toThrow('task has already been executed')

    // Execution targets stay editable on an executed task; content stays fixed.
    const targets = ledger.applyRequest('update-targets', { kind: 'update', taskId: 'task-a', patch: { workspaceId: 'ws-1', mode: 'anchored', permission: 'read-only' } })
    expect(targets.state.tasks[0]).toMatchObject({
      title: 'B', description: 'd2', prompt: 'p2',
      workspaceId: 'ws-1', mode: 'anchored', permission: 'read-only',
    })
  })

  it('rejects a newly armed cron with no reachable occurrence', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    expect(() => ledger.applyRequest('create', {
      kind: 'create', id: 'impossible', input: {
        title: 'Impossible', description: '', prompt: '', schedule: { enabled: true, cron: '0 0 30 2 *' },
      },
    })).toThrow('invalid schedule')
    expect(ledger.state().tasks).toEqual([])
  })

  it('persists scheduler heartbeats to a sidecar without rewriting the ledger document', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    const before = readFileSync(join(root, 'ledger-v2.json'), 'utf8')
    ledger.setScheduler({ lastTickAt: NOW + 30_000 })
    ledger.setScheduler({ lastTickAt: NOW + 60_000 })
    expect(readFileSync(join(root, 'ledger-v2.json'), 'utf8')).toBe(before)
    expect(readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([])
    ledger.dispose()
    const restarted = new HostTaskLedger(root, () => NOW + 61_000)
    expect(restarted.state().scheduler.lastTickAt).toBe(NOW + 60_000)
    restarted.dispose()
  })

  it('takes the newer of the document and sidecar heartbeat after restart', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    ledger.setScheduler({ lastTickAt: NOW + 30_000 })
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    // Full commit persists lastTickAt; a sidecar left over from an earlier
    // crash must not roll it back, and a newer sidecar must win.
    writeFileSync(join(root, 'scheduler-v2.json'), JSON.stringify({ lastTickAt: NOW - 5_000 }), 'utf8')
    ledger.dispose()
    const older = new HostTaskLedger(root, () => NOW + 31_000)
    expect(older.state().scheduler.lastTickAt).toBe(NOW + 30_000)
    older.dispose()
    writeFileSync(join(root, 'scheduler-v2.json'), JSON.stringify({ lastTickAt: NOW + 90_000 }), 'utf8')
    const newer = new HostTaskLedger(root, () => NOW + 91_000)
    expect(newer.state().scheduler.lastTickAt).toBe(NOW + 90_000)
    newer.dispose()
  })

  it('still commits non-heartbeat scheduler patches through the full document write', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    ledger.setScheduler({ error: 'visible after restart' })
    ledger.dispose()
    const restarted = new HostTaskLedger(root, () => NOW + 1_000)
    expect(restarted.state().scheduler.error).toBe('visible after restart')
    restarted.dispose()
  })

  it('stops one task: settles its open execution as cancelled and returns the session to cancel', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    const opened = ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })
    const executionId = opened.state.tasks[0].executions[0].id
    ledger.attachSession('task-a', executionId, 'session-a')

    const result = ledger.applyRequest('stop', { kind: 'stop', taskId: 'task-a' })
    expect(result.stopSessions).toEqual(['session-a'])
    const task = result.state.tasks.find(value => value.id === 'task-a')!
    expect(task.status).toBe('failed')
    expect(task.executions[0]).toMatchObject({ result: 'cancelled', endedAt: NOW })
    // A second stop is refused (nothing left running).
    expect(() => ledger.applyRequest('stop-2', { kind: 'stop', taskId: 'task-a' })).toThrow('not running')
  })

  it('stops a task with only a queued run (no session yet)', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    const opened = ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })
    const executionId = opened.state.tasks[0].executions[0].id
    ledger.markQueued('task-a', executionId, 'cloud', NOW, 'endpoint')
    const result = ledger.applyRequest('stop', { kind: 'stop', taskId: 'task-a' })
    expect(result.stopSessions).toBeUndefined()
    expect(result.state.tasks[0].status).toBe('failed')
    expect(result.state.tasks[0].executions[0].result).toBe('cancelled')
  })

  it('stops a whole group: cancels every open member execution, marks it stopped, and reports sessions', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('group', { kind: 'create-group', id: 'g1', input: { name: 'G', mode: 'parallel' } })
    ledger.applyRequest('create-a', { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: '', groupId: 'g1' } })
    ledger.applyRequest('create-b', { kind: 'create', id: 'b', input: { title: 'B', description: '', prompt: '', groupId: 'g1' } })
    const a = ledger.applyRequest('run-a', { kind: 'run', taskId: 'a' })
    const b = ledger.applyRequest('run-b', { kind: 'run', taskId: 'b' })
    const aExec = a.state.tasks.find(value => value.id === 'a')!.executions[0].id
    const bExec = b.state.tasks.find(value => value.id === 'b')!.executions[0].id
    ledger.attachSession('a', aExec, 'session-a')
    ledger.attachSession('b', bExec, 'session-b')

    const result = ledger.applyRequest('stop-group', { kind: 'stop-group', groupId: 'g1' })
    expect(result.stopSessions).toEqual(['session-a', 'session-b'])
    expect(result.state.groups[0]!.stopped).toBe(true)
    for (const id of ['a', 'b']) {
      expect(result.state.tasks.find(value => value.id === id)!.status).toBe('failed')
      expect(result.state.tasks.find(value => value.id === id)!.executions[0].result).toBe('cancelled')
    }
    // Members of a stopped group cannot be run again until resumed.
    expect(() => ledger.applyRequest('run-a-2', { kind: 'run', taskId: 'a' })).toThrow('group is stopped')
    // Resume clears the flag and allows runs again.
    ledger.applyRequest('resume', { kind: 'update-group', groupId: 'g1', patch: { stopped: false } })
    expect(ledger.state().groups[0]!.stopped).toBeUndefined()
    expect(ledger.applyRequest('run-a-3', { kind: 'run', taskId: 'a' }).state.tasks.find(value => value.id === 'a')!.status).toBe('running')
  })

  it('moves a whole group to a manual column and refuses while a member runs', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('group', { kind: 'create-group', id: 'g1', input: { name: 'G' } })
    ledger.applyRequest('create-a', { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: '', groupId: 'g1' } })
    ledger.applyRequest('create-b', { kind: 'create', id: 'b', input: { title: 'B', description: '', prompt: '', groupId: 'g1' } })

    const moved = ledger.applyRequest('move-group', { kind: 'move-group', groupId: 'g1', status: 'todo' })
    const tasks = moved.state.tasks
    expect(tasks.find(value => value.id === 'a')!.status).toBe('todo')
    expect(tasks.find(value => value.id === 'b')!.status).toBe('todo')
    expect(() => ledger.applyRequest('move-group-bad', { kind: 'move-group', groupId: 'g1', status: 'done' })).toThrow('invalid manual status')

    // A running member blocks the whole move.
    ledger.applyRequest('run-b', { kind: 'run', taskId: 'b' })
    expect(() => ledger.applyRequest('move-group-2', { kind: 'move-group', groupId: 'g1', status: 'backlog' })).toThrow('group has running tasks')
  })

  it('refuses to run an unapproved task until set-approved clears the gate', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '', approved: false } })
    expect(ledger.state().tasks[0]!.approved).toBe(false)
    expect(() => ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })).toThrow('task is not approved')
    expect(() => ledger.applyRequest('rerun', { kind: 'rerun', taskId: 'task-a' })).toThrow('task is not approved')
    // Manual moves and edits stay allowed while unapproved.
    ledger.applyRequest('move', { kind: 'move', taskId: 'task-a', status: 'backlog' })
    expect(ledger.state().tasks[0]!.status).toBe('backlog')
    ledger.applyRequest('update', { kind: 'update', taskId: 'task-a', patch: { description: 'still editable' } })
    expect(ledger.state().tasks[0]!.description).toBe('still editable')
    // Approving clears the explicit flag (approved is the default); runs work again.
    const approved = ledger.applyRequest('approve', { kind: 'set-approved', taskId: 'task-a', approved: true })
    expect(approved.state.tasks[0]!.approved).toBeUndefined()
    expect(ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' }).state.tasks[0]!.status).toBe('running')
  })

  it('unapproves a task through set-approved and refuses every run path', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('create', { kind: 'create', id: 'task-a', input: { title: 'A', description: '', prompt: '' } })
    const gated = ledger.applyRequest('unapprove', { kind: 'set-approved', taskId: 'task-a', approved: false })
    expect(gated.state.tasks[0]!.approved).toBe(false)
    expect(() => ledger.applyRequest('run', { kind: 'run', taskId: 'task-a' })).toThrow('task is not approved')
    // Re-approving is idempotent: the explicit flag stays absent.
    const approved = ledger.applyRequest('approve-2', { kind: 'set-approved', taskId: 'task-a', approved: true })
    expect(approved.state.tasks[0]!.approved).toBeUndefined()
    // Unapproved tasks cannot be archived (archived tasks are read-only),
    // but they can be deleted.
    ledger.applyRequest('unapprove-2', { kind: 'set-approved', taskId: 'task-a', approved: false })
    expect(() => ledger.applyRequest('archive', { kind: 'archive', taskId: 'task-a' })).toThrow('cannot be archived')
    ledger.applyRequest('delete', { kind: 'delete', taskId: 'task-a' })
    expect(ledger.state().tasks).toEqual([])
  })

  it('holds an unapproved task\'s cron without launching and resumes the cadence on approval', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    const due = withSchedule({ ...task('scheduled'), approved: false }, {
      enabled: true, cron: '* * * * *', nextRunAt: NOW, lastTriggeredAt: undefined,
    }, NOW)
    ledger.applyRequest('import', { kind: 'import', sourceId: 'source', tasks: [due] })
    // The occurrence rolls forward without opening an execution.
    expect(ledger.openScheduled('scheduled', NOW + 60_000, NOW)).toBeUndefined()
    expect(ledger.state().tasks[0].executions).toEqual([])
    expect(ledger.state().tasks[0].schedule?.nextRunAt).toBe(NOW + 60_000)
    // Once approved, the next due occurrence launches normally.
    ledger.applyRequest('approve', { kind: 'set-approved', taskId: 'scheduled', approved: true })
    const opened = ledger.openScheduled('scheduled', NOW + 120_000, NOW + 60_000)
    expect(opened).toBeDefined()
    expect(ledger.state().tasks[0].status).toBe('running')
  })

  it('excludes unapproved members from the group runtime runnable set', () => {
    const ledger = new HostTaskLedger(tempRoot(), () => NOW)
    ledger.applyRequest('group', { kind: 'create-group', id: 'g1', input: { name: 'G' } })
    ledger.applyRequest('create-a', { kind: 'create', id: 'a', input: { title: 'A', description: '', prompt: '', groupId: 'g1' } })
    ledger.applyRequest('create-b', { kind: 'create', id: 'b', input: { title: 'B', description: '', prompt: '', groupId: 'g1', approved: false } })
    const view = ledger.groupRuntimeViews()[0]!
    expect(view.members.find(member => member.taskId === 'a')!.runnable).toBe(true)
    expect(view.members.find(member => member.taskId === 'b')!.runnable).toBe(false)
    // openExecution (the auto-advance seam) also refuses an unapproved member.
    expect(ledger.openExecution('b', NOW)).toBeUndefined()
    expect(ledger.openExecution('a', NOW)).toBeDefined()
  })

  it('stores, updates, clears, and drops per-workspace defaults', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    expect(ledger.state().workspaceDefaults).toEqual({})

    const set = ledger.applyRequest('set-defaults', {
      kind: 'set-workspace-defaults',
      workspaceId: 'ws-a',
      patch: { mode: 'planner', model: { provider: 'deepseek', model: 'chat' }, permission: 'read-only', approved: false },
    })
    expect(set.state.workspaceDefaults['ws-a']).toEqual({
      mode: 'planner',
      model: { provider: 'deepseek', model: 'chat' },
      permission: 'read-only',
      approved: false,
    })

    // A second edit merges onto the record: new field set, old field cleared.
    const updated = ledger.applyRequest('update-defaults', {
      kind: 'set-workspace-defaults',
      workspaceId: 'ws-a',
      patch: { mode: null, endpoints: ['deepseek-official'] },
    })
    expect(updated.state.workspaceDefaults['ws-a']).toEqual({
      model: { provider: 'deepseek', model: 'chat' },
      endpoints: ['deepseek-official'],
      permission: 'read-only',
      approved: false,
    })

    // Clearing every remaining field drops the entry entirely.
    const cleared = ledger.applyRequest('clear-defaults', {
      kind: 'set-workspace-defaults',
      workspaceId: 'ws-a',
      patch: { model: null, endpoints: null, permission: null, approved: null },
    })
    expect(cleared.state.workspaceDefaults).toEqual({})

    // Other workspaces are untouched; an all-null edit on a missing entry is a no-op.
    ledger.applyRequest('set-b', { kind: 'set-workspace-defaults', workspaceId: 'ws-b', patch: { mode: 'coder' } })
    ledger.applyRequest('clear-missing', { kind: 'set-workspace-defaults', workspaceId: 'ws-c', patch: { mode: null } })
    expect(ledger.state().workspaceDefaults).toEqual({ 'ws-b': { mode: 'coder' } })
  })

  it('persists per-workspace defaults across a reload and drops invalid entries on load', () => {
    const root = tempRoot()
    const ledger = new HostTaskLedger(root, () => NOW)
    ledger.applyRequest('set', { kind: 'set-workspace-defaults', workspaceId: 'ws-a', patch: { mode: 'planner', approved: false } })
    ledger.dispose()

    // Corrupt the persisted file: add an invalid entry the loader must drop.
    const file = join(root, 'ledger-v2.json')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    raw.workspaceDefaults = { 'ws-a': { mode: 'planner', approved: false }, 'ws-bad': { mode: 42, permission: 'sudo' } }
    writeFileSync(file, JSON.stringify(raw))

    const reloaded = new HostTaskLedger(root, () => NOW)
    expect(reloaded.state().workspaceDefaults).toEqual({ 'ws-a': { mode: 'planner', approved: false } })
  })
})
