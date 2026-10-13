# Web 开发环境连接排查

断线提示不等于 Runtime 进程退出。链路是浏览器 WebSocket → Gateway → Runtime IPC；工作区同步、会话订阅也会影响页面的恢复状态。

## 取证

先记下浏览器控制台 `Web 连接事件` 中的 `clientId`、关闭码、时间，以及 `Web 会话订阅超时` 中的 `sessionId`。Gateway 的 `websocket_open.browserClientId` 对应浏览器 `clientId`；该事件的 `clientInstanceId` 对应 Gateway 的 `runtime_request.clientInstanceId` 和 Runtime 的 `request_queued.clientInstanceId`。两端请求记录通过 `requestId` 关联。`socketId` 关联同一条浏览器 WebSocket 上的打开、关闭、心跳和订阅确认。

Linux 开发服务：

```bash
journalctl --user -u lystar-web-gateway-development.service -u lystar-web-runtime-development.service \
  --since '2026-09-26 10:45:00' --until '2026-09-26 11:00:00' --no-pager -o cat \
  | jq -R 'fromjson? | select(.component == "gateway" or .component == "runtime")'
```

按实际故障时间替换时间范围。`-o cat` 只输出进程日志正文，其他非 JSON 行会被 `fromjson?` 略过。macOS 开发后台服务的日志分别在 `~/.pi/agent/web/gateway-development.log.error`、`runtime-development.log.error`；Linux 上 Gateway 直接拉起未安装服务的 Runtime 时，Runtime 输出保存在 `~/.pi/agent/web/runtime.service.log.error`。若设置了其他 agentDir 或自定义 logPath，以服务配置为准。前台运行时，JSON 行输出在 Gateway / Runtime 的标准错误流。

## SQLite 日志

Gateway 与 Runtime 使用同一份 SQLite 日志。默认路径为 `~/.pi/agent/web/diagnostics.sqlite`；开发环境为 `diagnostics-development.sqlite`。设置 `PI_CODING_AGENT_DIR` 时，以该目录下的 `web/` 为准。进程启停、连接、HTTP、IPC、会话租约与任务状态均有事件记录。`time_ms` 是 UTC 毫秒时间戳；`pid` 是产生日志的进程，`targetPid` 可在 `fields_json` 中查看。`request_id` 关联 Gateway 与 Runtime 的 IPC 请求，`parent_request_id` 关联 HTTP 请求，`client_request_id` 和 `operation_id` 关联任务。

```bash
db="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/web/diagnostics.sqlite"
sqlite3 -readonly "$db" "SELECT datetime(time_ms/1000,'unixepoch','localtime'), component, event, pid, request_id, operation_id, error_code, error FROM events ORDER BY id DESC LIMIT 100;"
sqlite3 -readonly "$db" "SELECT command, count(*) AS requests, round(avg(queue_wait_ms),1) AS queue_ms, round(avg(process_ms),1) AS process_ms, max(duration_ms) AS slowest_ms FROM events WHERE event='request_finished' AND time_ms >= (strftime('%s','now','-7 days')*1000) GROUP BY command ORDER BY slowest_ms DESC LIMIT 20;"
sqlite3 -readonly "$db" "SELECT time, component, json_extract(fields_json,'$.maxMs') AS max_ms, json_extract(fields_json,'$.rssBytes') AS rss_bytes FROM events WHERE event='event_loop_delay' ORDER BY max_ms DESC LIMIT 20;"
sqlite3 -readonly "$db" "SELECT time, component, event, status, outcome, duration_ms, error FROM events WHERE operation_id='要排查的 operationId' ORDER BY id;"
```

SQLite 数据位于用户的 agent 目录，不随程序版本目录更替；Gateway 和 Runtime 并发写入采用 WAL。`PRAGMA user_version` 标识结构版本。旧版程序遇到更高的结构版本时不修改数据库，记录仍输出到标准错误流。日志不做自动清理。复制数据库时使用 SQLite 的 `.backup`，不要只复制 WAL 模式下的主文件。若出现 `sqlite_write_failed` 或 `sqlite_backlog`，从服务标准错误流找失败原因和未写入 SQLite 的事件。

