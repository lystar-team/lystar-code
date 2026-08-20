# Rust TUI 生产接管 HANDOFF

最后更新：2026-08-20
接手分支：`feat/rust-tui`
功能基线：`614ae00 fix(agent): 修正二进制构建后的资源路径`
产品版本：`0.84.2-lystar.1`
Pi 基线：`0.84.2`

## 1. 交接目标

接下来的主线不是继续堆 Rust TUI 页面，而是把已经接通的正式启动链推进到可以由真实编译版 `lc` 承载、可以跨平台打包、可以在满足闸门后成为默认前端。

最终目标：

1. `lc` 使用现有 Coding Agent Runtime、同进程 GUI Host 和 Rust sidecar 启动完整交互模式。
2. Rust 是唯一可见终端前端；Node/Bun 继续负责 Agent、Session、Runtime、Provider、Tool、Extension 和持久化。
3. Session ownership 转移前可以回退 TypeScript TUI；转移后禁止启动第二个前端。
4. 启动文本、管道输入、图片和额外消息只通过 Host operation journal 执行，不能绕过正常 prompt 链。
5. compiled Bun、sidecar、安装器、升级和回滚经过 Linux、macOS、Windows 对应验证后，才允许调整默认前端。

桌面 GUI 的完整路线仍以 [`docs/lystar-code-gui-development-plan.md`](../lystar-code-gui-development-plan.md) 为准。本 HANDOFF 只负责 Rust TUI 生产接管主线。

## 2. 当前工作区事实

接手时先重新执行下面的命令，不要假设状态未变化：

```bash
pwd
git status --short --branch
git log -5 --oneline --decorate
node -p 'require("./packages/coding-agent/package.json").piConfig'
```

本次交接时的实际状态：

- 当前分支：`feat/rust-tui`。
- 最新功能提交：`614ae00 fix(agent): 修正二进制构建后的资源路径`；它修复 `build:binary` 复制到 `dist/package.json` 后，Node/Vitest 把资源路径错误解析为 `dist/dist` 的问题。
- 完成本 HANDOFF 提交后，工作区应只剩未跟踪的 `aaa.jsonl`。
- `aaa.jsonl` 是用户文件，不读取、不修改、不暂存、不提交。
- `npm run build:offline` 和 `build:binary` 生成的 `packages/coding-agent/src` 旁 `.js`、`.d.ts` 和 `.map` 已按本轮生成清单删除；在线模型目录刷新已恢复。
- 当前 shell 没有全局 Bun；`bun --version` 返回不可用，但 `npx --yes -p bun@1.3.9 bun --version` 可提供精确 Bun `1.3.9`。
- current HEAD 已生成 `packages/coding-agent/dist/lc`，SHA-256 为 `9c7e83bc91f562b89177aecde4a61442430ddf3948138122fa4953885f0cb46a`；该文件属于忽略的本地构建产物。
- 相邻 `packages/coding-agent/dist/lystar-tui` 只在验证时手工放置，验证后已删除；当前发行构建不会自动物化 Rust sidecar。
- 当前 Node.js：`v22.21.1`。
- 当前 Rust：`rustc 1.97.1`，Cargo `1.97.1`。
- 当前 tmux：`3.5a`。
- 默认前端仍是 TypeScript TUI，不能写成 Rust 已默认启用。

## 3. 不可破坏的架构边界

### 3.1 责任归属

Rust 只负责：

- 终端输入与 Ratatui 渲染。
- 本地 Overlay、Composer 和暂态显示状态。
- 把用户动作编码为 GUI Protocol 请求。
- 展示 Host 返回的结构化状态、transcript、operation 和 Extension UI 数据。

Rust 禁止：

- 直接读取或写入 Session JSONL。
- 直接执行 Tool、Shell 或 Provider 请求。
- 直接读取凭据、`auth.json` 或 settings 文件。
- 复制 Session、模型、Project Trust、Skill、Package 或 Extension 业务规则。
- 根据 transcript 文本猜测 Tool、operation 或 Session 状态。

Node/Bun/Core/Host 继续拥有：

