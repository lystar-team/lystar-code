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

## 判读

- `websocket_close`、`websocket_heartbeat_timeout`、`websocket_backpressure`：先排查浏览器与 Gateway 的连接；`websocket_upgrade_failed` 表示升级失败。
- `runtime_request` 的 `phase=start/end`、`outcome=timeout/disconnected`：用 `requestId` 查 Runtime 的 `request_queued`、`request_started`、`request_finished`、`request_skipped`、`request_error`。只有 queued 而没有 started，说明请求仍在队列；已有 started 而没有 finished，说明处理还未结束；`queueWaitMs` 高是排队慢，`processMs` 高是处理慢。Gateway 有 start 而 Runtime 无 queued，排查 IPC 传输和事件循环。
- `runtime_disconnected`、`runtime_connect_failed`、`runtime_reconnect_scheduled`：检查断线原因、连接耗时和重试间隔。同一 PID 持续运行只能排除进程退出，不能排除命令超时。
- `bootstrap_failed`、`bootstrap_retry_scheduled`：工作区同步失败；连接仍在且页面仍在线时会独立重试。`session_subscription_sent` 与浏览器的订阅确认/超时可以区分服务器未发送和客户端未接收。
- `event_loop_delay`：10 秒窗口的事件循环延迟 p99、最大值和 RSS；最大值达到 250 毫秒时记录，其他情况每分钟记录一次。未出现此事件不能证明窗口内没有低于阈值的卡顿。

记录只含连接 ID、请求命令、状态、耗时、错误摘要，不记录请求或响应正文。服务需要载入本次代码后才会产生这些记录；旧日志无法回溯当时未记录的连接事件。`/healthz` 只检查当前连接状态，不测请求排队或会话订阅延迟。
