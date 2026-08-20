# Rust TUI 生产接管 HANDOFF

最后更新：2026-08-20
接手分支：`feat/rust-tui`
Git 基线：`533380eab feat(release): 打包 Rust TUI sidecar`
当前工作：Windows named pipe transport 与 required CI handshake 闸门已完成，当前提交见 `git log -1`
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

- 当前分支：`feat/rust-tui`，本轮起点为 `533380eab feat(release): 打包 Rust TUI sidecar`。
- 本轮 Windows named pipe transport 与 required CI handshake 闸门已完成并按独立任务提交；改动涉及 Host endpoint、Rust transport、Windows 编译面、跨平台 IPC 测试、CI workflow、验证文档和本 HANDOFF。
- `aaa.jsonl` 是用户文件，不读取、不修改、不暂存、不提交。
- `npm run build:offline` 新增的 16 个 `packages/coding-agent/src` 旁 `.js`、`.d.ts` 和 `.map` 已按构建前后差集删除；本轮临时 `dist/lystar-tui`、`dist/lc-native-test` 和仓库内 package artifact 也已清理。
- 当前 shell 没有全局 Bun；`npx --yes -p bun@1.3.9 bun --version` 提供固定 Bun `1.3.9`。
- `scripts/build-binaries.sh` 现在只构建当前原生 Unix 平台，并先在仓库 `dist` staging 编译 Bun executable，再复制到输出目录和执行 `lc --version`，避免 Bun 1.3.9 跨文件系统输出全零文件。
- Linux x64 候选包保留在 `/tmp/lystar-rust-sidecar-release/`。归档 SHA-256 为 `478bbb2ce7af2818d9f1dbbc9c5b9b5af4947e09cd98fde0449cbd0ad948a35f`；`lc` SHA-256 为 `431812bb2d81b30515182f8736eca2ea63d0d1d2733158b5277e3938e4ce95b2`；`lystar-tui` SHA-256 为 `054513d5da7ce28174854973773900d7fa36adc96e50bccc5d74d07ff5df4ebb`。
- Release workflow 已配置 Darwin ARM64/x64、Linux ARM64/x64 原生 runner matrix，Windows 构建也接入 Rust sidecar；这些非 Linux x64 平台尚未实际跑 workflow 或实机，不能写成已通过。
- Windows production composition 已生成唯一 `\\.\pipe\lystar-rust-tui-<pid>-<uuid>` endpoint；Rust 使用标准库双向打开 named pipe，并复用现有 GUI Protocol framing、hello 和 Runtime 主循环。
- Windows MSVC target 的 Rust TUI lib/bin Check 与 Clippy 已通过；required Windows CI 已加入真实 `serveIpcHost -> named pipe -> Rust --pipe-handshake` 测试，但本轮未推送，Windows runner 尚未产生实际结果。
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
- 本轮发行构建已自动物化相邻 sidecar；手工复制仅属于上一阶段历史证据。

### 4.6 发行包 sidecar 物化已完成 Linux x64 验证

本轮已提交的改动完成：