- `AgentSessionRuntime` 和现有 Session writer lock。
- Provider、Tool、Skill、Package、Project Trust 和 Extension 行为。
- operation journal、lease、exactly-once 和结构化 UI 契约。
- Session 持久化、分页、恢复和 Runtime 生命周期。

### 3.2 正式组合链

当前生产组合路径为：

```text
Coding Agent main()
  -> RustTuiFrontendContext
  -> runEmbeddedRustTui()
  -> 同进程 GuiHostService
  -> Unix socket framed protocol
  -> Rust lystar-tui child
```

`runEmbeddedRustTui()` 必须采用 `main()` 已创建的 Runtime，不能重新打开 Session，也不能获取第二把 writer lock。

### 3.3 启动输入链

当前启动输入链为：

```text
main()
  -> StartupInput
  -> GuiHostService.acquire_session result
  -> Rust install_startup_input()
  -> prompt request
  -> Host operation journal
  -> Runtime
```

已固定的规则：

- Host 只在目标 Session 成功取得 lease 后返回 `startupInput`。
- request ID 为 `startup:<batchId>:<index>`。
- 第一批是初始文本和图片，后续 CLI messages 按原顺序提交。
- 纯图片输入使用空文本 prompt 携带图片。
- 前一条 operation 到达 `completed`、`failed`、`aborted` 或 `interrupted` 后才推进下一条。
- 正文和图片不能通过 argv、环境变量或直接 `runtime.prompt()` 传递。

### 3.4 fallback 边界

- Rust acquire 前失败：可以返回 `handled: false`，由现有 Runtime 继续进入 TypeScript TUI。
- Rust acquire 后失败：必须清理 lease、Host、endpoint 和终端后返回错误；禁止再启动 TypeScript TUI。
- operation 已 accepted 后同样禁止自动切换第二个前端。
- 不通过重建 Runtime、加大超时、外部 kill 测试进程或增加无依据重试掩盖故障。

## 4. 已完成并验证的能力

### 4.1 正式启动与输入

- Production composition 已采用现有 `AgentSessionRuntime`。
- Unix socket 已作为正式 Unix transport；fd3/fd4 保留测试和兼容用途。
- 文本、图片、额外消息和纯图片启动已进入 acquire-scoped `startupInput`。
- 响应丢失 E2E 已证明首条 Runtime 只执行一次，第二条等待首条终态。
- startup failure、abort、interrupt 和请求拒绝后推进下一条已有 Rust 单测。
- acquire 前 Rust 退出保留原 Runtime 和 writer lock。
- acquire 成功后 Host 在清理阶段释放 ownership。

### 4.2 Rust TUI parity

Rust TUI 已接入或完成：

- Session、Tree、Workspace、Changes、Subagent、Clipboard 和图片附件。
- CustomEditor、completion、动态 Extension command 和动态快捷键。
- Shell `!` / `!!`、Tool、Diff、重试、压缩和 operation 状态。
- `/fork`、`/clone`、`/session`、`/model`、`/thinking`、`/login`、`/logout`。
- Project Trust、Settings、Theme、Skill、Package、Instructions、Reload。
- TypeScript TUI 风格的顶部栏、正文边距、活动行、Composer 和快捷栏。
- Core `getContextUsage()` 投影的上下文比例。
- Ratatui 硬件光标；旧软件 `|` 和正文软件滚动条已移除。
- Thinking 90ms 文字扫描；`reduceMotion` 时静止且不安排动画刷新。

### 4.3 最新验证证据

以下均已在 Linux x64 实际执行：

- ownership/正式 main 聚焦 Vitest：6 files，`64/64`。
- Host-Rust startup/layout PTY E2E：`2/2`。
- Rust TUI all-targets：`154/154`。
- Rust transcript 集成：`1/1`。
- Rust benchmark 自测：`2/2`。
- Rust Protocol：`11/11`。
- Rust PTY terminal guard：fullscreen/regular × EOF/panic/SIGINT/SIGTERM，`8/8`。
- 正式 `main()` 620 轮、1240 message PTY：通过，完整输出 `needle 0..619`。
- PTY：`80x24`、`120x36`、`80x8`。
- Thinking 动态帧：通过。
- `cargo clippy -p lystar-tui --all-targets -- -D warnings`：通过。
- `NODE_TLS_REJECT_UNAUTHORIZED=1 npm run check`：通过；提交钩子再次执行也通过。
- `npm run build:offline`：通过；既有 GUI 大 chunk warning 不影响构建结果。
- GUI Protocol schema 和 Rust generated types 未改动。
- `git diff --check`：通过。

