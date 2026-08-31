# all-tasks — DSH web GUI 任务看板插件

[English](README.md) | 中文

一个可热插拔的 DeepSeek Harness (DSH) Web GUI 插件，提供 Host 权威任务账本、真实 DSH 会话执行、Host cron 调度和可选的跨平台空闲睡眠保护。插件只通过 `cordis.patch.yml` 与 profile 机制挂载，不修改 DSH 源码。

> **来源**：本仓库是 [zhu1090093659/dsh-web](https://github.com/zhu1090093659/dsh-web)
> monorepo 中 `dsh-task-board` 包（`@linxin666/dsh-client-ui-task-board`）的独立 fork，
> 以上游 `v0.3.6` tag 为基线，并扩展了任务级模型钉与推理强度选择。包名、仓库与用户可见文案改名为
> All Tasks（全部任务）；内部标识（`task-board` 设置命名空间、`/api/task-board`
> 前缀、`$DSH_HOME/task-board/` 账本目录）保持不变，因此已有 dsh-task-board 账本与
> 设置可原样沿用。许可证与上游一致，为 Apache-2.0（见 [LICENSE](LICENSE)）。

- 浏览器只是异步视图；关闭页面不会停止 Host 调度或执行结算。
- 每次运行创建独立 DSH 会话，并在发送任务 Prompt 前应用钉住的工作区、agent 预设、模型选择与权限。
- 可选电源保护允许显示器熄灭，同时阻止整机因空闲进入系统睡眠。

## 功能

- **任务看板 UI**：新会话按钮下方的侧边栏入口在宽栏显示图标和文字、在折叠 rail 显示图标；看板提供五列布局、搜索、任务详情、归档/恢复、执行历史和执行会话跳转。归档任务除恢复、删除和查看 transcript 外保持只读，恢复前不能手动或定时执行。
- **Host 权威账本**：任务、计划和执行记录存于 `$DSH_HOME/task-board/ledger-v2.json`；浏览器动作只有经 Host 确认后才成为 UI 状态。
- **有界执行历史**：每个任务只保留最近 20 条执行记录；新运行开始时截掉最旧的记录，使账本大小与每次写入成本不随任务历史无限增长。
- **真实执行**：手动运行和定时运行共用 Host runner，新建独立会话、重命名、应用 agent 预设、通过 `session.selectModel` 钉住模型选择、应用 `/permission <id>`，再以 queue 模式发送任务 Prompt。
- **钉子失败即关闭**：工作区缺失、预设缺失或损坏、模型选择被拒绝、权限命令被拒绝时，任务 Prompt 不会发送。
- **任务级模型钉**：每个任务都可以从 Host 模型目录中挑选提供商与模型钉住执行会话，并可选择推理强度（minimal/low/medium/high 或提供商自定义值）；留空则回落到部署默认模型。
- **端点模型路由器**：命名计算端点（DeepSeek Official、NAS 上的 LM Studio 等），每个端点有并发上限、token 上限、可选可用时段与 off-peak-only 开关。路由器按任务的端点优先级顺序选择第一个可用端点启动每次运行，端点缺少 token 空间或处于时段外时自动回落到下一个。所有端点都被阻塞时，运行进入排队（不创建会话、不产生费用、重启后仍等待），时段一开或并发空出就自动启动，超过可配置的等待上限（默认 24 小时）才失败。峰值/低谷时段默认采用 DeepSeek 官方 off-peak 窗口（16:30–00:30 UTC，chat 半价 / reasoner 2.5 折），支持全局与按端点覆盖。
- **任务分组**：一组共享执行策略的命名任务集合，在每个看板列内以独立横幅聚合展示。分组有执行模式——顺序（同一时刻只运行一个成员，按组内成员顺序）或并行（最多同时运行可配置的数量，留空为不限）——组内任务的任何启动（手动、定时、路由自动启动）都受此限制。分组可钉住自己的端点优先级列表（成员的自身钉优先，其次分组，最后全局默认）、可用时段窗口与 off-peak-only 开关，以及可选的分组 cron。分组 cron 启用后，组内成员继承它并忽略各自的定时；成员结算后，按顺序的下一个可运行成员自动启动。被阻塞的手动运行会显示等待原因（**等待组内插槽** / **等待允许时段** / **等待端点**），插槽或时段一空出就自动启动，与端点排队行为一致。
- **Host 调度器**：5 段 cron 支持 `*`、`*/n`、范围、逗号列表、周日 `0/7` 和标准的日期/星期 OR 语义，时间基准为 Host 本地时区。
- **确定性恢复**：已有 session id 的 running execution 在重启后继续观察；没有 session id 的启动中断会取消且不会重发。
- **实时同步**：变更返回完整 revision snapshot；SSE 只提示 revision、scheduler 与 power 变化，重连和页面恢复可见时重新拉完整 snapshot。
- **可选空闲睡眠保护**：默认关闭；开启后覆盖全部运行中的 DSH 会话、已启用且未归档的任务计划和未知会话状态。
- **系统提示词注入**：Host 通过 `SystemPrompt.section` 注册 order 200 的 `plugin:task-board` 段；任务看板设置可单独关闭声明而不关闭看板。该提示也会提醒 agent 在最终回复前收尾可见的 `todo_write` 计划列表。

## 架构与协议

- `src/index.ts` 通过官方 `@deepseek-ai/dsh-host-apiproxy` 与 `@deepseek-ai/dsh-host-webserver` SDK 挂载 Host 服务。
- `src/host-ledger.ts` 串行动作，并用临时文件加原子 rename 持久化 `{ schemaVersion: 2, revision, tasks, groups, scheduler, recentRequests }`。
- `src/host-service.ts` 负责 cron tick、错过触发跳过、runner 启动、重启对账和电源保护理由。
- `src/client/host-api.ts` 单次导入旧浏览器数据、提交幂等动作，并把 Host snapshot 当作唯一已确认 UI 状态。
- 同源接口为 `GET /api/task-board/state`、`GET /api/task-board/events` 和 `POST /api/task-board/action`。
- 所有接口都要求浏览器同源标记。直接访问只允许 DSH loopback origin；同机认证反向代理必须使用显式 Host 白名单和服务端注入 token。POST 还必须为 JSON。普通动作上限 64 KiB，导入上限 2 MiB。action 联合中没有命令、可执行路径、shell 文本或任意参数字段。

## 安装

从本仓库安装，然后重启 `dsh web`。git 托管的插件首次安装时，其构建脚本会被
pnpm 的脚本策略拦截——先运行安装，把 pnpm 打印的精确 key 加到
`$DSH_HOME/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 下，再重跑：

```sh
dsh plugin --profile web remove @linxin666/dsh-client-ui-task-board   # 仅当仍装着原版时需要
dsh plugin --profile web add github:cjcox17/all-tasks
```

本地开发安装：

```sh
git clone https://github.com/cjcox17/all-tasks.git
cd all-tasks
pnpm install
pnpm build
dsh plugin --profile web add link:$(pwd)
```

## 配置

| 键 | 默认值 | 行为 |
| --- | --- | --- |
| `enabled` | `true` | 启用 Host 服务与浏览器看板。 |
| `announceToAgent` | `false` | 按需开启：开启后向 agent 系统提示加入任务看板说明。 |
| `preventIdleSleep` | `false` | 存在运行中的 DSH 会话、已启用计划或未知会话状态时，持有一个系统空闲睡眠断言。 |
| `trustedProxyHosts` | `[]` | 仅通过已认证 loopback 反向代理路径接受的规范 `host[:port]` authority 白名单。 |
| `proxyTokenEnv` | `DSH_TASK_BOARD_PROXY_TOKEN` | 保存反向代理 token 的环境变量名；token 本身不会写入插件配置。 |
| `offPeak` | `{start: "16:30", end: "00:30", timezone: "UTC"}` | 全局峰值/低谷窗口（默认 DeepSeek 官方 off-peak 折扣时段）。 |
| `endpointMaxWaitHours` | `24` | 排队运行等待可用端点的最长时间，超时后判定失败。 |
| `defaultEndpoints` | `[]` | 未显式钉端点的任务使用的有序端点列表。 |
| `endpoints` | `[]` | 路由器用于路由任务的命名计算端点（见下）。 |

浏览器直接访问仍限制为 DSH loopback origin。若使用同机认证反向代理，应让 DSH Web 绑定 loopback，配置 `trustedProxyHosts`，在 `proxyTokenEnv` 指定的环境变量中放置高熵 token，并让代理在完成认证后替换（不能透传客户端提供的）`X-Dsh-Task-Board-Proxy-Token`。代理 Host 必须在白名单内，浏览器 `Origin` 必须与其 authority 相同。修改这些 composition 级代理设置后需重启 Host。

### 端点路由配置

端点在 `task-board` 设置命名空间下（编辑 `~/.dsh/settings.yaml`；路由器实时重载，无需重启）：

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
      provider: deepseek            # llm.models provider group id
      defaultModel: deepseek-chat
      maxConcurrency: 2
      maxTokens: 8192               # DSH maxTokens 超过该值的模型视为不可用
      offPeakOnly: false
    - id: lm-studio-nas
      name: LM Studio (NAS)
      provider: lm-studio
      models: [qwen/qwen3.8-27b]    # 为空 = 提供商的全部模型
      defaultModel: qwen/qwen3.8-27b
      maxConcurrency: 1
      allowedHours:                 # Host 本地时间；start > end 表示跨午夜
        start: "09:00"
        end: "23:00"
      offPeakOnly: true
```

任务按优先级钉端点（新建任务弹窗 / 任务详情 → 端点）；路由器使用第一个可用端点，并沿列表自动回落。所有候选都被阻塞时任务显示**等待端点**，时段一开自动启动。端点级 `offPeak` 覆盖全局窗口；任务钉的模型在所选端点可服务时使用，否则使用端点的 `defaultModel`。`max_tokens` 约束复用 DSH 设置中 Models 一节（`llm-pi-ai`）的按模型 `maxTokens` 配置，与各端点 `maxTokens` 上限比较；无需修改 DSH 本身。

macOS 后端启动 `/usr/bin/caffeinate -i -w <host-pid>`，绝不请求 `-d`。Windows 后端从 `SystemRoot` 启动绝对路径的 Windows PowerShell，固定 helper 只请求 `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`；不请求 `ES_DISPLAY_REQUIRED`，不修改电源计划，也不需要管理员权限。Linux 后端只从 `/usr/bin/systemd-inhibit` 或 `/bin/systemd-inhibit` 启动 systemd-logind `idle` block inhibitor，不请求 `sleep`、`handle-lid-switch` 或显示器/屏保 inhibitor；没有 systemd-logind 时显示 `unsupported` 或可见错误，不启动桌面环境专用替代命令。其他平台报告 `unsupported`。

## 任务分组

分组是看板级实体，在界面中创建（头部 **+ 新建分组**），持久化在 Host 账本中，并在每个看板列内以横幅聚合展示成员卡片：

- **成员关系**：一个任务最多属于一个分组；在新建任务弹窗或任务详情（分组栏）中选择。加入分组会把成员追加到组内顺序；移出即取消分组。删除分组会取消所有成员的分组（任务保留），且当任一成员存在未结算运行时会拒绝删除。
- **执行模式**：顺序模式同一时刻只运行一个成员，按组内成员顺序——成员结算后，下一个可运行成员（待规划/待办、未归档）自动启动。并行模式最多同时运行配置的 `maxParallel` 个（留空为不限）。组内任务的任何启动——手动、分组 cron、路由自动启动——都受分组的容量与窗口限制。
- **端点**：分组可钉住端点优先级列表（分组编辑器 → 端点）。成员的有效端点列表为：成员自身钉 > 分组列表 > 全局 `defaultEndpoints`。
- **窗口**：分组可把启动限制在 `allowedHours`（Host 本地时间）和/或全局 off-peak 窗口（`offPeakOnly`）。
- **定时**：分组可启用自己的 cron。启用后组内成员继承它——各自的定时被忽略（详情页会显示提示）——cron 触发序列（第一个可运行成员；随后按成员结算继续链条）。
- **等待**：被容量阻塞的手动运行显示**等待组内插槽**；被分组窗口阻塞显示**等待允许时段**；被端点阻塞显示**等待端点**。三者都在 Host 侧排队（不产生费用、重启后仍等待），插槽或时段一空出就自动启动，超过 `endpointMaxWaitHours` 才失败。

## 数据存储与迁移

- v2 账本位于 `$DSH_HOME/task-board/ledger-v2.json`。POSIX 新文件权限为 `0600`；Windows 继承用户目录 ACL。
- 损坏的 v2 文件会移动到防碰撞的 `ledger-v2.json.corrupt-*` 名称，Host 以空账本和可见 scheduler 错误启动，不覆盖损坏字节。
- 每个 origin 首次加载新版页面时，按稳定 source id 和 request id 导入 `dsh.taskBoard.v1`。任务按 id 合并，浏览器端严格较新的顶层字段优先，时间戳相同时保留 Host 字段，执行记录按 execution id 合并。
- 最近 256 个 request id 与动作的 SHA-256 指纹会随账本持久化，因此 Host 重启后的变更重试仍保持幂等，且不会复制完整动作载荷。
- 只有导入成功并经 Host 确认后，`dsh.taskBoard.v2.hostImported` 才保存当前 Host 账本 generation；新建或损坏恢复出的新 generation 会再次接收保留的 v1 数据。v1 localStorage 原值保持不变，作为只读回退备份。
- 同一时间只有一个 Host 进程能通过 `$DSH_HOME/task-board/ledger-v2.lock` 持有任务看板账本目录；第二个使用同一 DSH home 的 Host 会失败关闭，不并发写账本。

## 安全模型

- 插件仍处在 DSH Web 既有部署与网络边界内，不返回宽松 CORS 头。state、action 与 SSE 共用同一访问栅栏；裸本地命令行请求不会被当作浏览器请求接受。
- 所有变更载荷使用严格、版本化的判别联合；浏览器不能写入 scheduler 独占时间戳或 execution 结果。
- 工作区、预设、模型选择、权限、cron、任务状态和导入记录都会在 Host 再校验。
- 任务 Prompt 是发给 DSH agent 会话的数据。协议不接受 shell 命令、PowerShell 正文、可执行路径或可配置 helper 参数。
- 电源 helper 使用固定可执行路径、固定参数、`shell: false`，失败后按 1、2、5、10、30 秒有界退避。Linux helper 通过 Host stdin 生命周期退出，使 systemd inhibitor 随 Host 异常退出自动释放。

## 构建与测试

需要 Node 20 或更高版本及官方 NPM SDK 包；不使用 DSH 源码 checkout。

```sh
pnpm typecheck
pnpm test
pnpm build
```

设置 `DSH_POWER_SMOKE=1` 可在 Windows、macOS 或 Linux 上显式启用原生 helper smoke：真实启动固定 helper、等待 ready、在清理路径释放并确认进程退出，不修改系统电源计划。Linux 会先以有界超时探测 systemd-logind；没有可用 system bus 时原生部分跳过，纯逻辑测试仍可运行。

## 手工验证

1. 挂载插件并重启 `dsh web`，打开任务看板，确认 Host 时区和电源状态可见。
2. 新建并编辑任务；刷新或打开第二个同源标签页，确认两者显示同一 Host revision。
3. 执行一个钉住工作区、预设、模型（含推理强度）和权限的任务；确认出现新会话，并由该会话的 `turn/end` 历史结算任务。
4. 配置一个 `offPeakOnly: true`（或窄 `allowedHours`）的端点并钉到任务上，在时段外执行：任务显示**等待端点**，不创建会话，时段一开自动启动；同时确认执行记录里显示实际使用的端点。
5. 创建含两个待办成员的顺序分组，执行第一个成员，确认第一个结算后第二个自动启动。再加第三个成员并在第一个仍运行时执行它：显示**等待组内插槽**，结算后启动。
6. 启用一个即将到期的 cron，关闭全部浏览器页面，确认 Host 仍只创建并结算一次 execution。
7. 让 Host 停止并错过一个 cron 触发点，重启后确认该次被跳过，`nextRunAt` 从当前 Host 时间向后滚动。
8. 开启 `preventIdleSleep` 并运行长任务，让显示器自动熄灭；恢复显示后确认会话继续且 execution 已结算。
9. 关闭设置并禁用所有计划，再停止 DSH，确认 helper 退出；macOS 可用 `pmset -g assertions` 辅助确认插件没有 display-sleep assertion。
10. Linux 可用 `systemd-inhibit --list` 确认只存在 `idle`/`block` 条目；显示器仍按桌面设置关闭，手动睡眠和合盖仍由系统策略处理。

## 已知限制

- Host 停止、系统睡眠或长暂停期间错过的触发点会跳过，绝不排队补跑。
- 同一任务已在运行时会跳过到期出现并滚动到下一 cron 匹配点；任务运行不并发、不排队。
- DST 采用 Host 本地墙上时钟语义：春季跳时中不存在的分钟会跳过，秋季回拨中重复的分钟不会执行第二次。
- 电源保护只阻止空闲系统睡眠，明确允许显示器睡眠与锁屏。
- 合盖、手动睡眠、休眠、关机、低电量强制睡眠和企业电源策略不在保证范围内。
- 插件不创建唤醒定时器，也不能唤醒已经睡眠的机器。
- Linux 需要 systemd-logind 及允许当前用户取得 idle block lock 的策略；容器、WSL、无 system bus 或非 systemd 系统可能显示 `unsupported` 或 `error`。桌面环境是否把 logind idle lock 与显示器空闲联动属于其自身策略，插件不请求屏保或显示器 inhibitor。
- 已启用计划会从未来触发点之前持续持锁，因此可能增加电池消耗。
- Host 执行消耗与普通 DSH agent 会话相同的 API 额度。

## 数据遥测

浏览器半区每个 UTC 日向 dsh-market.com 发送一次匿名安装心跳：仅含一个 localStorage 随机 ID 与本包名，无其他数据。服务端只存储该 ID 的加盐哈希，不存 IP，且只暴露聚合计数。完整契约见 [上游 telemetry 契约](https://github.com/zhu1090093659/dsh-web/blob/dev/docs/telemetry.md)。