- 新增 `scripts/build-rust-tui-sidecar.mjs`，只允许当前原生平台构建 Rust sidecar，输出固定为 `lc` 相邻的 `lystar-tui`/`lystar-tui.exe`。
- `packages/coding-agent` 的 `build:binary`、Unix `build-binaries.sh` 和 Windows `build-windows-release.ps1` 均接入同一 helper。
- Unix 发行从 Ubuntu 单 job 交叉编译改为 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64` 四个原生 runner matrix；Windows job 固定 Rust `1.97.1`。
- Unix 和 Windows Bun 入口统一使用正式 `scripts/lystar-bun-cli.mjs`，不再让发行包绕过 Rust composition root。
- Unix bundle 会实际执行 `lc --version` 并断言 `lc`、`lystar`、sidecar、`package.json`、WASM 和内置 Skill；Windows bundle 做对应结构断言。
- Unix/Windows 安装器拒绝缺少 sidecar 的归档。归档 SHA 和 release manifest 继续保护整个包，不增加内部第二套 manifest。
- 修正 `npx bun@1.3.9` 调用和 Bun 跨文件系统输出问题；Bun 始终先在仓库文件系统 staging 编译，再复制到目标输出。
- 脚本门禁顺带修正 Workspace benchmark verifier 的三个确定文件名笔误，否则 `npm run test:scripts` 无法通过。

Linux x64 真实证据：

- 候选归档 48,994,705 bytes，SHA-256 `478bbb2ce7af2818d9f1dbbc9c5b9b5af4947e09cd98fde0449cbd0ad948a35f`。
- 归档包含 `lc`、`lystar`、`lystar-tui`、`package.json`、WASM、Skill、主题和许可证；`SHA256SUMS` 通过。
- `lc` 与 `lystar-tui` 均为 x86-64 ELF；`lc --version`、`lystar --version`、中文 `--help`、`PI_OFFLINE=1 --list-models` 通过。
- 解包后不设置 `PI_RUST_TUI_BINARY`，`PI_TUI_FRONTEND=rust` 通过 Rust trace 证明自动发现相邻 sidecar。
- 真实安装覆盖 `current/previous`、双向 rollback、篡改 staging 不切换当前版本，并确认安装目录保留可执行 sidecar。
- 安装后 PTY 覆盖 `80x8 -> 120x36` resize、`/quit`、退出码 0 和 `stty -g` 恢复。
- `npm run test:scripts` 为 `49/49`；聚焦 Vitest 6 files `80/80`；Rust Protocol `11/11`；Rust TUI `154/154`；Clippy `-D warnings`、Unix 安装器、根级 `npm run check`、`npm run build:offline` 和 `git diff --check` 均通过。

未验证：Darwin ARM64/x64、Linux ARM64、Windows x64 runner 实际构建与归档；Windows named pipe/ConPTY；`lc update` 公开升级链。

### 4.7 Windows named pipe transport 已接通编译与 CI 合同

本轮完成：

- `runEmbeddedRustTui()` 不再在 `win32` 直接 fallback；Windows 使用唯一 named pipe 名称，Unix 继续使用私有临时目录和 socket。
- Rust `ProtocolPipe` 在 Windows 使用标准库双向打开 named pipe，继续复用同一 frame decoder、hello、request 和 operation contract；Unix socket 与 fd3/fd4 兼容路径保持不变。
- 移除只因旧 Unix-only 启动门闩存在的业务 helper `#[cfg(unix)]`，使完整 Composer、Workspace、Extension、Session flow 和 exit output 进入 Windows 编译面；真正平台相关条件仅保留在 transport、Unix socket 测试和 fd3/fd4 guard。
- 跨平台 production IPC handshake 测试会在 Windows 构建真实 `lystar-tui.exe`，通过 Node `serveIpcHost()` named pipe 完成 framing 和 hello；Windows required CI 保存独立 JSON report。

本地已验证：

- `cargo check -p lystar-tui --target x86_64-pc-windows-msvc --lib --bin lystar-tui`：通过。
- Windows target Clippy `-D warnings`：通过。
- Linux production IPC handshake：`1/1`；GUI Host/Rust 聚焦 6 files：`65/65`。
- Rust Protocol：`11/11`；Rust TUI all-targets：`154/154`；Linux Clippy `-D warnings`：通过。
- `npm run test:scripts`：`49/49`；根级 `NODE_TLS_REJECT_UNAUTHORIZED=1 npm run check`、`npm run build:offline` 和 `git diff --check`：通过。

证据边界：本轮没有 Windows runner 或实机结果。named pipe ACL/owner、acquire/prompt/operation、ConPTY 输入与 resize、中文宽字符、Ctrl+C/窗口关闭、Host/child crash、安装路径带空格或非 ASCII 仍必须在 Windows 实机验证。

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