最新 PTY artifact 位于：

```text
.artifacts/rust-tui-m7/startup-input-3668287-1787216976302/
.artifacts/rust-tui-m7/e2e-1-3668287-1787216976499/
.artifacts/rust-tui-m7/e2e-2-3668287-1787216989563/
```

完整历史证据见 [`AGENT_VERIFICATION.md`](../../AGENT_VERIFICATION.md)。

### 4.4 ownership/lifecycle 已完成

提交 `4312b9c18` 完成了以下边界：

- Host 临时目录创建失败现在返回 acquire 前 `handled: false`，不会直接抛出并绕过 fallback 判断。
- server close、Host dispose 和 endpoint 目录删除会逐项执行；前一步失败不再跳过后续清理。
- 初始 Runtime 已被 adapter 取走、但 `CoreRuntimeSession.bind()` 失败时会主动 dispose，writer lock 不再泄漏。
- 受控 sidecar fixture 覆盖缺失/不可执行、spawn、hello 版本、畸形 framing、acquire 前退出、acquire 后正常/非零/signal、Host bind 失败和 accepted Shell operation 断连。
- 每条 frontend 场景核对 Runtime factory 未增加、writer lock、endpoint/socket 目录和 `handled`；Shell 重放使用 marker 证明 exactly-once。
- 正式 `main()` PTY 证明 acquire 后 sidecar 以 17 退出时，`lc` 返回 17，不打印 fallback 提示，也不启动 TypeScript TUI。
- 真实 Rust PTY guard 继续证明 fullscreen/regular 下 EOF、panic、SIGINT 和 SIGTERM 均恢复 `stty -g`。

### 4.5 compiled Bun `lc` 已完成 Linux x64 验证

本轮使用 `npx --yes -p bun@1.3.9` 提供项目固定 Bun `1.3.9`，没有修改依赖或项目版本。current HEAD 的 `build:binary` 编译 2080 个模块，产出 Linux x64 `dist/lc`，SHA-256 为 `9c7e83bc91f562b89177aecde4a61442430ddf3948138122fa4953885f0cb46a`。

已验证：

- `dist/lc --version`、中文 `--help`、`PI_OFFLINE=1 --list-models`。
- 手工相邻放置 sidecar 后自动发现；`PI_RUST_TUI_BINARY` wrapper marker 证明覆盖路径优先。
- 移走全部候选后，明确在 acquire 前打印回退 TypeScript TUI 诊断；fallback 正常 `/quit` 且恢复终端。
- 手工输入、faux 流式回复和 Session 各一次写入。
- 初始文本、真实 640x537 PNG 加文本、`@image` 无文本参数的图片输入意图、两条额外 message 的顺序和 exactly-once。
- piped stdin 进入 print mode，sidecar marker 未触发，不能写成 interactive composition 已通过。
- 620 轮 Session 在 fullscreen `80x24` 退出时完整输出 `needle 0..619`。
- fullscreen、regular、`80x24`、`120x36`、`80x8 -> 120x36` resize、`/quit` 和 `stty -g` 恢复。

边界与发现：

- CLI `@image` 无文本参数仍会由 `file-processor` 附带 `<file ...></file>` 元数据，因此这是图片输入意图，不是协议层字面空文本；协议级纯图片空文本已有既有 Host-Rust E2E，不要混写。
- `build:binary` 当前会运行在线模型生成，造成模型目录元数据漂移；本轮已恢复，不要提交该副作用。
- `build:binary` 和根构建会在 `packages/coding-agent/src` 旁生成 16 个 `.js/.d.ts/.map`，本轮已按清单删除。
- binary 构建复制的 `dist/package.json` 曾使后续 Node/Vitest 资源路径变成 `dist/dist`；提交 `614ae00` 已修复，配置 18/18、构建后配置与 Runtime adapter 38/38 通过。
- 相邻 sidecar 仅为本轮手工验证，结束后已删除。发行包仍不包含 Rust sidecar，下一阶段必须正式物化。