## 判读

- `websocket_close`、`websocket_heartbeat_timeout`、`websocket_backpressure`：先排查浏览器与 Gateway 的连接；`websocket_upgrade_failed` 表示升级失败。
- `runtime_request` 的 `phase=start/end`、`outcome=timeout/disconnected`：用 `requestId` 查 Runtime 的 `request_queued`、`request_started`、`request_finished`、`request_skipped`、`request_error`。只有 queued 而没有 started，说明请求仍在队列；已有 started 而没有 finished，说明处理还未结束；`queueWaitMs` 高是排队慢，`processMs` 高是处理慢。Gateway 有 start 而 Runtime 无 queued，排查 IPC 传输和事件循环。
- `runtime_disconnected`、`runtime_connect_failed`、`runtime_reconnect_scheduled`：检查断线原因、连接耗时和重试间隔。同一 PID 持续运行只能排除进程退出，不能排除命令超时。
- `runtime_unresponsive` 且 `reachable=true`：套接字可连接，但协议响应超时，不能据此判断会话空闲。旧版自动恢复会强制停止 Runtime；本版保留进程并记录 `runtime_recovery_deferred`。
- `bootstrap_failed`、`bootstrap_retry_scheduled`：工作区同步失败；连接仍在且页面仍在线时会独立重试。`session_subscription_sent` 与浏览器的订阅确认/超时可以区分服务器未发送和客户端未接收。
- `event_loop_delay`：Runtime 记录实际采样窗口的事件循环延迟 p99、最大值、进程 CPU 时间、RSS，以及当时未完成的请求和异步阶段。Gateway 保留原有 p99、最大值与 RSS 记录。最大值达到 250 毫秒时记录，其他情况每分钟记录一次。Runtime 窗口被阻塞时可能超过 10 秒；未出现事件不能证明窗口内没有低于阈值的卡顿。
- `service_stop_requested`：通过 Web 服务管理命令发起停止时记录目标 PID、命令进程 PID 和父进程 PID。直接执行 `systemctl stop` 等外部操作不会经过该入口；须结合 systemd 日志排查，历史记录无法反推未记录的发起者。

记录包括 HTTP 路径、状态码、耗时、连接 ID、请求命令、排队和处理时长、任务状态与错误摘要；不记录请求或响应正文。服务需要载入本次代码后才会产生 SQLite 记录；旧日志无法回溯当时未记录的连接事件。`/healthz` 只检查当前连接状态，不测请求排队或会话订阅延迟。

## 会话切换与性能诊断工具

在仓库根目录运行，要求 Node.js 22.19 或更高版本。不连接模型，不停止服务，不修改 SQLite 日志。

```bash
# 默认检查过去一小时，输出摘要并保存完整报告
npm run diagnose:web -- --out /tmp/lystar-web-performance.json

# 复查已确认的慢切换窗口；时间包含北京时间时区
npm run diagnose:web -- \
  --since '2026-10-12T13:34:05+08:00' --until '2026-10-12T13:34:21+08:00' \
  --out /tmp/lystar-session-switch.json

# 开发环境、指定会话、合并页面下载的浏览器诊断记录
npm run diagnose:web -- --profile development --session '会话 UUID' \
  --browser /tmp/browser-diagnostics.json --out /tmp/lystar-web-development.json

# 指定 IPC 或 HTTP 请求，或分析独立 CPU 采样
npm run diagnose:web -- --request 'requestId' --json
npm run diagnose:web -- --cpu-profile /path/to/profile.cpuprofile.gz --out /tmp/lystar-web-cpu.json
```

入口为 `scripts/diagnose-web-performance.mjs`。`--db` 可指定数据库；`--slow-ms` 默认 1000；`--limit` 默认每类 30 条，最大 200。报告列出进程实例与版本、慢请求、排队期间的重叠候选、慢阶段、事件循环阻塞、订阅断档、截至范围终点未结束的请求、CPU 热点及时间线摘录。`--request` 会关联已有的 HTTP 父请求记录。