- [x] 五个平台构建链都使用对应原生 runner 构建 Rust sidecar；Linux x64 已实跑，其余平台待 workflow/实机确认。
- [x] sidecar 放进每个平台归档的固定相邻位置；Linux x64 已检查真实归档，其他平台为脚本结构证据。
- [x] compiled `lc` 解包后能自动发现相邻 sidecar；当前只证明 Linux x64。
- [x] manifest 和 `SHA256SUMS` 覆盖包含 sidecar 的归档摘要，不增加内部第二套清单。
- [x] Linux x64 Unix 安装、升级、`current/previous`、rollback 和 staging failure。
- [ ] macOS Unix 安装、升级和 rollback 实机。
- [ ] Windows 构建、安装、升级、占用中的 executable 切换和 rollback 实机。
- [ ] `lc update` 后新终端可以独立启动 Rust TUI，不依赖 GUI。

Linux package smoke 已完成，不能由该结果推断 macOS/Windows 可运行。

### P1. 补齐 Windows transport

代码入口与编译合同已完成：

- [x] Host composition 生成唯一 Windows named pipe endpoint，不再在 `win32` 直接 fallback。
- [x] Rust sidecar 使用同一 GUI Protocol framing 连接 named pipe，完整 TUI 主循环进入 Windows MSVC 编译面。
- [x] Windows required CI 加入真实 Rust `--pipe-handshake` 测试和独立 JSON report。
- [ ] 在 `windows-2025` runner 实际执行 CI，确认 named pipe 创建、Rust 连接和 hello。
- [ ] Windows 实机验证权限和 owner 边界。
- [ ] Rust 连接后的 acquire、prompt、operation 和 `/quit`。
- [ ] ConPTY 输入、中文宽字符、resize 和终端恢复。
- [ ] child crash、Host crash、Ctrl+C、窗口关闭和 pipe disconnect。
- [ ] 安装目录带空格与非 ASCII 路径。

不要新增第二套协议或 TCP fallback。当前本地 MSVC target Check/Clippy 只能证明可编译，Linux production IPC handshake 只能证明共享 framing；两者都不能替代 Windows 运行证据。

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

第一轮先核对本轮 Windows transport 提交和工作区状态，再让 Windows required CI 产生真实证据；不同时处理 OAuth、Extension 组件或默认前端：

1. 运行 `git status --short --branch` 和 `git log -3 --oneline --decorate`，确认 Windows named pipe 是独立提交，工作区只保留用户文件 `aaa.jsonl`。
2. 复查 `packages/gui-host/src/rust-tui-frontend.ts`、`crates/lystar-tui/src/terminal/transport.rs`、`packages/gui-host/test/ipc-process.test.ts` 和 `.github/workflows/ci.yml`；确认 Windows pipe 唯一、Rust 使用同一 framing，CI 保存 `ci-windows-rust-tui-ipc.json`。
3. 推送或运行 GitHub workflow 需要 Yean 明确授权。获得授权后先运行 required Windows CI，不打 tag；确认真实 `windows-2025` runner 的 IPC handshake、Windows standalone build、terminal host 和 installer 全部通过。
4. 在 Windows 实机继续扩展测试到 acquire、startup input、prompt、operation、`/quit`、child/Host crash、pipe disconnect、Ctrl+C、窗口关闭和 writer/lease 清理。
5. 使用 ConPTY 覆盖 `80x24`、`120x36`、`80x8 -> 120x36`、中文宽字符、多行 Composer、fullscreen/regular 和终端恢复；再验证空格与非 ASCII 安装路径。
6. Windows transport 运行证据收口后，再做 `lc update` 的 staging、`current/previous`、rollback 和新终端独立启动；之后才进入 macOS 实机、OAuth 或剩余 parity。

默认前端继续保持 TypeScript。没有 Windows runner/实机、macOS 实机和公开升级链证据前，不调整默认选择。