## 5. 下一步执行顺序

不要先切默认前端。按下面顺序完成，每一阶段单独形成提交和验证记录。

### P0. ownership 和生命周期矩阵：已完成

主要测试入口：

- `packages/gui-host/test/rust-tui-frontend.test.ts`
- `packages/gui-host/test/rust-tui-main-process.test.ts`
- `packages/gui-host/test/rust-tui-e2e.test.ts`
- `packages/gui-host/src/rust-tui-frontend.ts`
- `packages/gui-host/src/runtime-adapter.ts`
- `packages/coding-agent/src/main.ts`

完成项：

- [x] Host endpoint 创建失败。
- [x] Rust sidecar 不存在或不可执行。
- [x] Rust child spawn 失败。
- [x] Rust 在 acquire 前退出。
- [x] hello 版本、协议或 framing 拒绝。
- [x] acquire 后 Rust 正常退出。
- [x] acquire 后 Rust 非零退出或 signal 崩溃。
- [x] acquire 后 Host 请求处理失败。
- [x] SIGINT、SIGTERM 和终端 EOF/disconnect。
- [x] operation accepted 后连接断开。
- [x] Host server close、Session lease、writer lock 和 endpoint 目录清理。
- [x] fullscreen/regular 两种模式的 `stty -g` 恢复。

已验证的共同断言：

- `handled` 与 fallback 结果符合 ownership 边界。
- Runtime factory 调用次数没有增加，同一 Session 没有第二个 writer。
- 连接关闭和 Host dispose 后 lease/Runtime ownership 被释放。
- accepted Shell operation 重放与断连没有重复执行。
- Unix socket 和本轮 endpoint 临时目录已删除。
- terminal mode 已恢复。
- acquire 后故障不会启动 TypeScript TUI。

后续若修改 frontend lifecycle，必须保留这组测试；不要在生产逻辑增加测试开关或建立单实现抽象。

### P0. 构建并验证真实 compiled Bun `lc`：Linux x64 已完成

当前 shell 没有全局 Bun，本轮通过 `npx --yes -p bun@1.3.9` 提供固定版本。后续发行脚本仍必须使用 Bun `1.3.9`，不要改版本绕过。

构建入口：

```bash
npm --workspace @earendil-works/pi-coding-agent run build:binary
```

composition root：

```text
scripts/lystar-bun-cli.mjs
```

它负责注册 Bun OAuth、恢复 sandbox 环境，并把 `runEmbeddedRustTui` 注入 `main()`。不要另建第二个 CLI 入口。

Rust sidecar 当前查找顺序：

1. `PI_RUST_TUI_BINARY`。
2. compiled `lc` 相邻目录下的 `lystar-tui`/平台可执行文件。
3. 相邻 `rust-tui/` 子目录。

已完成：

- [x] `dist/lc --version`、`--help`、`PI_OFFLINE=1 --list-models`。
- [x] 相邻 sidecar 自动发现。
- [x] `PI_RUST_TUI_BINARY` 显式覆盖。
- [x] sidecar 缺失时只在 acquire 前 fallback。
- [x] 普通交互启动、发送、流式回复和 `/quit`。
- [x] 初始文本。
- [x] piped stdin 的真实语义：进入 print mode，不启动 Rust sidecar；不能写成 interactive。
- [x] 图片加文本。
- [x] 无文本参数的 `@image` 图片输入意图；仍附带 file metadata，不等于协议层字面空文本。
- [x] 多条额外 message 的顺序和 exactly-once。
- [x] 620 轮 Session。
- [x] fullscreen、regular、resize 和终端恢复。

本阶段同时修复了 binary 构建后 Node 资源路径被 `dist/package.json` 遮蔽的问题，提交为 `614ae00`。后续若修改 composition、资源布局或 sidecar 发现顺序，必须保留本阶段的 compiled PTY 证据。

