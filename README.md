# all-tasks — DSH web GUI task board plugin

English | [中文](README.zh.md)

A hot-pluggable DeepSeek Harness (DSH) Web GUI plugin with a Host-authoritative task ledger, real DSH session execution, Host cron scheduling, and optional cross-platform idle-sleep protection. It is mounted through `cordis.patch.yml` and the profile mechanism and does not modify DSH source code.

> **Origin**: this is a standalone fork of the `dsh-task-board` package
> (`@linxin666/dsh-client-ui-task-board`) from the
> [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web) monorepo,
> cut at the upstream `v0.3.6` tag and extended with a per-task model pin
> and a reasoning-effort picker. The
> package name, repo, and user-visible labels are renamed to All Tasks;
> internal identifiers (the `task-board` settings namespace, `/api/task-board`
> prefix, and `$DSH_HOME/task-board/` ledger directory) are kept so an
> existing dsh-task-board ledger and settings carry over unchanged. Licensed
> under Apache-2.0 (see [LICENSE](LICENSE)), matching the upstream package.

- The browser is an asynchronous view; closing the page does not stop Host scheduling or execution settlement.
- Every run creates a separate DSH session and applies pinned workspace, agent preset, model selection, and permission before sending the task prompt.
- The display may turn off while optional power protection keeps the computer from entering idle system sleep.

## Features

