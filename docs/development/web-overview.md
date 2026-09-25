# LYStar Code Web 架构总览

本文是 Web 维护者的源码导航，记录当前包职责、主要调用链和测试位置。具体行为以源码、协议和测试为准；编写与拆分要求见 [Web 编写规范](web-architecture.md)。

## 1. 请求链路

```text
浏览器：packages/web
  ├─ HTTP / JSON：/api/*
  └─ WebSocket / JSON 事件：/ws
                │
                ▼
Gateway：packages/web-gateway
  ├─ 浏览器鉴权、请求路由、客户端上下文和事件转发
  └─ RuntimeProtocolClient
                │ Web Runtime Protocol
                │ CBOR 帧，经 IPC socket 或 TCP endpoint
                ▼
Runtime：packages/web-runtime
  ├─ WebRuntimeService：处理命令、会话和运行事件
  └─ RuntimeAdapter：连接 Coding Agent 能力
                │
                ▼
packages/coding-agent
```

`packages/web-protocol` 为 Web、Gateway 和 Runtime 提供共享类型；其中的 Schema、消息校验、客户端和帧编解码定义 Gateway 与 Runtime 之间的协议。它不是浏览器与 Gateway 的 `/ws` 消息协议。

开发环境中的 Vite 将 `/api`、`/healthz` 和 `/ws` 转发到 Gateway，配置见 `packages/web/vite.config.ts`。

## 2. 包职责与入口

| 包 | 入口与主要位置 | 负责内容 |
| --- | --- | --- |
| `packages/web` | `packages/web/src/main.tsx` → `src/App.tsx`；`src/components/`、`src/state/`、`src/adapters/host-protocol/api.ts` | 浏览器页面、交互状态、HTTP 请求和 WebSocket 订阅。工作台状态以 `src/state/use-workbench.ts` 为入口，委派给会话、流事件、设置、Git、文件和项目 Actions；Room 状态由 `src/state/use-room-workspace.ts` 管理。 |
| `packages/web-gateway` | `packages/web-gateway/src/runner.ts`；`src/server.ts`；`src/runtime-client.ts` | Gateway 启动、HTTP API、静态资源、浏览器 WebSocket、请求校验与 Runtime 连接。`WebGatewayServer` 维护浏览器上下文，并把 Runtime 事件转换为 Web 事件。 |
| `packages/web-runtime` | `packages/web-runtime/src/cli-runner.ts`；`src/service.ts`；`src/runtime-adapter.ts`、`src/types.ts` | Runtime 进程入口、协议命令处理、会话运行协调，以及 Coding Agent 适配。租约、操作记录、Transcript 和 Room 已有独立模块。 |
| `packages/web-protocol` | `packages/web-protocol/src/schemas.ts`、`src/client.ts`、`src/framing.ts`；`scripts/generate-schema.mjs` | Runtime 协议消息、类型、校验、传输帧和生成的 JSON Schema。Schema 源码在 `src/schemas.ts`；`generated/web-protocol.schema.json` 由脚本生成。 |

依赖和职责的阅读顺序：前端请求与状态 → Gateway 路由和数据投影 → Web Protocol 命令/事件 → Runtime 服务与适配器 → Coding Agent。

## 3. 主要业务调用链

- **会话与任务**：`packages/web/src/state/workbench-session-actions.ts` 调用 `WebApi` → `packages/web-gateway/src/server.ts` 的 `/api/sessions/*` 路由 → Runtime 协议命令 → `WebRuntimeService.executeCommand()`。会话租约由 `lease-manager.ts` 管理；任务接收与恢复由 `operation-journal.ts` 支撑；Agent 操作经 `RuntimeAdapter` 执行。
- **实时更新与恢复**：Runtime 事件进入 `packages/web-gateway/src/server.ts` 的 `handleHostEvent()`，经过事件投影和订阅筛选后，经浏览器 `/ws` 推送。前端由 `packages/web/src/state/workbench-stream-actions.ts` 更新状态；订阅断档时会重新读取会话快照、任务和 Transcript。
- **会话记录**：前端通过 `WebApi.transcript()` 请求分页或搜索 → Gateway 会话路由 → `packages/web-runtime/src/transcript-reader.ts` 与 Transcript 投影逻辑 → 前端 Transcript 状态和展示组件。分页游标及版本信息属于这条链路的契约。
- **项目文件与 Git**：前端 `WebApi` 项目方法 → Gateway 项目路由 → Runtime Workspace 命令 → `RuntimeAdapter`。其中项目文件的路径校验和部分文件操作由 Gateway 项目路由处理；文件资源读取、保存及 Git 能力由 Runtime 命令转交适配器。
- **Room 协作**：`packages/web/src/state/use-room-workspace.ts` → Gateway 项目 Room 路由 → `packages/web-runtime/src/session-room-coordinator.ts`、`session-room-store.ts` 与 `session-room-router.ts`。消息存储、目标选择、幂等和 Agent 投递归 Runtime 管理。
- **设置和模型**：`packages/web/src/state/workbench-settings-actions.ts` → Gateway 设置或模型路由 → Runtime Workspace 命令及 `RuntimeAdapter`。Gateway 自身的访问配置由 Gateway 处理，不等同于 Runtime 会话设置。

## 4. 契约与事实源

| 边界 | 主要核对位置 |
| --- | --- |
| 浏览器 API 与 Web 事件 | `packages/web/src/adapters/host-protocol/api.ts`、`packages/web/src/types.ts`、`packages/web-gateway/src/server.ts` |
| Gateway 与 Runtime 消息 | `packages/web-protocol/src/schemas.ts`、`client.ts`、`framing.ts` |
| Runtime 对 Agent 的调用 | `packages/web-runtime/src/types.ts` 的 `RuntimeAdapter`、`runtime-adapter.ts` 的实现 |
| 生成的协议 Schema | `packages/web-protocol/scripts/generate-schema.mjs` → `packages/web-protocol/generated/web-protocol.schema.json` |

改动接口时沿调用链核对请求、响应、事件和错误处理。不要只看前端类型或某一个路由，就推断完整行为。

## 5. 测试位置

- **Web**：`packages/web/test/`。可从 `host-protocol-api.test.ts`、`session-sync.test.ts`、`transcript-state.test.ts` 和 Room 相关测试定位前端 API 与状态行为。
- **Gateway**：`packages/web-gateway/test/`。按路由与连接行为查找，例如 `git-routes.test.ts`、`room-session-visibility.test.ts`、`runtime-protocol-upgrade.test.ts` 和 `vertical-loop.test.ts`。
- **Runtime**：`packages/web-runtime/test/`。按能力查找，例如 `lease-manager.test.ts`、`operation-journal.test.ts`、`transcript-reader.test.ts` 和 `session-room-*.test.ts`。
- **Web Protocol**：`packages/web-protocol/test/protocol.test.ts`。覆盖消息编解码、协议校验和客户端行为。

改动后先运行对应包的定向测试。仓库检查入口和实际验证记录分别见 [测试与验证](verification.md) 与根目录 [AGENT_VERIFICATION.md](../../AGENT_VERIFICATION.md)；记录中的命令和结果不代表本次改动已验证。

## 6. Web 文档入口

- 本文：当前代码结构、入口、调用链和测试位置。
- [Web 编写规范](web-architecture.md)：职责边界、拆分和行为保持要求。
- [测试与验证](verification.md)：仓库验证流程。
- [项目验证记录](../../AGENT_VERIFICATION.md)：已记录的实际命令、结果和限制。