`build:binary` 或 `tsgo` 可能在 `packages/coding-agent/src` 旁生成未跟踪的 `.js`、`.d.ts` 和 `.map`，并可能刷新在线模型目录。结束前用 `git status` 和 `find` 核对，只删除本轮生成且未跟踪的构建产物，并恢复本轮模型元数据漂移；不碰源码和用户文件。

### P1. 完成发行包中的 Rust sidecar

关注文件：

- `packages/coding-agent/package.json`
- `scripts/build-binaries.sh`
- `scripts/build-windows-release.ps1`
- `scripts/generate-release-metadata.mjs`
- `scripts/prepare-release-package.mjs`
- `scripts/install.sh`
- `scripts/install.ps1`
- `.github/workflows/release.yml`

需要完成：

- [ ] 五个平台都构建对应 Rust sidecar。
- [ ] sidecar 放进每个平台归档的固定位置。
- [ ] compiled `lc` 解包后能自动发现相邻 sidecar。
- [ ] manifest 和 `SHA256SUMS` 包含 sidecar 或包含它的归档摘要。
- [ ] Unix 安装、升级、`current/previous` 和 rollback。
- [ ] Windows 安装、升级、占用中的 executable 切换和 rollback。
- [ ] staging 失败不破坏当前版本。
- [ ] `lc update` 后新终端可以独立启动 Rust TUI，不依赖 GUI。

Linux 本机可先完成真实 package smoke，但不能由 Linux 构建成功推断 macOS/Windows 可运行。

### P1. 补齐 Windows transport

当前 `packages/gui-host/src/rust-tui-frontend.ts` 在 `win32` 明确返回：

```text
当前版本尚未接入 Windows named pipe
```

需要复用项目已有 Windows named pipe IPC 和同一 GUI Protocol framing，不新增第二套协议或 TCP fallback。

必须在 Windows 实机覆盖：

- [ ] named pipe 创建、权限和 owner 边界。
- [ ] Rust 连接、hello、acquire、prompt、operation 和 `/quit`。
- [ ] ConPTY 输入、中文宽字符、resize 和终端恢复。
- [ ] child crash、Host crash、Ctrl+C、窗口关闭和 pipe disconnect。
- [ ] 安装目录带空格与非 ASCII 路径。

### P1. 补齐剩余 parity 缺口

#### OAuth 等待阶段取消

当前交互式 API key/OAuth prompt 可以取消，但进入纯 OAuth 等待后，客户端没有可用的 operation ID 取消合同。

要求：

- [ ] 先定义 Host/Core 可中止的真实 operation 生命周期。
- [ ] Esc 只能在 Host 确认取消后显示已取消。
- [ ] 取消后不保存凭据、不提交模型目录候选状态。
- [ ] 连接断开和进程退出释放等待中的 UI 与 AbortController。
- [ ] 不用本地关闭 Overlay 冒充 OAuth 已取消。

#### Extension 组件能力

`packages/gui-host/src/runtime-adapter.ts` 仍明确拒绝：

- 非字符串数组的 `setWidget` 组件式小部件。
- 自定义 TUI header/footer factory。
- `ui.custom()` 自定义组件。

处理原则：

- 先对照 TypeScript TUI 真实 Extension API 和已有 B4 structured component bridge。
- 能投影为结构化状态的继续走 Host contract。
- 不能跨进程序列化的组件必须有明确 unsupported 诊断，不能执行 Extension 传来的 ANSI 或终端控制逻辑。
- 不允许 Extension 取得 terminal owner。

#### Session 生命周期和诊断

- [ ] reload、switch、fork、import 和 recovery 在 child/Host 故障下的完整组合测试。
- [ ] startup batch、client request、operation 和 ownership 转移的结构化诊断。
- [ ] 日志不得记录图片 base64、凭据或完整敏感草稿。

### P2. 跨平台和真实链路验证

仍无直接证据的范围：

- [ ] macOS Intel/Apple Silicon TTY、Kitty/iTerm2 图片路径和 sidecar。
- [ ] Windows x64 named pipe、ConPTY、安装和升级。
- [ ] Linux SSH 远端 Host 与断线重连接管。
- [ ] macOS/Windows SSH 服务托管。
- [ ] 真实外部 Provider 的发送、Tool、认证和取消。
- [ ] 五平台公开归档、installer、attestation 和 Release。