- **Task board UI**: a sidebar entry below New Session shows icon and text in the wide sidebar and an icon in the collapsed rail; the board provides five kanban columns, search, task details, archive/restore, execution history, and links to execution transcripts. Archived tasks are read-only except for restore, delete, and transcript viewing, and cannot run manually or on schedule until restored.
- **Host-authoritative ledger**: tasks, schedules, and execution records live in `$DSH_HOME/task-board/ledger-v2.json`; browser actions become confirmed Host transactions.
- **Bounded execution history**: each task keeps the most recent 20 execution records; the oldest runs are trimmed when a new run starts, so ledger size and write cost stay bounded regardless of how often a task has run.
- **Real execution**: manual and scheduled runs use the same Host runner, create a fresh session, rename it, apply the agent preset, pin the model selection through `session.selectModel`, apply `/permission <id>`, then queue the task prompt.
- **Fail-closed pins**: a missing workspace, missing or broken preset, rejected model selection, or rejected permission command fails before the task prompt is sent.
- **Per-task model pin**: each task may pin its execution session to a specific provider/model chosen from the host model catalog, plus an optional reasoning-effort level (minimal/low/medium/high or the provider's own value); a blank pin falls back to the deployment default model.
- **Endpoint model-router**: named compute endpoints (DeepSeek Official, an LM Studio on the NAS, …). An endpoint is deliberately lean — it names one DSH provider route and narrows which of that provider's models it serves plus a default model; concurrency, token caps, and windows belong to the provider's own settings, not here. Each endpoint also sets that provider's model-request timeouts (idle + total). Endpoints are created and edited from the settings card (**Settings → Plugins → All Tasks → Endpoints**): a full-list editor writes the `task-board` namespace live, and the task modal's Endpoints dropdown plus the router pick the change up immediately. The router launches every run through the first endpoint in the task's priority order (or the global default list) that can serve the task's model (its own pin, else the endpoint's `defaultModel`). A run whose endpoints are all blocked waits (queued, nothing billed, survives restarts) and auto-starts when a slot frees, failing only after a configurable max-wait (24 h by default). The off-peak schedule is hard-coded to DeepSeek's official rule (peak 01:00–04:00 and 06:00–10:00 UTC Mon–Fri; every other hour and all of Sat/Sun off-peak, per the 2026-08-23 pricing change) and is not configurable.
- **Task groups**: named sets of tasks with shared execution policy, shown as a group inside every kanban column under its own banner (empty groups stay visible in the To Do column, so a fresh group is immediately findable and manageable). A group has an execution mode — sequential (one member at a time, in the group's member order) or parallel (up to a configurable cap, blank = unlimited) — that gates every launch of a member (manual, cron, or router auto-start). A group may pin its own priority-ordered endpoint list (the member's own pin wins, then the group's, then the global default), an allowed-hours window plus an off-peak-only flag (the hard-coded DeepSeek schedule above), and an optional group cron. When the group cron is armed, members inherit it and their own schedules are ignored; when a member settles, the next runnable member in order starts automatically. Blocked manual runs show why they wait (**waiting for a group slot** / **waiting for the allowed window** / **waiting for endpoint**) and auto-start when a slot or window frees, exactly like the endpoint queue. The board stops work directly: every running member card carries its own **Stop** button, and the group banner's **Stop group** cancels all running members and marks the group stopped (no member launches — manual runs, member crons, and the group cron are all refused) until its **Resume** button clears the flag. Dragging the group banner onto the Backlog or To Do column moves the whole group at once instead of dragging members one by one.
- **Approval gate**: every task carries an approval state. Tasks created manually are approved by default; programmatic creation (the protocol `create` action) may mint a task unapproved. An unapproved task can never be run by any means — manual Run/Rerun, its own cron, and group auto-advance are all refused until it is approved again (a group sequence skips it and continues with the next member). Unapproved tasks stay fully manageable: they render with a **Not approved** badge, can be moved/edited/grouped, and the header's **Unapproved only** filter shows exactly what needs approval for the day. Approve with one click from the card (✓), the task detail, or the group member row; the task detail also offers **Unapprove**. A queued run whose task is unapproved while waiting is cancelled (lands in the Failed column), and a task cron held while unapproved rolls forward to its next occurrence instead of firing late.
- **Workspace overview grid**: the board opens on a workspace overview — one card per workspace with live task counts (To do / Pending / Working / Scheduled / Finished / Failed), plus an **All tasks** card aggregating every workspace (including unassigned tasks). Clicking a card opens that workspace's kanban; the kanban is always workspace-scoped now, the header's **back** button returns to the overview, and the old workspace dropdown is gone. A scoped view shows that workspace's pinned tasks per column, then an **Unassigned** section for tasks without a pin (they fall back to the recent workspace at run time), so nothing disappears from any view; task groups stay whole, showing the selected workspace's members plus unpinned members. Workspaces pinned by tasks but missing from the runtime list (deleted or renamed) still appear in the overview, so pinned tasks never become unreachable.
- **Workspace default settings**: each workspace can carry execution defaults (agent preset, model + reasoning effort, endpoint order, permission, and a "new tasks start unapproved" switch) that pre-fill the new-task dialog inside that workspace's kanban — ⚙ entry on the overview card and in the kanban header. Defaults are persisted by the Host ledger (keyed by workspace id; an all-blank edit removes the entry), and blank fields mean "use the runtime default", exactly like an unpinned task.
- **Per-endpoint model timeouts**: DSH aborts a model request when no new content arrives for 300 s (the stream-idle watchdog default), which a local LLM recomputing a long message chain or generating slowly trips even while the backend keeps producing tokens. Each endpoint's editor row carries that provider route's idle timeout (and, for custom/local `llm-pi-ai` routes, the optional total-request bound); saving writes the provider's own DSH settings, applied live to the next request through that provider, chat and task runs alike.
- **Host scheduler**: 5-field cron supports `*`, `*/n`, ranges, comma lists, Sunday `0/7`, and standard day-of-month/day-of-week OR semantics in the Host local time zone.
- **Deterministic recovery**: a running execution with a recorded session is observed after restart; an interrupted start without a session id is cancelled and is not resent. A cancelled run (a user stop, or a session that vanished mid-run) settles as cancelled and the task moves to the **Failed** column — a stop is never a success.
- **Live synchronization**: mutations return a full revisioned snapshot; SSE announces revision, scheduler, and power changes, while reconnect and page visibility recovery fetch a full snapshot.
- **Optional idle-sleep protection**: off by default; when enabled it covers every running DSH session, enabled non-archived task-board schedules, and unknown session state.
- **System-prompt injection**: the Host registers a `plugin:task-board` section (order 200) through `SystemPrompt.section`, and the task-board settings can disable the announcement without disabling the board. The guidance also reminds agents to close any visible `todo_write` plan before the final answer.

## Architecture and protocol

- `src/index.ts` mounts the Host service through the official `@deepseek-ai/dsh-host-apiproxy` and `@deepseek-ai/dsh-host-webserver` SDKs.
- `src/host-ledger.ts` serializes actions and persists `{ schemaVersion: 2, revision, tasks, groups, workspaceDefaults, scheduler, recentRequests }` through a temporary file plus atomic rename.
- `src/host-service.ts` owns cron ticks, missed-trigger skipping, runner launch, restart reconciliation, and power reasons.
- `src/client/host-api.ts` imports legacy browser data once, submits idempotent actions, and treats Host snapshots as the only confirmed UI state.
- Same-origin endpoints are `GET /api/task-board/state`, `GET /api/task-board/events`, and `POST /api/task-board/action`.
- Every endpoint requires a browser same-origin marker. Direct access is restricted to the DSH loopback origin; an authenticated same-host reverse proxy must use an explicit Host allowlist and a server-injected token. POST requests additionally require JSON. Ordinary actions are limited to 64 KiB and import to 2 MiB. The action union has no command, executable path, shell text, or arbitrary argument field.

## Install

Install from this repo, then restart `dsh web`. The first pnpm build of a
git-hosted plugin is blocked by pnpm's script policy until allowed — run the
install and add the exact key pnpm prints under `allowBuilds` in
`$DSH_HOME/profiles/web/pnpm-workspace.yaml`, then re-run:

```sh
dsh plugin --profile web remove @linxin666/dsh-client-ui-task-board   # only if the original is still installed
dsh plugin --profile web add github:cjcox17/all-tasks
```

For local development:

```sh
git clone https://github.com/cjcox17/all-tasks.git
cd all-tasks
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)
```

## Configuration

| Key | Default | Behavior |
| --- | --- | --- |
| `enabled` | `true` | Enables the Host service and browser board. |
| `announceToAgent` | `false` | Opt-in: when true, adds the task-board guidance section to agent system prompts. |
| `preventIdleSleep` | `false` | Holds one system idle-sleep assertion while any DSH session runs, any schedule is enabled, or session state is unknown. |
| `trustedProxyHosts` | `[]` | Canonical `host[:port]` authorities accepted only through the authenticated loopback reverse-proxy path. |
| `proxyTokenEnv` | `DSH_TASK_BOARD_PROXY_TOKEN` | Environment variable containing the reverse-proxy token; the token itself is never stored in plugin config. |
| `endpointMaxWaitHours` | `24` | How long a queued run may wait for an eligible endpoint before it settles failed. |
| `defaultEndpoints` | `[]` | Ordered endpoints used by tasks without explicit endpoint pins. |
| `endpoints` | `[]` | Named compute endpoints the router routes tasks through (see below). |

The off-peak schedule is hard-coded to DeepSeek's official rule (peak 01:00–04:00 and 06:00–10:00 UTC Mon–Fri; every other hour and all of Sat/Sun off-peak, per the 2026-08-23 pricing change) and is deliberately not configurable — DeepSeek owns these hours, not the user. Groups use it through their **Off-peak only** checkbox.

Direct browser access remains limited to the DSH loopback origin. For a same-host authenticated reverse proxy, bind DSH Web to loopback, set `trustedProxyHosts`, place a high-entropy token in the environment variable selected by `proxyTokenEnv`, and configure the proxy to replace (not forward from the client) `X-Dsh-Task-Board-Proxy-Token` after it authenticates the request. The proxy Host must be allowlisted, and the browser `Origin` must have that same authority. Restart the Host after changing these composition-level proxy settings.

### Endpoint routing configuration

Endpoints live under the `task-board` settings namespace. The settings card (**Settings → Plugins → All Tasks → Endpoints**) is the normal editor: it lists every endpoint, adds/removes/reorders them, picks a provider (limited to the known `llm` provider routes), narrows the served models to that provider's model list, picks a default model among them, and sets the provider's request timeouts (idle + total). Save writes the whole list — the task modal's Endpoints dropdown and the router reload live, no restart. The same values are stored as YAML under `task-board` and may be edited directly too (the router reloads them live as well); the timeout fields write through to the provider route's own settings (`llm-pi-ai` / `llm-deepseek`), which is the only place DSH honors them:

```yaml
task-board:
  defaultEndpoints: [deepseek-official]
  endpoints:
    - id: deepseek-official
      name: DeepSeek Official
      provider: deepseek-official      # an llm provider route id
      models: []                       # empty = all models of the provider
      defaultModel: deepseek-chat
    - id: lm-studio-nas
      name: LM Studio (NAS)
      provider: lm-studio
      models: [qwen/qwen3.8-27b]       # narrowed to the provider's model list
      defaultModel: qwen/qwen3.8-27b
```

A task pins endpoints in priority order (new-task modal / task detail → Endpoints); the router uses the first one that can serve the task's model — the per-task model pin when the endpoint serves it, otherwise the endpoint's `defaultModel`. While every candidate is blocked the task shows **waiting for endpoint** and starts automatically when the model becomes servable. Provider-level concerns (concurrency, token caps, allowed hours, off-peak windows) belong to the provider's own settings, not the endpoint; the only per-endpoint tunables beyond the selection are the model request timeouts (idle + total).

## Task groups

Groups are board-level entities created in the UI (header **+ New Group**), persisted in the Host ledger, and shown as a banner grouping their member cards inside every kanban column. Empty groups (no members anywhere) still render in the To Do column so a fresh group is immediately visible and manageable:

- **Membership**: a task belongs to at most one group; pick it in the new-task modal or the task detail (Groups section). Assigning appends the member to the group's order; removing ungroups it. Deleting a group ungroups its members (their tasks stay) and is refused while any member has an open run.
- **Execution mode**: sequential runs one member at a time, in the group's member order — when a member settles, the next runnable member (backlog/todo, not archived, approved) starts automatically. Parallel runs up to the configured `maxParallel` at once (blank = unlimited). Every launch of a member — manual, group cron, or router auto-start — respects the group's capacity and window, and an unapproved member is never launched (the sequence skips it and continues with the next approved member).
- **Endpoints**: a group may pin a priority-ordered endpoint list (group editor → Endpoints). The effective list for a member is the member's own pin, then the group's, then the global `defaultEndpoints`.
- **Window**: a group may restrict launches to `allowedHours` (host-local time) and/or to the hard-coded DeepSeek off-peak schedule (**Off-peak only** — peak 01:00–04:00 and 06:00–10:00 UTC Mon–Fri; weekends fully off-peak).
- **Schedule**: a group may arm its own cron. While armed, members inherit it — their own schedules are ignored (the detail view shows a hint) — and the cron starts the sequence (first runnable member; the chain then continues as members settle).
- **Stop & resume**: while any member is running, the group banner shows **Stop group** — it cancels every running member's session (each settles as `cancelled` and its task lands in the Failed column) and marks the group stopped. A stopped group launches nothing: manual member runs, member crons, and the group cron are all refused, and the banner shows a **Stopped** badge plus a **Resume** button. Each running member card also carries its own **Stop** button, so one member can be stopped without touching the rest.
- **Move the whole group**: drag the group banner onto the Backlog or To Do column to move every member at once (refused while any member is running or the group is stopped) instead of dragging cards one by one.
- **Waiting**: a manual run blocked by capacity shows **waiting for a group slot**; blocked by the group window, **waiting for the allowed window**; blocked by endpoints, **waiting for endpoint**. All three queue host-side (nothing billed, survive restarts) and auto-start when a slot or window frees, failing only after `endpointMaxWaitHours`.

## Approval

Every task has an approval state: **approved** (the default) or **unapproved**. Only the explicit unapproved state is persisted (`approved: false` on the task record); legacy tasks without the field are approved. The state is a pure gate — it never removes a task from the board, and moves, edits, grouping, and archiving stay available either way.

- **Default**: tasks created manually (the new-task dialog) are approved. Programmatic creation through the protocol `create` action may pass `approved: false` to mint a task unapproved — the intended flow for anything that should wait for a human's sign-off (e.g. tasks created by another tool for the day's queue).
- **Never runs**: an unapproved task cannot be run by any means. Manual Run/Rerun is refused by the Host ledger (`task is not approved`); its own cron is held — the occurrence rolls forward to the next scheduled instant without launching, so approving later resumes the cadence; group auto-advance and the group cron skip it and continue with the next approved member; and a run already queued for an endpoint is cancelled when its task is unapproved while waiting (it lands in the Failed column, like any stop).
- **See and approve**: unapproved cards show a **Not approved** badge, and the board header's **Unapproved only** toggle filters the whole board to exactly the tasks waiting for approval — a one-glance list for the day. Approve with a single click from the card (✓) or the group member row, or from the task detail, which also offers **Unapprove** to gate a task again.

## Workspace views

The board opens on a **workspace overview grid**: one card per workspace with live counts (To do / Pending / Working / Scheduled / Finished / Failed), plus an **All tasks** card aggregating every workspace (including unassigned tasks). Clicking a card opens that workspace's kanban — the kanban is always scoped to that workspace (the task's `workspaceId` pin — the workspace its session runs in), and the **All tasks** card opens the unscoped general overview. The kanban header's **back** button returns to the overview grid; the old **Workspace** select is gone. In a scoped view each column shows that workspace's pinned tasks first, then an **Unassigned** section for tasks without a pin (they fall back to the recent workspace at run time), so nothing disappears from any view. Task groups stay whole: a group section keeps the selected workspace's members plus its unpinned members, while members pinned to other workspaces drop out of that view. The scoping also applies to the archive view and composes with the text search; it is view state only — no task, ledger, or protocol change is involved. Workspaces pinned by tasks but missing from the runtime list (deleted or renamed) still appear in the overview, so pinned tasks never become unreachable.

## Workspace default settings

Each workspace can carry **execution defaults** that pre-fill the new-task dialog when a task is created inside that workspace's kanban (the workspace is pre-selected there):

- **Mode**: the new task's agent preset (blank = deployment default).
- **Model + reasoning effort**: the model selection pinned to the new task (blank = deployment default).
- **Endpoints**: the new task's endpoint priority order (blank = no pin).
- **Permission**: the `/permission` preset applied to the new task (blank = session default).
- **New tasks start unapproved**: when checked, new tasks in this workspace start unapproved and cannot run by any means until approved.

Defaults are persisted by the Host ledger: the `workspaceDefaults` map keyed by workspace id stores only non-empty records, edited through the protocol `set-workspace-defaults` action (patch semantics: `null` clears a field, and clearing every field removes the workspace's record). The ⚙ entry lives on the overview card and in the kanban header. Blank fields mean "use the runtime default", exactly like an unpinned task; the defaults are pre-fill only — existing tasks are untouched and the defaults never take part in the runtime fail-closed checks.

## Model request timeouts

DSH aborts a model request when no new content arrives for 300 seconds (the stream-idle watchdog default). A local LLM recomputing a long message chain, or one with low compute speed, can exceed that window even though the backend is still generating tokens, turning executions into continuous failures. The endpoint editor (Settings → Plugins → All Tasks → Endpoints) carries each endpoint's provider-route timeout fields:

- **Idle timeout (seconds)**: abort the request when no new content block arrives for this long; default 300.
- **Total request timeout (seconds)**: overall request bound (custom/local `llm-pi-ai` providers only); blank keeps the backend default.

Saving the endpoint list writes the provider's own DSH settings — `streamIdleTimeoutMs` and, for pi-ai routes, `timeoutMs`, e.g. `llm-pi-ai.providers.lm-studio.streamIdleTimeoutMs` in `~/.dsh/settings.yaml` — validated by DSH's provider schema and applied live to the very next request through that provider, chat and task runs alike. Timeouts are per-provider (all models on a route share them) because that is DSH's native granularity; the board only edits the same settings the Models page edits, so no Host, ledger, or protocol change is involved.

On macOS the backend starts `/usr/bin/caffeinate -i -w <host-pid>` and never requests `-d`. On Windows it starts the absolute Windows PowerShell under `SystemRoot` with a fixed helper that requests only `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`; it never requests `ES_DISPLAY_REQUIRED`, changes a power plan, or requires administrator privileges. On Linux it starts a systemd-logind `idle` block inhibitor only from `/usr/bin/systemd-inhibit` or `/bin/systemd-inhibit`; it does not request `sleep`, `handle-lid-switch`, or a display/screensaver inhibitor. A Linux host without systemd-logind reports `unsupported` or a visible error and does not start a desktop-specific fallback. Other platforms report `unsupported`.

## Data storage and migration

- The v2 ledger is `$DSH_HOME/task-board/ledger-v2.json`. New POSIX files use mode `0600`; Windows inherits the user directory ACL.
- A corrupt v2 file is moved to a collision-resistant `ledger-v2.json.corrupt-*` name and the Host starts with an empty ledger plus a visible scheduler error. The corrupt bytes are not overwritten.
- On the first upgraded page load for an origin, `dsh.taskBoard.v1` is imported by stable source and request ids. Tasks merge by id, strictly newer browser top-level fields win, equal timestamps keep Host fields, and execution records merge by execution id.
- The most recent 256 request ids and SHA-256 action fingerprints are stored with the ledger, so a retried mutation remains idempotent after a Host restart without duplicating full action payloads.
- The import marker `dsh.taskBoard.v2.hostImported` stores the confirmed Host ledger generation only after import succeeds. A new or recovered ledger generation is offered the retained v1 data again. The v1 localStorage value remains untouched as a read-only rollback copy.
- One Host process owns a task-board ledger directory at a time through `$DSH_HOME/task-board/ledger-v2.lock`; a second Host using the same DSH home fails closed instead of concurrently writing the ledger.

## Security model

- The plugin stays inside the existing DSH Web deployment and network boundary and emits no permissive CORS headers. State, action, and SSE routes share the same access fence; bare local command-line requests are not accepted as browser requests.
- All mutation payloads use a strict, versioned discriminated union; schedule-owned timestamps and execution outcomes cannot be written by the browser.
- Workspace, preset, model selection, permission, cron, task status, and imported records are validated again on the Host.
- A task prompt is data sent to a DSH agent session. The protocol does not accept shell commands, PowerShell bodies, executable paths, or configurable helper arguments.
- Power helpers use fixed executable paths, fixed arguments, `shell: false`, and bounded retry delays of 1, 2, 5, 10, then 30 seconds. The Linux helper follows the Host stdin lifetime so the systemd inhibitor is released automatically after an abnormal Host exit.

## Build and test

Node 20 or newer and the official NPM SDK packages are required; no DSH source checkout is used.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Set `DSH_POWER_SMOKE=1` to opt into the native helper smoke test on Windows, macOS, or Linux. It starts the fixed helper, waits for readiness, releases it in cleanup, and confirms process exit without changing the system power plan. Linux first probes systemd-logind with a bounded timeout; without a usable system bus the native portion is skipped while pure logic tests remain available.

## Manual verification

1. Mount the package, restart `dsh web`, open the task board, and confirm the Host time zone and power status are visible.
2. Create and edit a task; refresh or open a second same-origin tab and confirm both show the same Host revision.
3. Run a task with pinned workspace, preset, model (plus a reasoning-effort level), and permission; confirm a new session appears and the task settles from its `turn/end` history.
4. Open the settings card (Settings → Plugins → All Tasks) → **Endpoints**, add an endpoint (e.g. `lm-studio` serving your local provider), pick the provider, tick one of its models, set the default model, and confirm the new-task modal's Endpoints dropdown lists it immediately. Then pin that endpoint on a task whose model it cannot serve and run it: the task shows **waiting for endpoint**, no session is created, and it auto-starts when the endpoint can serve the model (e.g. after you edit the endpoint to add the model or a default model). Also confirm the execution row shows which endpoint ran it.
5. Create a sequential group with two backlog members; run the first member and confirm the second starts automatically once the first settles. Add a third member and run it while the first is still running: it shows **waiting for a group slot** and launches after the settle.
6. Open the board and confirm it lands on the **workspace overview grid**: one card per workspace with live counts plus an **All tasks** card. Pin a task to one workspace and leave another unpinned; click that workspace's card and confirm the column shows the pinned task plus an **Unassigned** section with the unpinned one, while tasks pinned to other workspaces disappear; press **back** to return to the overview, then open the **All tasks** card and confirm the unscoped overview returns.
7. Open **Workspace default settings** from the overview card (or the kanban header ⚙): set a mode, model, endpoints, and permission, tick **New tasks start unapproved**, and save. Create a task inside that workspace's kanban and confirm the modal has the workspace pre-selected, the execution targets pre-filled, the unapproved toggle on, and the created task shows the **Not approved** badge and cannot run. Clear every default, save, and confirm the workspace's record is gone (new tasks no longer pre-fill).
7. In the settings card (Settings → Plugins → All Tasks) → **Endpoints**, raise the idle timeout of the endpoint serving your local provider (e.g. `lm-studio` to 600 s) and save; confirm `~/.dsh/settings.yaml` gains `llm-pi-ai.providers.lm-studio.streamIdleTimeoutMs`, then run a task through that model and confirm a long idle gap between generated chunks no longer fails. Editing the endpoint back to the default restores 300 s.
8. Enable a near-future cron, close all browser pages, and confirm the Host still creates and settles exactly one execution.
9. Stop the Host past a cron occurrence, restart it, and confirm the missed occurrence is skipped and `nextRunAt` rolls forward from current Host time.
10. Enable `preventIdleSleep`, run a long session, and let the display turn off; after restoring the display, confirm the session continued and the execution settled.
11. Disable the setting and all schedules, stop DSH, and confirm the helper exits; on macOS, `pmset -g assertions` should show no display-sleep assertion from this plugin.
12. On Linux, use `systemd-inhibit --list` to confirm that only an `idle`/`block` entry exists; the display should still follow desktop settings, while manual sleep and lid close remain under system policy.

## Known limitations

- Missed occurrences during Host downtime, system sleep, or a long pause are skipped and never queued for catch-up.
- A task that is already running skips its due occurrence and rolls to the next cron match; task runs never overlap or queue.
- DST follows the Host local wall clock: a nonexistent spring-forward minute is skipped, and a repeated fall-back minute is not replayed a second time.
- Power protection prevents only idle system sleep. It deliberately allows display sleep and lock.
- Lid close, manual sleep, hibernation, shutdown, low-battery forced sleep, and enterprise power policy are outside the guarantee.
- The plugin does not schedule wake timers and cannot wake a computer that is already asleep.
- Linux requires systemd-logind and policy permission for the current user to acquire an idle block lock. Containers, WSL, hosts without a system bus, and non-systemd systems may report `unsupported` or `error`. Whether a desktop also associates a logind idle lock with display idleness is desktop policy; the plugin does not request a screensaver or display inhibitor.
- Keeping enabled schedules armed may increase battery consumption because protection starts before their future trigger time.
- Host execution consumes the same API quota as an ordinary DSH agent session.

## Telemetry

The browser half sends one anonymous install heartbeat per UTC day to dsh-market.com: a random localStorage id plus this package's name, nothing else. The server stores only a salted hash of that id, never IP addresses, and exposes aggregate counts only. See the [upstream telemetry contract](https://github.com/zhu1090093659/dsh-web/blob/dev/docs/telemetry.md) for the full contract.
