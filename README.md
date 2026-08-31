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
- **Endpoint model-router**: named compute endpoints (DeepSeek Official, an LM Studio on the NAS, …) each with a concurrency cap, a token cap, optional allowed hours, and an off-peak-only flag. The router launches every run through the first eligible endpoint in the task's priority order (or the global default list) and automatically falls back when an endpoint lacks token space or is outside its window. A run whose endpoints are all blocked waits (queued, nothing billed, survives restarts) and auto-starts the moment a window opens or a slot frees, failing only after a configurable max-wait (24 h by default). Peak/off-peak defaults to DeepSeek's off-peak window (16:30–00:30 UTC, 50% off chat / 75% off reasoner) with global and per-endpoint overrides.
- **Task groups**: named sets of tasks with shared execution policy, shown as a group inside every kanban column under its own banner. A group has an execution mode — sequential (one member at a time, in the group's member order) or parallel (up to a configurable cap, blank = unlimited) — that gates every launch of a member (manual, cron, or router auto-start). A group may pin its own priority-ordered endpoint list (the member's own pin wins, then the group's, then the global default), an allowed-hours window plus an off-peak-only flag, and an optional group cron. When the group cron is armed, members inherit it and their own schedules are ignored; when a member settles, the next runnable member in order starts automatically. Blocked manual runs show why they wait (**waiting for a group slot** / **waiting for the allowed window** / **waiting for endpoint**) and auto-start when a slot or window frees, exactly like the endpoint queue.
- **Workspace views**: the kanban scopes to a single execution workspace (the task's `workspaceId` pin — where its session runs) while **All workspaces** keeps the general overview. A scoped view shows that workspace's pinned tasks per column, then an **Unassigned** section for tasks without a pin (they fall back to the recent workspace at run time), so nothing disappears from any view; task groups stay whole, showing the selected workspace's members plus unpinned members.
- **Model default timeouts**: the settings card edits the default model-request timeouts per provider. DSH aborts a request when no new content arrives for 300 s (the stream-idle watchdog default), which a local LLM recomputing a long message chain or generating slowly trips even while the backend keeps producing tokens. Each configured provider (custom/local `llm-pi-ai` routes plus the official DeepSeek route) shows its effective idle timeout and optional total-request bound; saving writes the provider's own DSH settings, applied live to the next request through that provider, chat and task runs alike.
- **Host scheduler**: 5-field cron supports `*`, `*/n`, ranges, comma lists, Sunday `0/7`, and standard day-of-month/day-of-week OR semantics in the Host local time zone.
- **Deterministic recovery**: a running execution with a recorded session is observed after restart; an interrupted start without a session id is cancelled and is not resent.
- **Live synchronization**: mutations return a full revisioned snapshot; SSE announces revision, scheduler, and power changes, while reconnect and page visibility recovery fetch a full snapshot.
- **Optional idle-sleep protection**: off by default; when enabled it covers every running DSH session, enabled non-archived task-board schedules, and unknown session state.
- **System-prompt injection**: the Host registers a `plugin:task-board` section (order 200) through `SystemPrompt.section`, and the task-board settings can disable the announcement without disabling the board. The guidance also reminds agents to close any visible `todo_write` plan before the final answer.

## Architecture and protocol

- `src/index.ts` mounts the Host service through the official `@deepseek-ai/dsh-host-apiproxy` and `@deepseek-ai/dsh-host-webserver` SDKs.
- `src/host-ledger.ts` serializes actions and persists `{ schemaVersion: 2, revision, tasks, groups, scheduler, recentRequests }` through a temporary file plus atomic rename.
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
| `offPeak` | `{start: "16:30", end: "00:30", timezone: "UTC"}` | Global peak/off-peak window (DeepSeek's off-peak discount hours by default). |
| `endpointMaxWaitHours` | `24` | How long a queued run may wait for an eligible endpoint before it settles failed. |
| `defaultEndpoints` | `[]` | Ordered endpoints used by tasks without explicit endpoint pins. |
| `endpoints` | `[]` | Named compute endpoints the router routes tasks through (see below). |

Direct browser access remains limited to the DSH loopback origin. For a same-host authenticated reverse proxy, bind DSH Web to loopback, set `trustedProxyHosts`, place a high-entropy token in the environment variable selected by `proxyTokenEnv`, and configure the proxy to replace (not forward from the client) `X-Dsh-Task-Board-Proxy-Token` after it authenticates the request. The proxy Host must be allowlisted, and the browser `Origin` must have that same authority. Restart the Host after changing these composition-level proxy settings.

### Endpoint routing configuration

Endpoints live under the `task-board` settings namespace (edit `~/.dsh/settings.yaml`; the router reloads them live, no restart needed):

```yaml
task-board:
  offPeak:
    start: "16:30"
    end: "00:30"
    timezone: UTC
  defaultEndpoints: [deepseek-official]
  endpoints:
    - id: deepseek-official
      name: DeepSeek Official
      provider: deepseek            # an llm.models provider group id
      defaultModel: deepseek-chat
      maxConcurrency: 2
      maxTokens: 8192               # a model whose DSH maxTokens exceeds this is ineligible
      offPeakOnly: false
    - id: lm-studio-nas
      name: LM Studio (NAS)
      provider: lm-studio
      models: [qwen/qwen3.8-27b]    # empty = all models of the provider
      defaultModel: qwen/qwen3.8-27b
      maxConcurrency: 1
      allowedHours:                 # host-local time; start > end crosses midnight
        start: "09:00"
        end: "23:00"
      offPeakOnly: true
```

A task pins endpoints in priority order (new-task modal / task detail → Endpoints); the router uses the first eligible one and falls back down the list. While every candidate is blocked the task shows **waiting for endpoint** and starts automatically when a window opens. Per-endpoint `offPeak` overrides the global window; the per-task model pin is used when the chosen endpoint serves it, otherwise the endpoint's `defaultModel` applies. `max_tokens` enforcement reuses DSH's per-model `maxTokens` config from the Models section (`llm-pi-ai`), compared against each endpoint's `maxTokens` cap; no DSH changes are required.

## Task groups

Groups are board-level entities created in the UI (header **+ New Group**), persisted in the Host ledger, and shown as a banner grouping their member cards inside every kanban column:

- **Membership**: a task belongs to at most one group; pick it in the new-task modal or the task detail (Groups section). Assigning appends the member to the group's order; removing ungroups it. Deleting a group ungroups its members (their tasks stay) and is refused while any member has an open run.
- **Execution mode**: sequential runs one member at a time, in the group's member order — when a member settles, the next runnable member (backlog/todo, not archived) starts automatically. Parallel runs up to the configured `maxParallel` at once (blank = unlimited). Every launch of a member — manual, group cron, or router auto-start — respects the group's capacity and window.
- **Endpoints**: a group may pin a priority-ordered endpoint list (group editor → Endpoints). The effective list for a member is the member's own pin, then the group's, then the global `defaultEndpoints`.
- **Window**: a group may restrict launches to `allowedHours` (host-local time) and/or to the global off-peak window (`offPeakOnly`).
- **Schedule**: a group may arm its own cron. While armed, members inherit it — their own schedules are ignored (the detail view shows a hint) — and the cron starts the sequence (first runnable member; the chain then continues as members settle).
- **Waiting**: a manual run blocked by capacity shows **waiting for a group slot**; blocked by the group window, **waiting for the allowed window**; blocked by endpoints, **waiting for endpoint**. All three queue host-side (nothing billed, survive restarts) and auto-start when a slot or window frees, failing only after `endpointMaxWaitHours`.

## Workspace views

The board header's **Workspace** select scopes the kanban to a single execution workspace (the task's `workspaceId` pin — the workspace its session runs in); **All workspaces** is the default general overview, unchanged. In a scoped view each column shows that workspace's pinned tasks first, then an **Unassigned** section for tasks without a pin (they fall back to the recent workspace at run time), so nothing disappears from any view. Task groups stay whole: a group section keeps the selected workspace's members plus its unpinned members, while members pinned to other workspaces drop out of that view. The filter also applies to the archive view and composes with the text search. It is view state only — no task, ledger, or protocol change is involved.

## Model default timeouts

DSH aborts a model request when no new content arrives for 300 seconds (the stream-idle watchdog default). A local LLM recomputing a long message chain, or one with low compute speed, can exceed that window even though the backend is still generating tokens, turning executions into continuous failures. The settings card (All Tasks → settings) lists every configurable provider — each custom/local route under `llm-pi-ai` (LM Studio, Ollama, any OpenAI-compatible gateway) plus the official `deepseek-official` route — with its current effective idle timeout and, for pi-ai providers, the optional total-request bound:

- **Idle timeout (seconds)**: abort the request when no new content block arrives for this long; default 300.
- **Total request timeout (seconds)**: overall request bound (pi-ai providers only); blank keeps the backend default.

Saving writes the provider's own DSH settings — `streamIdleTimeoutMs` and, for pi-ai routes, `timeoutMs`, e.g. `llm-pi-ai.providers.lm-studio.streamIdleTimeoutMs` in `~/.dsh/settings.yaml` — validated by DSH's provider schema and applied live to the very next request through that provider, chat and task runs alike. **Reset to default** removes the override. Timeouts are per-provider (all models on a route share them) because that is DSH's native granularity; the board only edits the same settings the Models page edits, so no Host, ledger, or protocol change is involved.

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
4. Configure an endpoint with `offPeakOnly: true` (or a narrow `allowedHours`), pin it on a task, and run it outside the window: the task shows **waiting for endpoint**, no session is created, and it auto-starts when the window opens. Also confirm the execution row shows which endpoint ran it.
5. Create a sequential group with two backlog members; run the first member and confirm the second starts automatically once the first settles. Add a third member and run it while the first is still running: it shows **waiting for a group slot** and launches after the settle.
6. Pin a task to one workspace and leave another unpinned; pick that workspace in the header **Workspace** select and confirm the column shows the pinned task plus an **Unassigned** section with the unpinned one, while tasks pinned to other workspaces disappear; switch back to **All workspaces** and confirm the general overview returns.
7. In the settings card, open **Model default timeouts**, raise the idle timeout for a local provider (e.g. `lm-studio` to 600 s) and save; confirm `~/.dsh/settings.yaml` gains `llm-pi-ai.providers.lm-studio.streamIdleTimeoutMs`, then run a task through that model and confirm a long idle gap between generated chunks no longer fails. **Reset to default** removes the override and restores 300 s.
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