没有对应实机或真实 Provider 证据时，只能写“代码/格式/CI 构建通过”，不能写“平台运行通过”。

### P2. 默认前端切换

当前默认必须保持 TypeScript。

只有以下条件全部满足后，才讨论把默认改成 `auto` 或 Rust：

- [x] compiled Bun `lc` 真实 PTY 全链通过（Linux x64）。
- [ ] Linux、macOS、Windows sidecar 和 transport 通过。
- [x] ownership 故障矩阵通过。
- [x] startup text/image/extra messages 和 exactly-once 通过（Linux x64）。
- [ ] OAuth、Extension unsupported 边界和 Session lifecycle 有明确结果。
- [ ] 五平台 package、安装、升级和 rollback 通过。
- [x] TypeScript fallback 只发生在 ownership 转移前。
- [ ] `PI_OFFLINE=1` 不产生非必要网络请求。
- [ ] 发布 gate 和文档同步。

默认切换应是独立提交，不和 transport、包装或 parity 修复混在同一提交中。

## 6. 推荐的验证命令

先读根目录 [`AGENT_VERIFICATION.md`](../../AGENT_VERIFICATION.md)，再按改动范围运行。

### 聚焦测试

```bash
npx vitest --run \
  packages/gui-host/test/rust-tui-main-process.test.ts \
  packages/gui-host/test/rust-tui-frontend.test.ts \
  packages/gui-host/test/runtime-adapter.test.ts \
  packages/coding-agent/test/rust-tui-launch-options.test.ts \
  packages/gui-protocol/test/protocol.test.ts
```

```bash
npx vitest --run packages/gui-host/test/rust-tui-e2e.test.ts \
  -t 'submits startup text and images sequentially|drives PageUp, search, runtime append, reload, captures layouts'
```

### Rust

```bash
cargo fmt --all -- --check
cargo test -p lystar-protocol --all-targets
cargo test -p lystar-tui --all-targets
cargo clippy -p lystar-tui --all-targets -- -D warnings
```

### 根级门禁

```bash
NODE_TLS_REJECT_UNAUTHORIZED=1 npm run check
npm run build:offline
git diff --check
```

schema 有改动时：

```bash
npm run generate:schema
```

生成后必须确认：

```text
packages/gui-protocol/generated/gui-protocol.schema.json
crates/lystar-protocol/src/generated.rs
```

保持同步。未提交生成文件时，`npm run check:schema` 会因为相对 HEAD 存在预期 diff 而失败；可在生成前后比较两份文件 SHA-256，提交后再跑正式 `check:schema`。

### 真实 PTY

至少覆盖：

- `80x24`
- `120x36`
- `80x8`
- streaming 运行中和完成后
- `/settings`、Overlay、Tool/Diff 展开、resize、`/quit`
- 中文宽字符、长模型名和 multiline Composer
- fullscreen 与 regular 的 `stty -g` 恢复

测试必须使用本轮独立 tmux socket，结束时只关闭自己创建的 server。

## 7. 关键文件索引

| 责任 | 文件 |
|---|---|
| interactive composition | `packages/coding-agent/src/main.ts` |
| Rust frontend contract | `packages/coding-agent/src/rust-tui-frontend.ts` |
| Rust launch options | `packages/coding-agent/src/rust-tui-launch-options.ts` |
| compiled Bun composition root | `scripts/lystar-bun-cli.mjs` |
| package asset root | `packages/coding-agent/src/config.ts` |
| Host 内嵌 Rust 启动 | `packages/gui-host/src/rust-tui-frontend.ts` |
| Host service、lease、journal | `packages/gui-host/src/service.ts` |
| Runtime/Core adapter | `packages/gui-host/src/runtime-adapter.ts` |
| GUI Protocol schemas | `packages/gui-protocol/src/schemas.ts` |
| Rust protocol typed wrapper | `crates/lystar-protocol/src/read_only.rs` |
| Rust app state/startup queue | `crates/lystar-tui/src/app/state.rs` |
| Rust request runtime | `crates/lystar-tui/src/terminal/runtime.rs` |
| Rust session acquire handling | `crates/lystar-tui/src/terminal/responses/session.rs` |
| Rust workspace/composer | `crates/lystar-tui/src/app/composer.rs` |
| ownership tests | `packages/gui-host/test/rust-tui-frontend.test.ts` |
| production main PTY | `packages/gui-host/test/rust-tui-main-process.test.ts` |
| Host-Rust PTY E2E | `packages/gui-host/test/rust-tui-e2e.test.ts` |