报告必须保留以下判断边界：

- 排队期间另一请求正在执行，只能列为重叠候选，不能单凭时间重叠认定因果。
- 异步阶段耗时不等于 CPU 时间；同步阶段的 `cpuMs` 与 CPU 采样才能补充计算证据。
- 未结束记录可能来自进程退出或日志缺失，不等于此刻仍在运行。
- 时间线与各类别均有条数上限。无记录不是“没有故障”，应核对窗口、环境、版本和日志完整性。
- 旧日志没有 CPU 采样时，工具不能恢复历史调用栈。已被清理或无法读取的采样会列为证据缺口。

### 新增证据

Runtime 用 `requestId` 关联请求内部阶段，保留 `clientInstanceId`、`sessionPath` 和 `queueLane`。`runtime_phase_started/finished` 使用 `phaseId` 配对。当前测量 `session.open`、`session.dispose`、`session.dispose.handoff`、`session.dispose.runtime`、`sessions.scan`；`session.snapshot` 仅在同步计算达到 100 毫秒或失败时记录，以免每次广播产生多余日志。广播向多个客户端发送快照时复用一次计算结果。

前端把切换开始与结束、订阅确认与结果、断档对账结果写入现有浏览器诊断下载，最多保留 500 条，包含会话 ID、本次切换序号、耗时和错误。切换会取消旧等待；订阅确认包括 CONNECTING 阶段最多等待 15 秒，超时进入可重试错误状态。

### CPU 采样与保留

Node Runtime 在服务启动后使用 V8 Inspector 每 20 毫秒采样一次，每次事件循环检查轮换窗口。只在最大延迟达到 1 秒时保存阻塞发生前的窗口，不在故障结束后才启动采样。JSON 压缩后存放在日志数据库旁的 `diagnostics-cpu/`；开发环境为 `diagnostics-development-cpu/`。每个目录保留最新 16 份本工具生成的采样，SQLite 事件不自动删除。

`cpu_profile_saved` 包含文件路径、采样窗口和样本数。诊断工具自动分析所选范围内延迟最大的最多五份采样。压缩写入使用异步操作；采样功能失败时记录 `cpu_recorder_unavailable/failed`，不影响请求处理。Bun 环境不启动这套 V8 采样器，并明确记录不可用原因；请求、阶段和事件循环日志仍然保留。采样开销和实际卡顿修复效果需要在服务载入新代码后观察，不能用静态检查或既有单元测试替代。


### 本次验证（2026-10-12）

- 只执行一次 Vitest，范围为 10 个既有测试文件。62 项用例中 56 项通过、6 项失败；另有 `composer-state.test.ts` 因临时跨包配置缺少 `@` 别名而未加载。Runtime 的 7 个文件、38 项用例全部通过，覆盖请求调度、日志存储、会话观察、多客户端、交接和运行中获取控制权。
- 前端 5 项失败及 2 个未处理拒绝指向新接入日志直接读取 `window.location`；另 1 项失败是未改动的停止提示断言仍要求字符串，而现有 toast 为对象。已修正记录器对缺少 location/document 的处理；按本次只允许一轮测试的要求，修正后没有重跑，不记为测试通过。没有新增或修改测试用例。
- 工具已读取正式日志的 13:34:05–13:34:21（北京时间）窗口，得到 27 条慢请求记录、1 次订阅断档，识别出旧会话释放耗时 10,431 毫秒、操作列表排队 9,951 毫秒。该窗口来自 `lystar.11`，不是新实现的性能结果。浏览器 JSON 合并和 CPU 采样分支未做运行验证。
- 本机临时产物：`/tmp/lystar-session-sync-tests.json`、`/tmp/lystar-session-switch-diagnosis.json`。服务未重启或发布，新代码在正式环境中的性能效果尚未验证。