## 8. 开发纪律

- 开工前先看 `git status`，保留 `aaa.jsonl`。
- 一项能力一个提交；默认切换必须独立提交。
- 不增加 `LA_*` 环境变量或第二套配置目录。
- 不改变 Session JSONL 格式、Tool 名、Provider ID、Protocol 字段和 Extension API。
- 不让 Rust 读取 Session、settings 或凭据文件。
- 不让 Extension 输出 ANSI 或控制 terminal。
- 不通过增大 timeout、无依据 retry 或外部 kill 掩盖 E2E 生命周期问题。
- 不留下源码目录旁生成的 `.js`、`.d.ts` 和 `.map`。
- 不修改上游 Pi/TUI 文件来绕过 GUI Host/Rust 责任问题，除非事实源确实在共享 Core。
- 测试、构建、实机和 Release 证据分别陈述，不能互相替代。
- 普通开发不推送、不打 tag、不发布，除非 Yean 明确授权。

## 9. 下个会话的第一轮建议

第一轮只做发行包中的 Rust sidecar 物化和 Linux x64 package smoke，不同时处理 Windows transport、OAuth、默认前端或正式发布：

1. 先读完整 `scripts/build-binaries.sh`、`scripts/prepare-release-package.mjs`、`scripts/generate-release-metadata.mjs`、`packages/coding-agent/package.json` 的 `build:binary`/`copy-binary-assets`，以及 Unix 安装器和 release workflow。
2. 明确五平台 Rust target 与归档内固定位置。优先让 sidecar 与 `lc` 相邻，直接复用 `resolveRustTuiBinary()` 已验证的查找顺序；不要增加第二套配置或运行时下载。
3. 在 Linux x64 先完成最小生产链：构建 `target/release/lystar-tui`，把它物化到候选 package，与 compiled `lc` 一起归档，解包后不设 `PI_RUST_TUI_BINARY` 即可启动 Rust TUI。
4. 为打包脚本增加结构断言：归档必须同时包含 `lc`、`lystar`、`lystar-tui`、`package.json`、主题、Skill、WASM、许可证；缺少 sidecar 时构建必须失败，不能静默发布 TypeScript-only 包。
5. 核对 `SHA256SUMS` 和 manifest 的责任边界。当前发行摘要覆盖归档文件即可证明 sidecar 被归档完整性保护，不要无必要给归档内部文件再建第二套 manifest；若现有 Windows 汇聚需要内部清单，再以同一事实源生成。
6. 用解包后的 Linux x64 候选包覆盖 `--version`、`--help`、`PI_OFFLINE=1 --list-models`、相邻 sidecar 自动发现、手工输入/流式回复、图片、`80x24`、`80x8`、`120x36`、resize、`/quit` 和 `stty -g`。
7. 运行 Unix 安装器的安装、升级、`current/previous`、rollback 和 staging failure；确认安装后的新终端不依赖源码 checkout、GUI 或 `PI_RUST_TUI_BINARY`。
8. `build:binary` 会在线刷新模型目录并生成 16 个源码旁 `.js/.d.ts/.map`；结束前恢复模型漂移、删除明确生成物，保留 `aaa.jsonl`。提交前复跑配置 18/18 与 Runtime adapter，防止 `dist/package.json` 再次触发 `dist/dist` 回归。
9. 跑相关打包测试、聚焦 Vitest、Rust 全目标、根级 `npm run check`、`npm run build:offline`、`git diff --check`，更新 `AGENT_VERIFICATION.md` 和本 HANDOFF，单独提交发行包 sidecar 物化。

Linux package smoke 完成后，再扩展 Darwin ARM64/x64、Linux ARM64 和 Windows x64 构建矩阵；Windows named pipe 仍是独立任务，不要在本阶段提前切默认前端。
