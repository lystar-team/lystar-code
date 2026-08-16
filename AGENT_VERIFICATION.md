# AGENT_VERIFICATION

最新补充：Rust TUI B4 Extension Tier0/1 在 Linux x64 使用真实 `CodingAgentRuntimeAdapter`、`runtime-contract-extension.ts`、GUI Host、fd3/fd4 FIFO 与 tmux 完成连续两轮验证。每轮从 `80x8` 启动，实际输入 Extension slash command，完成 `select`/`confirm`/`input`/`editor`、notify、status/widget/working/title、编辑器 set/paste 和 terminal listener consume/rewrite；resize 到 `80x24` 后 widget 正常投影，EOF 前清除 title 与 ImageSidecar。Bridge 的 reset/dispose 在取消 subscription 或标记 disposed 前发布空 snapshot，title schema 支持 `string|null`，Rust null 写空 `OSC 0`。恶意 fixture 的 ESC/BEL/C1/OSC 文本只以净化后的普通文本出现，artifact 没有 `ESC ] 0 ; injected`。同一真实 listener 各采集 200 个可打印输入：第一轮 p95/p99 `2ms/2ms`，第二轮 `2ms/2ms`，两轮 fallback `0`、重复应用 `0`，均满足 p95 `<=16ms`、p99 `<=33ms`；无 listener 时实际输入不发送 round-trip。详见 `docs/rust-tui-b4-extension-report.md`。本项仅覆盖 Linux x64、tmux、Unix FIFO/fd3/fd4 和 faux provider；Windows named pipe、Kitty/iTerm2 实机图片终端及真实外部 Provider 未验证。

最新补充：Rust TUI B3 最终增量已在 Linux x64 验证。`--run <session>` 兼容扩展为 `--mode auto|fullscreen|regular` 和 `--exit-output transcript|resume-hint`；`auto` 依据 `PI_TUI_MODE`、TTY、`TERM=dumb` 和 alternate-screen 能力决策。fullscreen 使用 alternate screen/mouse/cursor guard，regular 使用 raw mode、隐藏 cursor 和 Ratatui `Viewport::Inline`，不进入 alternate screen、不启 mouse，图片回退文本元数据。PTY terminal guard 覆盖 EOF、panic、SIGINT、SIGTERM 的 fullscreen/regular 共 8 项，逐项确认 `stty -g` 恢复且 regular 无 alternate/mouse escape。Host-Rust tmux/FIFO 新增连续两轮：620 条完整退出 transcript 跨页回放、3 页以上读取、cache 外最早记录、lease=0、temporary page cleanup、regular `80x8 -> 120x36` resize/overlay/scrollback 与无重复退出提示均通过。Rust B3 benchmark 扩展为 22 场景 x 3 尺寸 x 5 轮 = 330 条，新增 `regular_initial/input/overlay/scroll`，每条 regular record 通过 2 秒 idle/0 invalid frame verifier；本轮全矩阵最大 p95 `5.380481ms`，RSS p95 `28,651,520` bytes。Coding Agent Rust launch options helper 聚焦测试 `3/3` 通过；Windows named pipe、真实 Provider 和非 Linux 平台仍未实机验证。

最新补充：Rust B3 transcript 富文本与图片路径已接入 typed `render_rich_text` / `read_image_content`。Host 复用 Coding Agent Markdown、当前主题、Mermaid 和 active runtime Extension transformer，只返回 ANSI 行；Rust 解析 SGR/OSC 8 为 Ratatui spans，按可见区预取，缓存上限为富文本 `256 / 16 MiB`、图片 `16 / 32 MiB`。transcript 只投影图片 `contentRef` 元数据，Rust 按需读取；未知、失败、过期和超限图片保持 `[图片 MIME 字节数]` 占位。Rust 负责 Kitty/iTerm2/tmux sidecar，Node 不写图片转义序列。本轮实际通过：GUI Protocol `13/13`、Host content store/projection `1/1`、Rust TUI `34/34`、Host build、Host-Rust tmux/FIFO 全量 E2E `13/13`，以及 `npm run benchmark:rust-b3-workbench` 240 records verifier（最大 p95 `5.057ms`，RSS p95 `28,434,432` bytes，缓存 `400/400`）。Kitty、iTerm2、Windows named pipe 和完整 Host-Rust E2E 未在本轮重跑，不能当作已验证。

最新补充：Rust B3 Subagent 工作台与文本剪贴板在 Linux x64 完成 Host-Rust tmux/FIFO 全量 E2E 连续两轮，各 `13/13`，每轮使用独立临时 Session、FIFO、tmux socket 和 artifact。`/subagents` 覆盖 committed/live 稳定列表、详情、嵌套下钻、只读 transcript、运行中 abort 确认、已结束 continue、掉 B3 回包重试且 Host 仅执行一次；`/clipboard` 覆盖 capability、文本预览、插入输入框、预览复制、输入框写入、`Ctrl+Shift+V` 和 `Ctrl+Y`。`npm run benchmark:rust-b3-workbench` 生成 240 条（16 场景 x 3 尺寸 x 5 轮），新增 5 个 Subagent/剪贴板场景；最大 p95/p99 为 6.464ms，RSS p95 为 25.852MiB，两侧缓存固定 400 rounds，regroup 不变。`cargo test -p lystar-tui`、`cargo test -p lystar-protocol` 与 Host runtime/journal 聚焦回归均通过。本项仅完成 Linux fake adapter B3 工作台范围，不表示真实 Provider、Windows named pipe 或跨平台发行验证。详见 `docs/rust-tui-b3-workbench-report.md`。

最新补充：Rust B3 会话与项目工作台专项在 Linux x64 完成 Host-Rust tmux/FIFO 全量 E2E 连续两轮，各 `12/12`，每轮使用独立临时 Session、FIFO、tmux socket 和 artifact。会话切换覆盖 A->B 的严格 release/acquire、B 失败回取 A、双失败后自动进入带 `RecoverySession` 来源的 Sessions chooser；此时 active session 和 lease 均为空，`q` 直接退出，普通用户打开的 Sessions 仍将 `q` 用作筛选，Esc 关闭，Ctrl+C 继续走全局 abort 语义。新增 `/changes`、`/skills`、`/trust`、`/instructions`、`/packages`、`/update` 的 Ctrl+P/slash、typed B3 response、局部 generation、journaled write、expectedHash conflict 和 offline fake-IO 覆盖。退出后显式关闭 Host connection，Host `releaseClient` 清理路径、lease count 为 0 与 `stty -g` 恢复均已核验。`npm run benchmark:rust-b3-workbench` 生成 165 条（11 场景 x 3 尺寸 x 5 轮），新增六个项目工作台场景；最新最大 p95/p99 为 4.992ms，RSS p95 为 25.805MiB，缓存两侧固定 400 rounds，regroup 不变；本项只完成 Linux fake adapter B3 工作台范围，不表示真实 Provider、Windows named pipe 或跨平台发行验证。详见 `docs/rust-tui-b3-workbench-report.md`。

最新补充：Rust B3 会话与分支工作台已接入 `/sessions`、`/tree` 和 Ctrl+P。会话切换按 release old lease -> acquire target 处理，失败时重新获取原会话并恢复本地状态；只读视图使用独立 TranscriptWindow，不获取租约。`cargo test -p lystar-tui`、Host-Rust fd bridge tmux/FIFO `8/8`、`runtime-adapter.test.ts` `8/8` 及现有 10,000 Tool rounds benchmark verifier 已于 2026-08-16 本地通过。Windows named-pipe、真实 Provider、非 Linux 平台和独立 10,000 会话列表基准未验证。

最新补充：B3 Settings 已统一为 TypeScript descriptor catalog。`/settings`、GUI Host `list_settings`/`set_setting` 复用同一 id、中文文案、类型、范围、scope 和 restartRequired；主题、警告分组与数值输入只保留交互职责。该 foundation 不包含 Rust B3 UI，且不改变 B0/M10 性能阈值。

最新补充：GUI 所有 write 幂等 foundation 已完成。旧写命令与 B3 快速写统一使用 operation journal 和按 scope 串行队列；本项不表示 B3 UI 已完成。

最后核验时间：2026-08-16

环境：

```text
Node.js v22.21.1
npm 11.11.0
Bun 1.3.9
Rust 1.97.1
Cargo 1.97.1
rustup 1.27.1
Linux x64 / Debian 13
WebKitGTK 4.1、GTK 3、Ayatana AppIndicator、librsvg、OpenSSL 开发包、patchelf 已安装
```

当前交互 Shell 继承了不安全的 `NODE_TLS_REJECT_UNAUTHORIZED=0`。本轮最终静态检查和离线构建均显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1`；正式发布环境不得设置为 `0`。

## 系统现代化 M0-M6 本地最终验收

最后执行日期：2026-08-15；代码基线为 `ca6805055`，Pi `v0.84.2`，LYStar `0.84.2-lystar.1`。M1 完成 Pi 合并与 LYStar 适配；M2 完成测试分层、planner、预算和单次发布契约；M3 完成 observe taxonomy、fingerprint 与 ledger；M4 完成默认 `assist` 的 circuit、后置条件验证和内置 Tool 恢复；M5 完成 lesson 的 candidate、审批、TTL、回滚和审计；M6 完成协议与 B0 Spike。Yean 于 2026-08-15 调整 Rust 迁移判定：Rust 自有可见 TUI 继续强制迁移，M7-M11 重新开放且待实施；相对 CPU/写量只阻止 M10 默认切换，不再停止 B1-B9。

- 最终门禁按顺序执行一次：`npm run test:scripts` 为 36/36、0 skip；`npm --workspace @earendil-works/pi-tui test` 退出码 0（dot reporter 未输出聚合计数）；AI 为 108 files、922/922、0 skip；Coding Agent 为 249 files、2200/2200、0 skip；Agent Core 初次完整运行时 Linux 收集了 `nodejs-env.windows.test.ts`，结果为 23 个文件通过、438 tests passed，外加 1 个 `No test suite found` failed suite。修复后完整重跑 Agent Core 为 23 files、438/438、0 failed、0 skipped；Windows 文件改由 required Windows job 显式设置 `PI_TEST_SUITE=platform` 后单独收集。Linux 仅通过配置解析确认 platform include 目标，未执行 Windows 行为。GUI Protocol 1 file、8/8；GUI Host 9 files、31/31；GUI 3 files、11/11，均 0 skip。
- 旧 B0 Stop 数据保留为历史基线：此前在 `80x8` 混入性能 records 的同 workload hash 下，Rust RSS 为 4.36-13.41 MiB，低于 TypeScript 174.03-198.82 MiB；但 input300、stream120、scroll300 的相对 frame p95 未达旧门槛。Yean 于 2026-08-15 明确该旧 Stop 判定不再阻止 B1-B9。
- 调整后的 `npm run check:rust-spike` 通过：schema 无 diff；Rust framing/golden/public API/terminal/transcript 11 项与 benchmark page-cache 2 项通过；Node compare 7/7；`lystar-workspace` 80x8 Composer 回归 24/24；headless adapter 1/1；PTY terminal guard 在 `80x8` 覆盖 EOF、panic、SIGINT、SIGTERM 且全部恢复 `stty`；release build 与两份 B0 smoke 通过。
- `npm run benchmark:rust-spike` 完成 5 轮：TS/Rust 各 120 records（8 场景 × `80x24`、`120x36`、`200x60` × 5），每个 record 为同一 Session 的 10,000 个 Tool 调用轮次，含 Tool Call/Result、长输出、diff、错误、image/content_ref 摘要和 streaming 更新；TS/Rust workload hash 全量一致。Rust page cache 峰值为 100 或 200 个 Tool round，未超过 400。`80x8` 未进入性能 records，只做布局、Composer 底部和退出恢复兼容测试。结果为 `developmentDecision: go`、`releaseDecision: stop`；绝对预算、协议和功能前提满足，M10 默认切换仍受 input/stream 相对 frame/write 与三个性能尺寸 CPU 门槛阻止。`npm run benchmark:rust-spike:verify -- --exit-code 0` 输出相同决策并通过。
- `bash scripts/test-install-sh.sh` 通过。`NODE_TLS_REJECT_UNAUTHORIZED=1 npm run check` 通过 1200 files，`NODE_TLS_REJECT_UNAUTHORIZED=1 npm run build:offline` 通过；GUI bundle 仍有既有大 chunk warning，不是失败。
- CLI 发行 smoke 执行 `bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data`。本机 Bash 构建按设计只生成 Darwin ARM64/x64、Linux ARM64/x64 四个 Unix 中间归档，`sha256sum -c SHA256SUMS` 四项通过；中间 manifest 为 `0.84.2-lystar.1`、Pi `0.84.2`、仓库 `lystar-team/lystar-code`，仅含四个 Unix assets。Windows x64 由 Windows runner 的 `build-windows-release.ps1` 生成，五平台 metadata 只会在 Release 汇聚后生成。当前 Linux x64 解包后的 `lc --version`、`lystar --version`、`lc --help`、`PI_OFFLINE=1 lc --list-models` 均通过；其他 OS 未实机。
- 最终 PTY 使用独立 tmux socket。`80x24` 启动和 `/quit` 正常，`80x8` 保留 Composer 与快捷栏并正常退出；同一 tmux PTY 的 `stty -g` 前后完全一致，应用退出码为 0。未调用 Provider，socket 和隔离配置目录已关闭或删除。
- 远端未验证：planner 10/20 observe、Actions history artifact、受保护 environment 审批、最近 live/stress/benchmark、Windows/macOS/Linux ARM64 实机、五平台 release、Tag、签名、attestation 与公开 Release。历史 `0.84.1` 和 GUI 发布记录保留在下文，不用来证明本轮 `0.84.2-lystar.1`。

## M7 Rust 只读工作台本地验收

2026-08-16，M7 仅在 Linux 完成本地验收：Host 的 `read_transcript`/`search_transcript` cursor 绑定 generation 与 revision，append 后旧搜索 cursor 为 `cursor_stale`；JSONL 读取分块并限制单行 4 MiB，索引不缓存 raw payload。Rust TUI 只消费 `lystar-protocol` 的 typed read-only projection；older page 严格匹配 generation/revision，progress preview 为 8 KiB，OSC 8 写入实际 label 区域，decoder 在扩容前拒绝超长 frame。GUI Protocol `9/9`、GUI Host `13/13`、Rust workspace、release PTY guard、clippy 和两次 fd bridge E2E 均通过；RSS artifact 每轮记录 PID、进程树、样本数和 10ms 间隔，并按 5 轮计算 p95。`npm run check:rust-spike` 已在 M7 提交后的干净 schema 基线上通过。Windows named-pipe transport、M8 交互功能和 M10 默认切换未验证。

## M8 Rust Composer 与运行状态本地验收

2026-08-16，M8 在 Linux x64 完成本地硬验收。Protocol 增加 `steer`、`follow_up`、`clear_queue`、受限 `SessionProgress`，Session snapshot 增加活动与 follow-up 队列状态。Host 只在 `CoreRuntimeSession` 调用公开 `AgentSession.steer()`、`followUp()` 和 `clearQueue()`；未知运行时事件收敛为最长 1024 字节的状态，不透传原始事件。Rust Server wire 改为受限 envelope 校验和只读投影解析，修复 Typify 顶层 event 联合体拒绝合法 `session_progress.status` 并退出的问题；新增 TypeScript status golden frame。队列命令经过 operation journal，在响应写出后执行，按 client request ID 和 payload hash 幂等。

Rust Composer 固定在底部，支持 UTF-8 grapheme、多行、粘贴、历史草稿恢复和受限 undo/redo；Enter 按当前状态发送 `prompt` 或 `steer`，Alt+Enter 发送 `follow_up`，Esc/Ctrl+C 中止活动 operation。Rust 工作台 Overlay 基础现已提供 stack、List/Detail/TextEditor/Confirm、焦点恢复、toast/error、pending request generation 与 stale response 丢弃；命令面板只真实接入 `/help`、`/about`、`/doctor`，后两者经 typed B3 `get_about`、`get_diagnostics` 校验，未接入的 `/settings` 等 slash 仍按普通 prompt 发送。Host `ui_request` 的 select/confirm/input 通过 `ui_response` 桥接，未知 kind 返回 cancelled。Host response-drop/reacquire E2E 覆盖首次 prompt accepted 回包 reject/断连、相同 `clientInstanceId` 新连接 hello/acquire、相同请求重发、并发同请求、payload 冲突、active steer/follow_up/clear_queue 掉回包重试及 idle 边界；Runtime 各操作恰好一次，journal 均 `completed`。正式 `AppState`/`EditorState`/`TranscriptView` M8 benchmark 共 45 条 JSONL（`80x24`、`120x36`、`200x60`，input300/paste5000/palette_open，各 5 轮），缓存固定 `400/800/63,191 bytes`、regroup 不变；本轮实测 input p95 3.548-5.298 ms，paste p95 4.843-5.771 ms，palette open-to-frame p95 3.526-4.472 ms，RSS p95 22.902-22.910 MiB，均通过 M8 预算。真实 tmux 80x8 用 10 行按键输入覆盖 Composer 边框、光标、错误 Tool 行和快捷栏，三尺寸 resize 往返及 `stty` 恢复通过。本轮增量验证：GUI Protocol `13/13`、Rust protocol `11/11`、Rust TUI `19/19`、Host-Rust fd bridge tmux/FIFO `6/6`（完整 Overlay 流重复两次）和 benchmark verifier 均通过；`npm run check:schema`、`npm run check:rust-spike` 已执行 schema 生成，但因本提交的 generated schema/`generated.rs` 尚未提交，脚本内置 `git diff --exit-code` 按预期退出 1，不能作为功能失败。Windows named-pipe 与真实 Provider 未验证；详见 `docs/rust-tui-m8-report.md`。

2026-08-16 最新补充：认证 bridge 已扩展为真实 fake-auth 链路。Rust select option 依次使用 `value`、`id`、字符串，显示 `label`/`description`；`editor` 使用既有文本编辑器；`notify` 展示受限 auth URL、设备码或进度且不建立 pending UI request，设备码经 Host `write_clipboard_text` 复制。Host-Rust fd bridge tmux/FIFO 全量为 `8/8`：`select(id) -> input -> secret -> notify -> confirm -> completed`、登录/登出各一次、掉登录 B3 响应后重试不重复调用 Host、密文不进入 Rust trace/artifact 均已验证。`npm run benchmark:rust-m8` 和 verifier 均为 45 records（三尺寸、三场景、每组五轮）；input/paste/palette 最大 p95 分别为 3.516ms、4.884ms、4.653ms，RSS p95 最大 22.965MiB。10,000 Tool rounds 的 older-page 独立实测连续三次，每次五轮、每轮五个样本：三次各 25 样本的 end-to-frame p95 为 30ms，decode+apply+draw p95 为 10ms，RSS p95 为 16.285MiB。2 秒空闲 smoke 记录 124 次 16ms 等待、0 帧、进程树 CPU 10ms。Windows named-pipe、真实 Provider 和非 Linux 平台仍未实机验证。

## 协议互操作与 journal durability 本地验收

2026-08-16，Linux x64 上新增共享 semantic JSON 的 TS/Rust 双向 frame 矩阵：双方独立以 CBOR 编码 17 个 B3 command request、17 个 B3 successful response、9 种 `SessionProgress`、8 类 `ServerEvent` 与 optional missing/null/value，并对完整 message JSON 语义比较；Rust 对 TS B3 response 调用 `decode_b3_result`，TS 对 Rust B3 response 按 command result schema 校验。client/server hello 的 0/2、缺字段、unknown field，以及 CBOR `NaN`/正负 Infinity 均有负向回归。`OperationJournal.compact()` 在 rename 后 fsync 父目录，Windows 跳过目录 fsync；rename 或目录 fsync 失败均清理 temp，journal 可重开。此项只证明 B3 的 wire/schema 互操作，不表示 B3 runtime command 已完整实现或对外完成。

## 最新 GUI 实现与运行验证

2026-08-15 已完成 `gui.5` 五平台公开 Beta 发布验证，并完成未发布的 `0.84.1-lystar-gui.6` P0 修复候选验证；发布事实与候选源码不得混写。

- `0.84.1-lystar-gui.6` 候选修复了同一故障链：Tauri 后台连接上限为 4，远端 Debian 同一 SSH 会话实际残留 4 个 `lystar-gui-host connect --stdio`；设置页重复打开和切页会并发创建临时 Host，引用被后来的连接覆盖后无法关闭，同时 Host 请求没有 deadline，项目恢复可永久停在“正在打开项目”。Protocol Client 现在支持请求超时并清理 pending timer；项目打开同一目标合并、不同目标互斥；设置 Host 按 Host/页面合并加载、复用已连接 Client、过期候选必关闭，AGENTS、模型、Skill、诊断按当前页加载。本机 Host 和系统 SSH 都改用标准 `std::process::Child` 管理，关闭时先断开 stdin，最多等待 500ms 后 kill/wait；应用退出同步回收连接，避免回收线程随主进程一起消失。该候选尚未打 tag、未创建 Release，不能覆盖已发布的 `gui.5`。
- `gui.6` 真实浏览器恢复当前项目后不再停留在“正在打开项目”；本机 `~/.pi/agent/AGENTS.md` 和项目根 `AGENTS.md` 均显示真实路径和内容。`800×600`、`1280×800`、`2816×1640` 的文档横纵溢出均为 0，固定 30px 拖拽条位于第一行，Logo 和顶栏从 `y=30` 的第二行开始。Linux Tauri 在 Project Trust 遮罩打开时通过真实 X11 分段拖动，窗口从 `(96,107)` 移到 `(192,191)`；`Alt+F4` 后 `exit=0`、应用 stderr 为 0、Session lock 为 0、残留 Host 为 0。Protocol 7/7、GUI 11/11、Host 30/30、GUI 类型检查、`cargo check`、production build、发布签名契约测试和 `git diff --check` 已通过。
- GUI Release 仅由受保护的 `workflow_dispatch` 发起：从所选 ref 的 `packages/gui/package.json` 读取版本，先等待同 SHA 的 `main` CI，发现既有 `gui-v<version>` Tag 或 Release 则在矩阵前退出。同 SHA 通过并发组串行，Remote Host 与五平台矩阵只执行一次；全部 artifact、SHA256SUMS、manifest、macOS ad-hoc 签名/架构与 provenance 通过后，`gui-release` environment 批准的 publish job 才创建 annotated Tag 和 prerelease。Rust cache 仅复用 registry/git 与中间 release 依赖，key 包含 OS、架构、Rust 版本和 `Cargo.lock`，不恢复 DMG、NSIS、AppImage 或最终二进制。CLI Release 继续等待同 SHA main CI、不重跑全量测试，并在构建/发布 summary 输出矩阵次数、平台 artifact 字节数、wall/build/cache 指标。本轮只完成本地 workflow YAML、checker mutation、metadata fixture、根级静态检查和离线构建；尚未获得 GitHub environment approval、同 SHA 串行、五平台构建、真实签名、attestation、Tag 或 Release 的远端证据。

- `0.84.1-lystar-gui.5` 已统一写入 GUI、GUI Host、GUI Protocol、Tauri 和 Cargo 版本事实源，并由 tag `gui-v0.84.1-lystar-gui.5` 公开发布。macOS workflow 已删除与 `APPLE_SIGNING_IDENTITY=-` 冲突的 `tauri build --no-sign`，App 改为 ad-hoc code signature；Darwin ARM64/x64 GUI Host 分别在对应 macOS runner 原生编译并 ad-hoc 签名，再与 Linux/Windows Host 汇总给五个平台安装包。预检 run `31856665307` 和正式发布 run `31859444631` 均完成五平台构建；正式 run 的两个 macOS job 均挂载最终 DMG，App、local Host 和两种 Darwin Remote Host 通过 `codesign --verify --deep/--strict`、`Signature=adhoc` 和 `lipo -archs` 校验。manifest 保留整体 `signed:false` 兼容字段，同时新增逐平台 `signing`，明确 macOS 为 `adhoc/notarized:false`、Linux/Windows 为 `none`。干净 Mac 的浏览器 quarantine 和“仍要打开”流程仍未实机验证，不能将 ad-hoc 签名写成 Developer ID 或 notarization 放行。
- 新增 `npm run check:gui-release` 和 `scripts/gui-release-signing.test.mjs`，会阻止 macOS build 重新出现 `--no-sign`，并验证 Host payload 头部提取。Linux 本机使用 `PI_GUI_REMOTE_HOST_PLATFORMS=linux-x64 npm --workspace @lystar/code-gui run prepare:tauri` 完成 production build、Bun Host framed Protocol smoke 和资源物化，最终 `remote-hosts` 只包含 `linux-x64/lystar-gui-host.bin`，大小 `114,270,640` 字节。GUI Protocol `6/6`、GUI Host `30/30`、GUI `9/9`、根脚本 `9/9` 和 GUI metadata 回归通过；`cargo check`、最终 `NODE_TLS_REJECT_UNAUTHORIZED=1 npm run check` 与 `NODE_TLS_REJECT_UNAUTHORIZED=1 npm run build:offline` 通过。当前 Linux 环境不能独立执行 `codesign` 或挂载 macOS DMG；正式 runner 已提供签名和架构证据，但 Linux 也不能制造 Safari/Chrome quarantine，因此干净 Mac 的“仍要打开”流程及无需 `xattr` 启动仍未验证。

- 最新源码通过 `npm --workspace @lystar/code-gui run check`、`npm run check:gui-boundaries`、`git diff --check`、`cargo check --manifest-path packages/gui/src-tauri/Cargo.toml`、GUI/Host/Protocol production build，以及根级 `NODE_TLS_REJECT_UNAUTHORIZED=1 npm run check` 和 `NODE_TLS_REJECT_UNAUTHORIZED=1 npm run build:offline`。GUI production bundle 为 `1,452.63 kB`，gzip `447.49 kB`，CSS 为 `64.16 kB`，gzip `11.60 kB`，仅保留既有大 chunk warning。
- 最新聚焦回归为 GUI Protocol 1 个文件 7/7、GUI 3 个文件 11/11、GUI Host 9 个文件 30/30。除候选 Host 的 `list_sessions` 失败和 `desktop-state.json` 持久化失败事务回归外，新增设置 Host 回归确认同 Host 并发只创建一条连接、Host/项目 AGENTS 同次提交可见、跨 Host 过期候选会主动关闭。
- 项目打开改为完整两阶段事务：候选 Host、Session、writer lease、transcript 尾页和桌面状态全部成功后才提交新工作区；`lastProjectId` 只记录最近成功项目。旧 lease 在新工作区提交后释放，释放失败只显示可重试错误，不回滚已经成功的新工作区。Skill、AGENTS、Git、模型和诊断继续作为提交后的辅助加载，不阻塞项目切换。
- GUI/TUI 单 writer 真实链路通过：TUI 创建 703 字节 JSONL 并持有 `.lock` 时，GUI 在 500ms 投影周期内显示“TUI 使用中”、Bash transcript 和只读 Composer；TUI `/quit` 后 GUI 自动取得写权限。Core 由最后提交的 assistant、Bash、user 或 Tool 消息推导 `completed`、`failed`、`aborted`、`interrupted`，Host 在没有 GUI operation journal 状态时使用该结果，最终 Session 显示“已完成”。
- GUI Host 的成功响应统一经过 `jsonValue()` 规范化，移除 `undefined` 后再按严格 `JsonValueSchema` 编码；修复了 `list_sessions` 响应中 `name: undefined` 导致 sidecar 报 `GuiProtocolValidationError: Invalid GUI server message` 并退出的问题。Protocol 诊断仅包含消息类型、schema 路径和规则，不记录字段值、transcript、图片或凭据。
- “设置-个性化”已成为 Host/项目指令入口。设置页使用独立临时 Host Client，切换本机或 SSH Host 不改变当前聊天连接、Session 或 writer lease；真实 Host 下保存项目根 `AGENTS.md` 成功，外部改写后旧 SHA-256 内容哈希保存被拒绝。写入使用 UTF-8、临时文件、rename 和目录 `fsync`，只允许 Host 或项目范围内的 `AGENTS.override.md`、`AGENTS.md`。
- 输入图片、历史用户图片和 Tool `read` 图片已通过真实 Host 转换为 Session 绑定 `contentRef`，GUI 按需读取缩略图和原图；图片查看器缩放、关闭及 object URL 释放有效。Markdown、Tool 路径、裸路径和 Git Diff 行号统一经过 Host canonicalize、存在性、文件类型和项目边界检查；显式 HTTP/HTTPS/mailto 使用系统 opener，相对路径不会被浏览器 `localhost` 基址误判为外链。
- Composer 的 `@`、`$`、`/` 补全已接真实 Host/Runtime。大仓库中 `@packages/gui/src/App` 返回 `packages/gui/src/App.tsx`，Tab 插入 `@packages/gui/src/App.tsx `；`$add` 返回真实 `add-llm-provider` Skill；带引号空格路径和目录前缀缩小扫描根均已验证。`/` 只合并 Runtime 命令与真实 GUI handler：`/new`、`/settings`、`/models`、`/changes`。
- Git Inspector 的宽度和上下分区比例支持鼠标、键盘、双击/按钮恢复并即时持久化。真实仓库中宽度从 480 拖至 604 px，分区比例从 0.34 调至 `0.45492097701149425`，恢复默认回到 `480/0.34`；Diff 行号 `1937` 能打开并定位 `packages/coding-agent/src/core/session-manager.ts`。`800×600` 使用全工作区覆盖并隐藏无意义的宽度拖拽条。
- Playwright 在真实项目、Session、Tool 和 Host 数据下重新完成 `2816×1640`、`1280×800`、`800×600` 的浅色和深色验收；最新截图使用 `/tmp/lystar-gui-16-main-{2816,1280,800}-{light,dark}.png`，并覆盖 `800×600` 设置页、SSH alias/直接连接密码表单、Host key 指纹确认、远端目录正常/隐藏目录/错误态、项目外资源、项目打开失败恢复、模型菜单和 Composer 内容菜单。页面文档级横纵溢出均为 0；直接连接密码表单限制在 `16..584px` 视口范围，表单内部滚动后底部操作可达；Toast 与模型菜单保持 7px 间距且低于 Composer、侧栏、设置和弹窗层级。
- 图片粘贴与拖放使用真实 `ClipboardEvent`/`DragEvent` 和 `DataTransfer` 验证，分别生成 `clipboard.png`、`dropped.png` 附件；侧栏收起后 grid 为 `56px 1224px`，重载后仍保持收起，证明 `desktop-state.json` 持久化有效。Compact 专用摘要在长 Session 中可折叠/展开，展开前后 `scrollTop=2328` 保持不变，虚拟列表重新测量高度。
- Linux 原生 Tauri 使用全新 Rust debug build、安装包内 Host 资源、隔离 `PI_CODING_AGENT_DIR`/`XDG_CONFIG_HOME` 和 X11/WebKitGTK 复跑。标准 `WM_PROTOCOLS/WM_DELETE_WINDOW` 正常关闭前运行中 Session lock 为 1，关闭后退出码为 0、lock 为 0、Tauri 子 Host 为 0；完整 stderr 为 119 字节，仅包含无完整桌面总线的 Xvfb `Can't connect to a11y bus` 环境警告，没有应用错误。原生窗口截图为 `/tmp/lystar-gui-16-native3-session.png`。`@`/`$`/`/` 补全已通过真实浏览器，但隔离 Xvfb 的合成键盘事件无法进入 WebKit textarea，因此不宣称本轮原生键盘验收通过。
- SSH 设置已覆盖 SSH Config/直接连接、用户、端口、ssh-agent、私钥、密码、系统凭据库和远端系统选择；未知 Host key 展示 SHA-256 指纹并要求显式确认。远端目录浏览器的面包屑、Home、上级目录、隐藏目录、错误重试和当前目录选择已用可控 Host 状态完成浏览器验收；真实 OpenSSH、密码/私钥认证、远端 Host 安装和断线恢复仍需要可登录的 SSH 目标，不以可控状态截图代替实机结论。
- 本轮原生退出首次暴露 transport 生命周期缺陷：Tauri `RunEvent::Exit` 和 `close_gui_host` 直接 `kill()` 本机 Host 子进程，Host 来不及 `dispose()`，正常标题栏关闭后会留下空的 proper-lockfile 目录；只丢弃 Tauri shell connection 又无法等待子进程确定退出。`gui.6` 删除该单用途 shell plugin，本机 Host 与 SSH 统一持有标准 Child：EOF 后短等待，超时再 kill/wait，应用退出在当前关闭路径内同步完成。隔离复测确认应用 stderr 为 0 字节、lock 为 0、GUI/Host/Xvfb 残留进程为 0。
- Linux AppImage 打包首次暴露 Tauri `patchelf` 会改写 Bun 编译的 Host ELF，改写后的 Host 在 `ldd` 和直接执行时段错误。当前构建把本机与五平台远端 Host 包装为带 `LYSTAR-GUI-BINARY/1` 头的不可执行资源，Rust 在本机启动或 SSH 安装前校验头并原子还原原始二进制；AppImage 不再把 Host 当作 ELF 处理。gui.2 本机候选 Linux x64 AppImage 大小为 `270,002,680` 字节，SHA-256 为 `6d10d611e2bdabf19229a24e4fbcb5e61af89a954f32510b98feead98c5f9f67`。
- gui.2 本机候选 AppImage 已在隔离 XDG、`PI_CODING_AGENT_DIR`、Xvfb、Cinnamon 和 WebKitGTK 下启动。运行时 Host 还原到应用本地数据目录，权限为 `755`、大小 `114,262,566` 字节，SHA-256 与原始 Bun ELF 完全一致；通过 `windowfocus + Alt+F4` 正常关闭后退出码为 `0`、应用 stderr 为 0 字节，Host 进程和 Session lock 均为 0。
- `gui-v0.84.1-lystar-gui.1` workflow run `31787992387` 没有创建 Release：Linux x64、macOS ARM64/x64 构建成功；Windows x64 因 Node 22 直接 `spawnSync("npm.cmd")` 返回 `EINVAL`，Linux ARM64 因 runner 缺少 `/usr/bin/xdg-open` 失败。gui.2 通过 main CI run `31790068109`；Release run `31790342771` 中 Linux x64/ARM64、macOS ARM64/x64 成功，Windows 在重复提取本机 target 时失败。gui.3 通过 main CI run `31791870560`；Release run `31792226547` 中同四个平台成功，Windows 本机 Host 已成功编译，但随后交叉提取 Darwin ARM64 Bun runtime 失败。gui.1/gui.2/gui.3 tag 均保留且不移动，三个 run 均未创建 Release。gui.4 在 Linux x64 独立生成并校验五平台 Remote Host 载荷，原生矩阵只编译本机 Host 并复用同一 artifact；本机验证了五个平台载荷复制前后 SHA-256 一致和坏头拒绝。main CI run `31793847798` 与 GUI Release run `31794203478` 全部成功，包括 `prepare-remote-hosts`、五个平台原生构建、Windows x64 NSIS、metadata、provenance 和 prerelease 发布。
- 公开 Beta `gui-v0.84.1-lystar-gui.4` 于 `2026-08-14T11:15:27Z` 发布，Release 为非草稿预发布，中文说明明确未签名、无自动更新和跨平台实机边界，共 7 个资产。五个平台安装包分别为：Linux x64 `243,476,984` 字节 / `b834a724f5bb0d9ad64f960769773fb26b377f2e61bd77915af1bc2b8e99a4d5`，Linux ARM64 `278,399,496` / `691e6ca48401a6afd4b3676f68cc0afefd66d89832999998f9d12ab082de8900`，macOS ARM64 `209,298,598` / `3cfffccecbe19452c3cde7c872e4fb8baa09ec06bfb538a94d68d2b6132011fd`，macOS x64 `211,539,102` / `e9426b4c052349b127f6cd8351fd72994867ea0a85c4a06baa6d3a62ee599e41`，Windows x64 `152,525,821` / `1dc1c4e4a44289594adb214c12c5a245c64acb36a3e7dd5e92bb319f790d7032`。公开下载后的 `SHA256SUMS` 五项全部通过，manifest 的版本、仓库、`channel: beta`、`signed: false`、文件大小和 SHA 与实际资产一致；Linux x64 digest 的 GitHub Attestations API 返回 1 条 Sigstore provenance。Release：<https://github.com/lystar-team/lystar-code/releases/tag/gui-v0.84.1-lystar-gui.4>。
- 公开下载的 gui.4 Linux x64 AppImage 已在隔离 HOME/XDG、`PI_CODING_AGENT_DIR`、Xvfb、Cinnamon 和 WebKitGTK 下完成真实窗口 smoke。`Alt+F4` 后退出码为 `0`、应用 stderr 为 0 字节；还原 Host 权限为 `755`、大小 `114,262,560` 字节、SHA-256 为 `a7dcc51c87d1c4d4ed0734adb617b7f2890baa9a1cbe861faf40126e7cd6ac22`、文件头为 ELF，Session lock 和 Host 残留进程均为 0。GitHub `/releases/latest/` 仍指向 CLI `v0.84.1-lystar.13`，GUI prerelease 没有抢占 Latest。
- 公开 Beta `gui-v0.84.1-lystar-gui.5` 于 `2026-08-15T02:46:38Z` 发布，tag 和 Release workflow `31859444631` 均指向 `0d805f26f762ab8ebe02e58462e7702d8caff1f7`；Release 为非草稿预发布，共 7 个资产，CLI Latest 仍为 `v0.84.1-lystar.13`。五个平台正式安装包分别为：Linux x64 `243,988,984` 字节 / `09c04455e07a9e61147c82d20eb387542eaef34654fbd2b11ce86846d6296a56`，Linux ARM64 `278,923,784` / `cdc746c9e9eae5a241a2332c7cb296e187af7d4bd11022806bdace4db40ce287`，macOS ARM64 `209,458,430` / `447f9b451d7307c3ce5175349b18abd3fcf072752d366e27386d60cf068b95e0`，macOS x64 `211,924,525` / `ce0020564e2c99cc1eb93a82adc52901a3bb9fdd61de0198d5408652ab8716a0`，Windows x64 `152,644,747` / `fde674830778657faf8844beb9b4ad55afa805eb689fb084fdb9d072c48ee046`。公开 manifest、Release API 和 `SHA256SUMS` 的文件名、大小和摘要逐项一致；macOS ARM64 DMG 与 manifest digest 的 GitHub Attestations API 均返回 1 条 provenance。Release：<https://github.com/lystar-team/lystar-code/releases/tag/gui-v0.84.1-lystar-gui.5>。
- 公开下载的 gui.5 Linux x64 AppImage 已在隔离 HOME/XDG、`PI_CODING_AGENT_DIR`、Xvfb、Cinnamon 和 WebKitGTK 下完成真实窗口 smoke。`Alt+F4` 后退出码为 `0`、应用 stderr 为 0 字节；还原 Host 权限为 `755`、大小 `114,270,524` 字节、SHA-256 为 `644053aac1adc50910157170302d90e907b99c5f410ce7513ccf26ba7ca44b37`、文件头为 ELF，Session lock 和 Host 残留进程均为 0。

当前 `gui-v0.84.1-lystar-gui.5` 公开 Beta 已发布。本机 Linux 原生 Tauri、公开下载的 Linux x64 AppImage、真实浏览器工作台、GUI/TUI 只读同步、Session 状态、项目指令、图片、补全、资源链接、Inspector 布局、Host 资源还原和正常退出已放行到对应证据层。五平台安装包、严格 SHA/manifest 和 provenance 已公开；macOS App 与 Darwin Host 为 ad-hoc code signature，未 notarize，Linux/Windows 无平台代码签名。Linux ARM64、macOS ARM64/x64 和 Windows x64 仅完成对应 GitHub 原生 runner 构建及 macOS DMG 内部签名/架构校验，不声明实机安装、Gatekeeper 或运行通过。真实 Linux SSH Remote Host 安装/断线接管、macOS LaunchDaemon、Windows Scheduled Task/named pipe、跨平台系统 WebView、普通模型对话/认证/Extension UI 与原生 Completion 键盘链、正式 updater 公钥、signed stable release set、Apple Developer ID/notarization 和 Windows Authenticode 仍未放行。

## 已通过

> 本节记录本轮最新实现之前的历史通过证据。凡涉及 GUI/Host/Protocol 文件的旧测试数量、bundle、截图和 sidecar smoke，只能证明当时基线，不能证明上面的最新代码。

### GUI 本机工作台、长 Session 与视觉闸门

本机真实链路使用 React/Vite 页面连接独立 `gui-host` stdio 子进程，没有使用 mock Session。主工作台已按 `docs/gui-design/screens/` 正式稿校准：左栏保持单一连续项目/Session 列表，选中项目和 Session 不再显示蓝色边线或 `box-shadow`，Session 三点按钮默认隐藏，只在 hover、键盘聚焦或菜单打开时显示；顶栏删除未接 `git-inspector` 的假“变更”入口和全局 Host 状态点，Composer 删除页面稿不存在的 Agent/Bash 分段控件。Topbar 标题负责截断，文件夹图标保持 `17px`。

Composer 无附件时只保留输入与 footer 两行，桌面高度为 `140px`、底距 `20px`；`800×600` 为 `120px`、底距 `12px`。存在真实附件时才启用附件行。普通输入继续发送 `prompt`，前缀 `!` 的文本发送 `run_bash`；Bash 模式带图片时前端明确拒绝且不发送请求。

TanStack Virtual 设置 `useFlushSync: false` 后，React 19 不再在 layout lifecycle 中触发 `flushSync was called from inside a lifecycle method`；重新加载、主题切换、抽屉操作和长列表浏览的浏览器控制台均为 0 error / 0 warning。Protocol Client 继续通过 `useSyncExternalStore` 发布不可变 snapshot，虚拟列表、实时投影和 JSONL commit 回读语义不变。

GUI Store 的 transcript 跨页窗口最多保留 600 条，并设置 8 MiB 的 JSON UTF-16 载荷估算预算；加载更早内容时完整保留新页，从较新的尾部淘汰，并恢复原首条滚动锚点。历史窗口收到同 generation commit 时保留当前内容并显示“回到最新”，generation 变化时强制丢弃 rewrite 前缓存并重读尾页；历史状态下的流式文本不会混入旧窗口。

`TranscriptReader` 不再为同时查找 header 和尾 entry 从文件末尾反向扫描完整 JSONL，而是分别读取首个有效 header 和最后一个有效 entry；跨多个 64 KiB 分块的长行只在遇到换行时合并一次。新增回归覆盖 header 前的超长坏行和 256 KiB 有效消息。真实 `127 MiB`、3665 条记录、最大单行约 `3.0 MiB` 的活动 Session，尾页 120 项读取由 `5.67s` 降到 `0.39s`。

新增可复现入口 `npm run benchmark:gui-sessions`，生成 16/64/256 MiB 非稀疏 JSONL，每档执行 2 次 warmup 和 10 次尾页测量。最终单独运行的 p95 分别为 `99.9ms`、`92.3ms`、`102.8ms`；256 MiB `createBranchedSessionManager()` 实际原子写入 `268,435,696` 字节耗时 `1.930s`，相对 Core `120s` stale 有约 `62.2x` 余量。独立 Node 基准进程峰值 RSS 为 `540.1 MiB`，其中同时包含 256 MiB 源 Session、分支条目物化和目标写入，不代表 GUI/WebView 只读总进程树。macOS、Windows 和最慢支持存储仍需复测后才能关闭跨平台 stale 项。

GUI Host 最新全量为 8 个文件、35/35 通过。当前项目 34 个 Session 共约 `259 MiB`，`SessionManager.list()` 仍需约 `2.8s` 构建 TUI 兼容的全文搜索元数据；没有增加第二份持久索引或失效协议。

Host 启动期 V8 profile 的主要热点为开发模式的 TypeBox schema 解析和 `tsx` ESM loader；初始化完成后连续 5 秒采样为 `0.00% CPU` 且 `rchar_delta=0`，已排除空闲死循环。正式 Tauri sidecar 不使用 `tsx` loader。

Playwright 已在真实项目、真实 Session 和真实 Tool 结果加载完成后，重新完成 `2816×1640`、`1280×800`、`800×600` 的浅色和深色六组正式截图：`/tmp/lystar-gui-final-wide-{light,dark}.png`、`/tmp/lystar-gui-final-desktop-{light,dark}.png`、`/tmp/lystar-gui-final-narrow-{light,dark}.png`。三种尺寸均无文档横向或纵向溢出；选中项目和 Session 的 `box-shadow` 为 `none`，Session 三点按钮默认 `opacity=0`，页面不存在 `.segmented-control` 或假“变更”按钮。主题设置真实点击依次写入 `light`、`dark`、`system` 并持久化到 `localStorage["lystar.gui.theme"]`；浅色 canvas 为 `#ffffff`，深色和系统深色为 `#151515`。`800×600` 项目抽屉关闭时位于 `left=-288`，打开后覆盖 `0..288px` 并显示遮罩，关闭后恢复。

设置页在真实 Host 数据上完成桌面和窄窗验收：模型页返回 41 个 Provider，支持按 Provider、模型名和模型 ID 搜索；Skill 页返回 50 项，作用域计数为用户 49、项目 1，支持全部/用户/项目筛选、搜索、启停和真实重新加载。重新加载前后列表稳定，设置页无横纵溢出。通用、外观、模型只读摘要、Skill、诊断和关于使用 Host 结构化数据；连接、认证写入和自动更新继续显示明确阻塞态，没有伪造按钮。设置侧栏只包含返回应用、搜索和真实页面导航，外观页三张预览由当前主题 Token 和 CSS 绘制。

相邻 `toolResult` 只通过现有虚拟行的首尾 class 合并边界，不创建分组数据或改变 transcript 索引。真实长 Session 中 10 个相邻 Tool 显示为 3 个连续区，后续 17 个 Tool 显示为 7 个连续区；展开后 TanStack Virtual 重新测量，滚动容器无溢出。Markdown 链接使用 `marked@18` 的 renderer parser 渲染嵌套 inline token，并继续过滤危险协议；合法嵌套链接和危险目标已有回归。用户可见 Session 锁、journal 损坏和 cursor 失效错误统一依据 `GuiProtocolError.code` 在 Store 映射中文。

同一真实长 Session 在 `800×600` 连续加载 4 页后触发 600 条窗口上限；历史中段 `scrollTop` 约 `35k px` 时，“加载更早内容”和“回到最新”保持吸顶 `top=0`，页面横纵溢出均为 0。点击“回到最新”后只保留尾页入口，内容高度从约 `69.8k px` 收回约 `13.3k px`，`distanceFromBottom=0`。本轮截图为 `/tmp/lystar-gui-transcript-window-history.png`、`/tmp/lystar-gui-transcript-window-narrow.png` 和 `/tmp/lystar-gui-transcript-window-final.png`；浏览器控制台和 Vite/Host 日志均无 error 或 warning。

本轮最新自动验证结果：GUI Protocol 1 个文件、4/4 通过；GUI Host 8 个文件、35/35 通过；GUI 2 个文件、11/11 通过，其中 Store 10 项、Markdown 1 项；Core 模型与 Session 聚焦矩阵 6 个文件、84/84 通过；`auth-check` 10/10 通过；Coding Agent 全量 238 个文件、2115 项通过，6 个文件、49 项跳过。根 `NODE_TLS_REJECT_UNAUTHORIZED=1 npm run check` 检查 1145 个文件并通过，`npm run build:offline`、`git diff --check` 和最终 `npm --workspace @lystar/code-gui run prepare:tauri` 通过；后者包含 updater 完全关闭闸门、最新 GUI production build、Tauri 资源物化、Linux x64 Bun sidecar 格式检查和真实 framed Protocol smoke。最新 GUI bundle 为 `1,323.93 kB`，gzip `417.43 kB`，仍有既有大 chunk warning，留作页面级拆分专项。

此前同一工作区的发布级矩阵已通过 TUI、AI 和 Agent Core 全量；本轮共享 Core 变更位于 Coding Agent `ModelRuntime` 启动注册路径，已由 Coding Agent 全量、根类型检查和离线构建覆盖。

当时产品结论为本机开发版 Alpha。React 工作台、真实 Host、本机 Session、长会话分页和浏览器视觉自动闸门已通过，但浏览器开发版不等同于原生桌面交付。当时未放行：Remote Host 的 systemd/LaunchDaemon/Windows Task 或 Service 平台托管、macOS/Windows 原生 IPC 与 OpenSSH 断线实机、`git-inspector`、模型 OAuth/API key 写契约、原子项目注册表、图片附件端到端、正式 updater 公钥与 signed stable release set、Tauri Rust/WebKitGTK 原生编译，以及三平台安装和系统 WebView 实机。用户私有 IPC、SSH 风格字节 relay、`remote-detach` capability 和 accepted 后断线重连的 Linux 多进程基础链已经实现并通过测试。

### GUI Runtime adapter、边界与 RPC contract 差分

新增 `scripts/check-gui-boundaries.mjs` 并接入根 `npm run check`。该 gate 使用 TypeScript AST 覆盖静态 import/export、import type、动态 `import()` 和 `require()`：只有 `packages/gui-host/src/runtime-adapter.ts` 可通过公开 `@earendil-works/pi-coding-agent/core` 接入 Coding Agent，GUI 不导入 TUI/interactive 私有实现，Core/TUI/Pi Protocol/Client/Server 不反向依赖 GUI。正向检查和“Host 绕过 adapter”“Core 反向导入 GUI”两类临时负向注入均能拦截，临时文件已删除。

`packages/gui-host/test/runtime-rpc-contract.test.ts` 与共享测试 Extension 使用 `node --import tsx packages/coding-agent/src/rpc-entry.ts` 启动真实源码 RPC 子进程，并用相同 Faux Provider 驱动 `CodingAgentRuntimeAdapter`。6/6 contract 覆盖默认模型选择和重开恢复、Tool 事件与 JSONL 角色顺序、`select`/`confirm`/`input`/`editor`/`notify`、流式 abort 与持久化 `stopReason: "aborted"`、项目 Prompt/Skill 发现与展开、Project Trust 隔离，以及 Session 切换后的模型、`high` 思考等级和 transcript 恢复。稳定 Core 语义参与比较，进程调度影响的部分流式文本长度不作为契约。

GUI Store 现有 10/10 回归：3 项覆盖事务式 Session 切换，4 项覆盖 transcript 跨页窗口的 600 条上限、8 MiB JSON UTF-16 载荷估算预算、同 generation commit 保留历史，以及 generation rewrite 强制重读尾页；其余覆盖普通 prompt 与 `!` Bash 路由、Bash 图片拒绝和 Protocol 错误码中文映射。Markdown 另有 1 项回归覆盖嵌套链接和危险协议过滤。测试使用独立 `packages/gui/vitest.config.ts`，不加载开发 Vite WebSocket bridge，运行后不再遗留 `TCPSERVERWRAP` 或等待 10 秒退出。

并行回归曾暴露启动加载 Extension provider 时的模型认证快照竞态：每次注册会触发后台 refresh，服务创建末尾又立即执行受控 refresh，两个 generation 互相作废时 Session 恢复偶发回退用户默认模型。修复位于共享 `ModelRuntime`/`createAgentSessionServices()`：启动批量注册使用 `{ refresh: false }`，全部注册完成后只执行一次 `await refresh()`；运行中的动态注册仍即时刷新。新增 Core 回归验证批量路径不会偷跑后台 availability。真实 `OPENAI_API_KEY` 也曾使 `auth-check` 的“无凭据”用例失去前提，测试现显式隔离并恢复环境变量，生产认证逻辑未改。

最新证据：Runtime/RPC contract 6/6、GUI 11/11、GUI Host 全量 35/35、Core 模型与 Session 聚焦矩阵 84/84、`auth-check` 10/10、Coding Agent 全量 2115 项、根 `npm run check`、离线构建、Biome、AST 边界 gate、`git diff --check` 和最终 sidecar framed smoke 均通过。Runtime 本机总闸门已通过；后续新增 Runtime 能力继续扩展同一 contract fixture。

### `0.84.1-lystar.13` 发布前核验

发布事实源已更新为 `piConfig.productVersion = 0.84.1-lystar.13`，Pi workspace 包版本继续保持 `0.84.1`，发行仓库保持 `lystar-team/lystar-code`。本版让 Coding Agent 与 Agent Harness 的 `edit` 按每个编辑独立选择唯一匹配层级并映射回原文件偏移；`apply_patch` 保留结构化 hunk、`@@` 上下文、顺序和 EOF 语义，在全部定位、歧义与重叠检查通过后原子写入，逐 hunk no-op 和失败回滚继续保持零写入。实时 Thinking 使用现有 Markdown tokenizer 渲染单行内联样式，展开的补丁文件正文点击只收起对应子卡片。Session JSONL、Tool 名、Provider、RPC、Protocol 与 Extension API 不变，功能提交为 `2cef70681`。

显式使用 Node.js `v22.21.1`、npm `11.11.0` 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、Unix 安装器测试和全部发布测试。TUI 全量退出码 0；AI 105 个 test files/878 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/403 项通过、1 项跳过；Coding Agent 237 个 files/2111 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、校验、失败回滚、卸载和模板物化通过；`git diff --check` 通过。CodeGraph 已同步到 1229 个文件、20707 个节点和 77332 条边，索引无 pending changes。

从 Bun 官方 `bun-v1.3.9` Release 下载 Linux x64 资产，`bun-linux-x64.zip` SHA-256 `4680e80e44e32aa718560ceae85d22ecfbf2efb8f3641782e35e4b7efd65a1aa` 与官方 `SHASUMS256.txt` 一致。使用该 Bun `1.3.9` 构建 Darwin ARM64/x64 和 Linux ARM64/x64 四个候选包，全部编入 3210 个模块，`SHA256SUMS` 四项通过；manifest 版本为 `0.84.1-lystar.13`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`，四个平台文件名、大小和 SHA-256 与实际归档一致。Linux x64 候选包 SHA-256 为 `510704335b7801fa98d67e1ff4ced341b36140fce214025d3dea2adf0402504b`，大小为 `46510448` 字节。

四个归档的 Mach-O/ELF 架构、`lc`/`lystar`、许可证、内置 Image Gen Skill 和旧 `la` 排除检查通过；Linux x64 候选包的 `lc --version`、`lystar --version`、中文帮助和 `PI_OFFLINE=1 lc --list-models` 通过。隔离 HOME 首次启动显示主题向导，按 `Escape` 跳过后进入完整工作区；候选包在独立 `80x24`、`80x8` 和 `120x36` tmux PTY 中均保留品牌、中文输入区和快捷栏，最大行宽分别为 79、79 和 119，没有越界，`/quit` 正常退出，临时 tmux server 已关闭。

当前 Linux 主机没有 MSVC、Windows SDK、ConPTY 或 WebView2 Runtime；Windows x64 原生构建、终端截图、托管 MinGit 和 PowerShell 5.1 安装链必须由本次 release commit 推送后的 main CI 与 Release Windows job 给出最终证据。物理 macOS/Windows 桌面交互本轮未实机运行，本地证据覆盖标准 Linux PTY、四个平台归档格式与架构；正式 tag 只能在同一 release commit 的 main push CI 全部成功后创建。

`main` commit `608dcc5b55f88623627395c78b95f43fc4bbda64` 的 CI run `31571711551` 七个 job 全部成功；TUI、AI、Agent Core、Coding Agent 双分片、源码构建和 Unix 安装器通过，`windows-installer` 完成 Windows x64 原生构建、托管 MinGit Bash、终端 Host/Icon 与截图，以及 PowerShell 5.1 安装器核验。

annotated Tag `v0.84.1-lystar.13` 的 Tag 对象为 `13412d6c97579848620632522b662d386f787c42`，本地和远端解引用后均固定指向 `608dcc5b55f88623627395c78b95f43fc4bbda64`。Release workflow run `31571986253` 成功，完成同 commit main CI 绑定、Bun 1.3.9 Unix/Windows 原生五平台打包、SHA/manifest 合并、artifact attestation 和公开发布。GitHub Release 于 `2026-08-12T07:01:03Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产，包括五个平台包、Unix/PowerShell/CMD 三个安装器、`SHA256SUMS` 和 `release-manifest.json`。

公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致；manifest 版本为 `0.84.1-lystar.13`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`。公开 Linux x64 包 SHA-256 为 `b1a10bb898353f12ceb1355fd5101f20fe09f62bf3fd629dfa05f46033773ba5`，大小为 `46509004` 字节；Windows x64 包 SHA-256 为 `0b11df2bc368bcac96e4f40c5a57bae093b4686a80ac198af7df47af844aeb71`，大小为 `64700837` 字节。Unix/Windows 归档的可执行入口、许可证和 Image Gen Skill 资源检查通过，Windows 包不包含旧 `la.exe`；GitHub Attestations API 按 Linux x64 digest 返回 1 条 `application/vnd.dev.sigstore.bundle.v0.3+json` provenance。

本机通过公开 `lc update --self` 从 `0.84.1-lystar.12` 原子更新到 `0.84.1-lystar.13`；`current` 指向 `.13`，`previous` 保留 `.12`，再次执行更新显示已是最新版本，`lc` 与 `lystar` 均报告 `0.84.1-lystar.13`，旧 `.12` 可执行文件仍可直接运行。安装后的公开版本在独立 `80x24` tmux PTY 中打开完整 LYStar Code 工作区和 `/settings`，最大行宽 79，无越界，`/quit` 正常退出；临时 tmux server 已关闭。

### `0.84.1-lystar.12` 发布前核验

发布事实源已更新为 `piConfig.productVersion = 0.84.1-lystar.12`，Pi workspace 包版本继续保持 `0.84.1`，发行仓库保持 `lystar-team/lystar-code`。本版修复上下文压缩摘要重复渲染、缓存分隔线持续累积，以及流式处理期间手动滚动被内容和状态高度变化抢回底部的问题；补丁卡片支持文件清单与单文件 Diff 独立展开，Thinking 可选择左下角实时显示或保留在对话输出中，同时精简空闲等待行并统一 Shell 与命令组图标。Session JSONL、Tool 名、Provider、RPC、Protocol 与 Extension API 不变。

显式使用 Node.js `v22.21.1` 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、Unix 安装器测试和全部发布测试。TUI 全量退出码 0；AI 105 个 test files/878 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 237 个 files/2096 项通过，6 个 files/49 项跳过。Coding Agent 首次全量运行发现旧 Bash 图标断言和 reload 夹具缺少 Thinking 展示设置两个测试契约问题，共 3 项失败；修正夹具后先复跑失败文件 10 项，再完整复跑全量通过。`git diff --check` 通过，CodeGraph 已同步到 1229 个文件、20669 个节点和 77018 条边，索引无 pending changes。

使用 Bun `1.3.9` 构建 Darwin ARM64/x64 和 Linux ARM64/x64 四个候选包，`SHA256SUMS` 四项全部通过；manifest 版本为 `0.84.1-lystar.12`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`，四个平台文件名、大小和 SHA-256 与归档一致。Linux x64 候选包 SHA-256 为 `15610d29b24b20bbfbced1ce3408330cf6880b6b153a52ae5d729cdd53965a6e`，大小为 `46510705` 字节；四个归档的 Mach-O/ELF 架构、`lc`/`lystar`、许可证、内置 Image Gen Skill 和安装器物化结果正确，Linux x64 的版本、离线模型列表和中文帮助通过。

源码与构建产物的真实 SGR/PTY 回放确认：用户滚离底部后，流式块反复增减 3 行时连续六帧保持同一历史顶行，滚到真实底部后恢复自动跟随；补丁文件独立展开、Thinking 两种展示位置、命令图标和压缩卡片重绘行为均通过。最终 Linux x64 候选包在隔离配置目录覆盖 `80x24`、`80x8` 和 `120x36`，顶栏、Composer 与快捷栏无重叠，`/quit` 正常退出；临时 tmux server 和配置目录已关闭或删除。

当前 Linux 主机没有 MSVC、Windows SDK、ConPTY 或 WebView2 Runtime；Windows x64 原生构建、终端截图、托管 MinGit 和 PowerShell 5.1 安装链必须由提交后的 main CI 与 Release Windows job 给出最终证据。具体手机终端应用和物理 macOS/Windows 桌面交互尚未实机运行，本轮本地证据覆盖标准 SGR 输入、真实 Linux PTY、四平台 Unix 归档格式与架构。

`main` commit `6d970900dd7efc35d52a1f0ed4d5072f4ee6129d` 的 CI run `31452345719` 七个 job 全部成功；TUI、AI、Agent Core、Coding Agent 双分片、源码构建和 Unix 安装器通过，`windows-installer` 完成 Windows x64 原生构建、托管 MinGit Bash、终端 Host/Icon 与截图，以及 PowerShell 5.1 安装器核验。

annotated Tag `v0.84.1-lystar.12` 的 Tag 对象为 `1c9a16c922b530d98bf648ff1ceb7e31b08fd3ef`，本地和远端解引用后均固定指向 `6d970900dd7efc35d52a1f0ed4d5072f4ee6129d`。Release workflow run `31452701106` 成功，完成同 commit main CI 绑定、Bun 1.3.9 Unix/Windows 原生五平台打包、SHA/manifest 合并、artifact attestation 和公开发布。GitHub Release 于 `2026-08-11T02:37:37Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产，包括五个平台包、Unix/PowerShell/CMD 三个安装器、`SHA256SUMS` 和 `release-manifest.json`。

公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致；manifest 版本为 `0.84.1-lystar.12`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`。公开 Linux x64 包 SHA-256 为 `96e44540e18992af3f60ed11ebaed398eb5d2d9eac978d8c4751284661763e2a`，大小为 `46503253` 字节；Windows x64 包 SHA-256 为 `61b063741c2ccf1bf9286ab1cec2be7d8b414c8c1213412114225aad190157f4`，大小为 `64699468` 字节。Unix/Windows 归档的可执行入口、许可证和 Image Gen Skill 资源检查通过，Windows 包不包含旧 `la.exe`；GitHub Attestations API 按 Linux x64 digest 返回 1 条 `application/vnd.dev.sigstore.bundle.v0.3+json` provenance。

隔离 HOME 使用公开 `.11` 安装器和 `lc update --self` 原子更新到 `.12`，`current` 指向 `.12`，`previous` 保留 `.11`，再次执行更新显示已是最新版本；安装后的 `lc` 与 `lystar` 均报告 `0.84.1-lystar.12`。公开 Linux x64 包在独立 `80x24` tmux PTY 启动完整 LYStar Code 工作区，`/settings` 返回本地交互界面并正常 `/quit`；按本轮约束未调用任何真实或付费 Provider。临时升级 HOME、PTY 配置目录和 tmux server 已删除或关闭。

### `0.84.1-lystar.11` 发布前核验

发布事实源已更新为 `piConfig.productVersion = 0.84.1-lystar.11`，Pi workspace 包版本继续保持 `0.84.1`，发行仓库保持 `lystar-team/lystar-code`。本版修复 Tool 组完成折叠、自动/手动/溢出压缩后内容大幅收缩留下旧帧、横线和错误滚动标记的问题；同时完善多命令层级间距、`read` 行号范围右对齐、统一 Unicode/emoji 工具图标、空闲当前目录标题、Tool 卡片 Hover 和闪烁细线光标。Session JSONL、Tool 名、Provider、RPC、Protocol 与 Extension API 不变。

滚轮输入统一通过 `WheelScrollNormalizer` 转换为逻辑行：独立滚轮移动 3 行，高频触控板和手机事件按最近事件间隔保留小数余量，方向反转立即清空旧方向状态；LYStar 主工作区、Changes Diff、Changelog、Agent 详情和 Subagent Session 共用同一速度模型。通用 Pi TUI 默认行为保持不变，LYStar 显式启用自适应滚动；鼠标事件按帧合并，键盘保持立即渲染，LYStar 上限为 60 FPS。真实 SGR/PTY 回放确认单个低频事件为 3 行、4 个约 16 ms 连续事件累计 7 行、同批次 5 个重复 tick 累计 4 行、快速反向第一步为 1 行；临时 tmux server 已关闭。

显式使用 Node.js `v22.21.1` 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、Unix 安装器测试和全部发布测试。TUI 全量退出码 0；AI 105 个 test files/878 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 237 个 files/2084 项通过，6 个 files/49 项跳过。`git diff --check` 通过，CodeGraph 已同步到 1229 个文件、20619 个节点和 76620 条边，索引无 pending changes。

使用 Bun `1.3.9` 构建 Darwin ARM64/x64 和 Linux ARM64/x64 四个候选包，`SHA256SUMS` 四项全部通过；manifest 版本为 `0.84.1-lystar.11`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`。Linux x64 候选包 SHA-256 为 `2fa22b95f65c5c1ac85ab70a3dc8d342bcaf9baa365419d1720bcbadca07b57c`，大小为 `46507501` 字节；四个归档的 Mach-O/ELF 架构、`lc`/`lystar`、许可证和内置 Image Gen Skill 资源检查通过，Linux x64 的版本、离线模型列表和安装器物化结果正确。候选包在独立 `80x24` tmux PTY 显示 LYStar Code 全屏输入区、快捷栏和离线无模型提示，`/quit` 正常退出；临时 tmux server 已关闭。

当前 Linux 主机没有 MSVC、Windows SDK、ConPTY 或 WebView2 Runtime；`main` commit `0c39d2e5d8d30c8aaa6845749c9a92a553f69825` 的 CI run `31439093789` 七个 job 全部成功，由 `windows-installer` 完成 Windows x64 原生构建、终端 Host/Icon、托管 MinGit 和 PowerShell 5.1 安装链核验。TUI、AI、Agent Core、Coding Agent 双分片、源码构建和 Unix 安装器同时通过。

annotated Tag `v0.84.1-lystar.11` 的 Tag 对象为 `a38d0938f5bd0c0f878d1826722d640ce9763087`，本地和远端解引用后均固定指向 `0c39d2e5d8d30c8aaa6845749c9a92a553f69825`。Release workflow run `31439421952` 成功，完成同 commit main CI 绑定、Bun 1.3.9 Unix/Windows 原生五平台打包、SHA/manifest 合并、artifact attestation 和公开发布。GitHub Release 于 `2026-08-10T22:47:43Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产。

公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致；manifest 版本为 `0.84.1-lystar.11`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`。公开 Linux x64 包 SHA-256 为 `6b697a341bbc0ef30107da3a7019e466113df5476deb3876fe7844e397777a82`，大小为 `46499955` 字节；Windows x64 包 SHA-256 为 `7dd63a50608553844ca9e222e334ab69b4895f185b87287aa8580ec78ecb1e3f`，大小为 `64697663` 字节。Unix/Windows 归档的可执行文件、许可证和 Image Gen Skill 资源检查通过，Windows 包不包含旧 `la.exe`；GitHub Attestations API 按 Linux x64 digest 返回 1 条 `application/vnd.dev.sigstore.bundle.v0.3+json` provenance。

本机使用公开 `.10` 的 `lc update --self` 原子更新到 `.11`，`current` 指向 `.11`，`previous` 保留 `.10`，再次执行更新显示已是最新版本。安装后的 `lc` 与 `lystar` 均报告 `0.84.1-lystar.11`；独立 `80x24` tmux PTY 使用现有 `upstream/gpt-5.6-sol` 配置启动完整 LYStar Code 工作区并正常 `/quit`。具体手机终端应用和物理 Windows 桌面交互尚未实机运行，本轮证据覆盖标准 SGR 输入、真实 Linux PTY、Windows CI 原生构建和终端 smoke。

### `0.84.1-lystar.10` 发布前核验

发布事实源已更新为 `piConfig.productVersion = 0.84.1-lystar.10` 和 `releaseRepository = lystar-team/lystar-code`，本地 `origin` 同步切换到 `git@github.com:lystar-team/lystar-code.git`。安装器、manifest、自动更新、OpenRouter attribution、当前安装文档和对应测试统一使用新仓库；历史版本验证记录保留当时的旧仓库事实。Pi workspace 包版本继续保持 `0.84.1`，Session JSONL、Tool 名、Provider、RPC、Protocol 与 Extension API 不变。

本版将 Tool、Web Search、Turn/Skill/Branch/Compaction 摘要和 Subagent 统一为平面高密度卡片。连续 Tool 保持原始顺序，只合并相邻 Bash；每张卡片独立展开，灰色分隔线和越界行不可点击，OSC 8 链接优先。Subagent 外层、Agent 行和会话入口分离交互，显示层完成模式、作用域和状态汉化；长路径按 ANSI 可见宽度裁切，Windows 独立宿主使用 rich Unicode，attached 终端保留 ASCII fallback。Session 级展开状态只存在当前运行态，不写入 JSONL。

显式使用 Node.js `v22.21.1` 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、Unix 安装器测试和全部发布测试。TUI 全量退出码 0；AI 105 个 test files/878 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 237 个 files/2083 项通过，6 个 files/49 项跳过。仓库迁移相关 3 个测试文件共 49 项通过，`git diff --check` 通过，CodeGraph 已同步且无 pending changes。

使用 Bun `1.3.9` 构建 Darwin ARM64/x64 和 Linux ARM64/x64 四个候选包，`SHA256SUMS` 四项全部通过；manifest 版本为 `0.84.1-lystar.10`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`。Linux x64 候选包 SHA-256 为 `138a82e24891026b5c050c7a762661919b97ef0630addd2bd8fd1881310a10c9`，大小为 `46501253` 字节；`lc --version`、`lystar --version`、`PI_OFFLINE=1 lc --list-models`、许可证和内置 Image Gen Skill 资源检查通过。候选包在独立 `80x24` tmux PTY 显示 LYStar Code 全屏输入区、快捷栏和离线无模型提示，`/quit` 正常退出；临时 tmux server、Session 和解压目录已删除。

当前 Linux 主机没有 MSVC、Windows SDK、ConPTY 或 WebView2 Runtime；`main` commit `3ba8ec291d4ae5a06acb36340694509874eccb58` 的 CI run `31383013414` 七个 job 全部成功，由 `windows-installer` 完成 Windows x64 原生构建、终端截图、托管 MinGit、ConPTY/WebView2 和 PowerShell 5.1 安装链核验。TUI、AI、Agent Core、Coding Agent 双分片、源码构建和 Unix 安装器同时通过。

annotated Tag `v0.84.1-lystar.10` 的 Tag 对象为 `5cfda1de418d8a462ceb616e249d055e33564060`，本地和远端解引用后均固定指向 `3ba8ec291d4ae5a06acb36340694509874eccb58`。Release workflow run `31383308138` 成功，完成 main CI 绑定、Bun 1.3.9 Unix/Windows 原生五平台打包、SHA/manifest 合并、artifact attestation 和公开发布。GitHub Release 于 `2026-08-10T11:28:04Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产。

公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致；manifest 版本为 `0.84.1-lystar.10`、Pi 版本为 `0.84.1`、仓库为 `lystar-team/lystar-code`。公开 Linux x64 包 SHA-256 为 `ea8c1d2025159dd2228b6f49a72f6eae60923156b63972a5c44c5ec121bd4725`，大小为 `46497285` 字节；版本、离线模型列表、许可证和 Image Gen Skill 资源检查通过。GitHub Attestations API 按 `sha256:` digest 返回 1 条 `application/vnd.dev.sigstore.bundle.v0.3+json` provenance。

本机使用公开 `.9` 的 `lc update --self` 原子更新到 `.10`，`current` 指向 `.10`，`previous` 保留 `.9`，再次执行更新显示已是最新版本。安装后的 `lc` 与 `lystar` 均报告 `0.84.1-lystar.10`；独立 `80x24` tmux PTY 使用现有 `upstream/gpt-5.6-sol` 配置启动完整 LYStar Code 工作区并正常 `/quit`。临时公开资产目录以外的 tmux server、Git 仓库和候选解压目录均已删除。

### `0.84.1-lystar.9` 发布与升级核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.9`，Pi workspace 包版本继续保持 `0.84.1`。用户可见产品名改为 `LYStar Code`，主命令为完全等价的 `lc` 和 `lystar`；仓库 `octyean/lystar-agent`、发行包前缀 `lystar-agent`、安装根目录、`.pi`、`PI_*`、Session JSONL、Protocol 和 Extension API 保持兼容。升级后删除用户级 `la` launcher；新 launcher 回退到 `0.84.1-lystar.8` 或更早版本时会自动执行旧目录中的 `la`/`la.exe`。

本版同时交付原生 `image_gen` Tool、OpenAI API Key/OpenAI Codex OAuth/OpenRouter 图片 Provider、内置 Image Gen Skill、稳定图片落盘与 Session 恢复，以及主会话和 Subagent Overlay 统一卡片点击。真实 `upstream/gpt-5.6-sol` 已调用 `upstream/gpt-image-2` 完成 generations，严格 schema 补齐 `referenced_image_paths=[]` 和 `num_last_images_to_include=0` 时仍按纯文本生成处理；透明背景对照与图片质量数据见下节。

本机发布 gate 已通过：`npm run check`、`npm run build:offline`、Unix 安装器安装/PATH/SHA/升级/回退/卸载/物化测试、TUI 全量、AI 105 个 files/878 项通过且 25 个 files/825 项跳过、Agent Core 20 个 files/402 项通过且 1 项跳过、Coding Agent 235 个 files/2071 项通过且 6 个 files/49 项跳过。当前 Shell 注入的失效 `OPENAI_API_KEY` 会干扰无凭据测试，AI 与 Coding Agent 全量只对测试进程移除了该变量，没有修改用户凭据文件。

使用 Bun `1.3.9` 构建四个 Unix 候选包，`SHA256SUMS` 全部通过；manifest 版本为 `0.84.1-lystar.9`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`。Linux x64 候选包 SHA-256 为 `1812da52c7bab3944fe69cc2fcf5d68acf1c7a4164680486cd3e4e4b2de3ba32`，大小为 `46494003` 字节；`lc --version`、`lystar --version` 和 `PI_OFFLINE=1 lc --list-models` 通过。四个归档均包含 `lc`、`lystar`、MIT/第三方许可证和 `skills/imagegen/{SKILL.md,NOTICE.txt,LICENSE.txt}`，且不包含公开 `la` launcher。首次候选检查发现 standalone 归档漏复制 Skill，已在 Unix/Windows 打包责任位置修复，并为 Release workflow 增加硬校验。

Linux x64 候选包在独立 tmux PTY 覆盖 `80x24`、`80x8` 和 `120x36`，输入框持续显示 `LYStar Code`，Composer 与快捷栏无重叠，`/quit` 正常退出。Unix 安装器测试从仅有旧 `la` 的模拟版本升级到 `.9`，确认创建 `lc`/`lystar`、删除公开 `la`，再回退后两个新 launcher 都可调用旧目录的 `la`。

`main` commit `88070d67edc474a1d8550da6c43e8d3939b41256` 的 CI run `31353683784` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows 原生终端、托管 MinGit 和 PowerShell 5.1 安装/升级/回退。首次 CI `31353150090` 通过新增旧版 fixture 暴露 PowerShell 5.1/.NET Framework 不接受 `File.Replace(..., $null)`，已改为同目录备份路径；第二次 CI `31353438172` 证明安装与指针回退成功后，发现测试只复制单个旧 exe、缺少 standalone 资源，已改为完整旧版目录；最终 CI 的 Windows Terminal host 首次发生一次 15 秒退出超时，同 commit 只重跑失败 job 后完整通过，前两次 run 的同一终端步骤也均通过。

annotated Tag `v0.84.1-lystar.9` 的 Tag 对象为 `1f68c240c1bf724c5a43dfd2c28742364c6682a8`，本地和远端解引用后均固定指向 `88070d67edc474a1d8550da6c43e8d3939b41256`。Release workflow run `31354104899` 成功，完成 main CI 绑定、版本校验、Bun 1.3.9 五平台打包、Windows 原生二进制 smoke、artifact attestation 和公开发布。GitHub Release 于 `2026-08-10T04:02:43Z` 发布，为非草稿、非预发布正式版本，共有 10 个上传资产。

公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致；Unix 与 Windows 归档均包含 `lc`/`lystar`、Image Gen Skill、NOTICE、Apache-2.0 许可证、MIT 和第三方许可证，且不包含公开 `la`/`la.exe`。公开 Linux x64 包 SHA-256 为 `7eb3e8cb0ecc56cfcec3a0e87c32fc32f364a003e2aff0bef914a40e92a39da2`，大小为 `46493207` 字节；Windows x64 包 SHA-256 为 `1c6b4ab9bcedb2d593bb504acd4cb0e339072ecc73100e2ec45dd6ef08410b76`，大小为 `64690542` 字节。GitHub Attestations API 按 Linux x64 SHA-256 返回 1 条 `application/vnd.dev.sigstore.bundle.v0.3+json` provenance。公开 Linux x64 包的 `lc --version`、`lystar --version`、`PI_OFFLINE=1 lc --list-models` 和 Skill 资源检查通过。

本机使用旧版公开 `la update --self` 从 `0.84.1-lystar.8` 原子更新到 `.9`，`current` 指向 `.9`，`previous` 保留 `.8`，安装后只存在 `~/.local/bin/lc` 和 `~/.local/bin/lystar`，旧 `~/.local/bin/la` 已删除；再次运行 `lc update --self` 显示已是最新版本。随后执行 `lc update --rollback` 切回 `.8`，两个新 launcher 均通过旧目录 `la` 报告 `.8`；再次执行同一命令切回 `.9`，最终 `current=.9`、`previous=.8`。安装后的公开 `lc` 在独立 `80x24` tmux PTY 使用真实 `upstream/gpt-5.6-sol` 返回精确结果 `LYSTAR-CODE-PUBLIC-0841-9-OK`，`lystar` 也以公开安装路径进入显示 `LYStar Code` 的完整 TUI；两次均使用 `--no-session` 并正常 `/quit`，临时 tmux server 和 Git 目录已删除。

### 原生 `image_gen` 与统一卡片交互核验

新增 OpenAI API Key、OpenAI Codex OAuth 和 OpenRouter 三条图片生成路径，默认模型为 `gpt-image-2`；`ModelRuntime` 的文本模型与图片模型共用现有 `RuntimeCredentials`。内置隐藏 Extension 同时注册平面 Tool `image_gen` 与内置 `imagegen` Skill，Skill、NOTICE 和 Apache-2.0 完整许可证会复制到 Node/npm 与 Bun binary 资产目录。Tool 支持纯文本生成、最多 5 张本地参考图或最近会话图片，结果原子保存到 `~/.pi/agent/generated_images/<session>/<call>.png`，Session 继续使用现有 Tool Result `ImageContent`，没有修改 JSONL、Protocol 或 Extension API。为兼容会强制补齐 optional Tool 参数的 OpenAI-compatible Provider，`num_last_images_to_include=0` 明确表示纯文本生成，`1..5` 仍表示引用最近会话图片。

图片凭据按请求顺序惰性解析：当前会话使用 `openai-responses`、`openai-completions`、`openai-codex-responses` 或 OpenRouter 时，先复用该 Model Provider 完整解析后的 API key、Header 和 `baseUrl`；当前候选不可用或请求失败后，再依次读取 `openai-codex`、`openai`、`openrouter` 图片凭据。当前候选成功时不会刷新后续 OAuth；中止和内容安全错误不会跨 Provider 重试。Codex 文本入口的 `https://chatgpt.com/backend-api` 会转换为图片入口 `https://chatgpt.com/backend-api/codex`。

TUI 新增统一 `InteractiveCard` 契约。普通卡片默认整卡点击，Tool Group 只负责把行映射到组头或子卡片，Subagent 行动作优先于展开；OSC 8 链接按实际列范围优先，卡片动作延迟到无拖动的鼠标释放，拖动仍进入文本选择。主会话和 Subagent Overlay 共用同一 action resolver；Overlay 记录组件行范围、滚动偏移和稳定卡片 key，实时重建时保留展开状态。`Ctrl+O`、滚轮、PageUp/PageDown、resize、Composer 与旧 Session 行为保持原链路。

`npm run check`、`npm run build:offline`、TUI 全量、Agent Core 全量和 Coding Agent 全量通过。结果：AI 105 个 test files/877 项通过、25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 235 个 files/2067 项通过、6 个 files/49 项跳过；TUI 全量退出码 0。AI 首次全量命令因当前 Shell 注入了失效 `OPENAI_API_KEY`，39 个在线 E2E 返回 401；仅对复跑进程移除该环境变量后全部离线 gate 通过，没有修改凭据文件。2026-08-10 的凭据优先级调整再次通过 `npm run check`、`npm run build:offline`、`image-gen-extension.test.ts` 6 项和 `openai-images.test.ts` 5 项；新增断言覆盖当前 Provider 优先、惰性读取备用凭据、自定义 `baseUrl`、Bearer Key、Provider Header、请求失败后切换 Codex、内容安全错误停止切换，以及 Provider 补齐 `referenced_image_paths=[]`、`num_last_images_to_include=0` 时仍执行纯文本生成。

真实 PTY 使用独立临时 `PI_CODING_AGENT_DIR` 验证：主会话 Bash 卡片经 `Ctrl+O` 展开后，点击第 2 行输出可折叠；从同一卡片拖动选择会显示 `Copied!` 且不触发展开切换；`80x8` 保留 Composer 与快捷栏，`120x36` 无重叠。持久化 Session 中点击 Subagent 行进入 Overlay，展开子会话 Bash 卡片后点击第 2 行输出可折叠；同一 JSONL 追加既有 Tool Result `ImageContent` 后重启，恢复显示 `image_gen` 摘要“已生成图片 one red pixel”。所有本轮 tmux server 和临时 Session 已删除。

2026-08-10 已完成真实图片 Provider 调用。使用当前会话 `upstream/gpt-5.6-sol` 驱动原生 `image_gen`，Provider 按严格 schema 补齐 `referenced_image_paths=[]` 和 `num_last_images_to_include=0` 后，Tool 复用当前 Provider 凭据与网关，通过 `upstream/gpt-image-2` 成功执行 generations，返回 `mode=generate` 并保存 1254×1254 PNG。随后使用与 Codex 官方相同的 `remove_chroma_key.py --auto-key border --soft-matte --transparent-threshold 12 --opaque-threshold 220 --despill` 去除纯绿色背景，并统一缩放到 1024×1024 RGBA：`~/.pi/agent/generated_images/comparison-20260810/lystar-native-transparent.png`。成品边界 alpha 最大值为 0，完全透明像素占 74.0068%，部分透明像素占 0.9890%，无明显绿色残边。对照的 Codex CLI 成品为同目录 `codex-cli-transparent.png`；两条链路均使用 `gpt-image-2` 生成色键背景并运行同一官方去底脚本，构图差异属于模型随机输出。

### `0.84.1-lystar.8` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.8`，Pi workspace 包版本继续保持 `0.84.1`。本版让 TUI 中的原生 Web Search 摘要支持点击和 `Ctrl+O` 展开全部来源，来源链接继续使用现有 Markdown/OSC 8 浏览器打开链路；citation 标题优先于域名回退。`LYStar Agent` 固定显示在全屏输入框右上边框，不再依赖顶栏宽度。Session JSONL、Web Search sources/citation、Provider、Protocol、Tool 和 Extension API 格式不变。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部发布 gate。TUI 全量通过；AI 104 个 test files/873 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 234 个 files/2060 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。新增回归覆盖来源折叠/展开、citation 标题、摘要点击、来源链接打开、`Ctrl+O` 状态文案，以及 40/80/160 列输入框品牌位置。

四个 Unix 候选包使用 Bun `1.3.9` 构建，`SHA256SUMS` 四项全部通过；manifest 版本为 `0.84.1-lystar.8`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`，四个平台文件大小和 SHA-256 均与 manifest 一致。格式覆盖 macOS ARM64/x64 Mach-O 和 Linux ARM64/x64 ELF，全部归档包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。Linux x64 候选包 SHA-256 为 `daedfa65f5c97ab149476ceec20a9552d66c77262a485c7493974012fec0d36f`，其 `la --version`、中文帮助和 `PI_OFFLINE=1 la --list-models` 通过。

Linux x64 候选包在独立 tmux PTY 加载包含 12 个 Web Search sources 和 1 个 citation 的真实 Session：`80x24` 折叠态显示来源数量，`Ctrl+O` 后全部来源可见；`80x8` 保留输入框、`LYStar Agent` 标题和快捷栏；`160x36` 展开列表、正文、引用和固定底栏无重叠。鼠标摘要展开与来源链接打开由真实 `LystarTUI` 输入回归验证。`lystar-release-0841-8-candidate` tmux server 和 Session fixture 已删除。

CodeGraph 已同步到 1214 个文件、20232 个节点和 76855 条边，索引无 pending changes；affected 只返回 `assistant-message.test.ts`、`interactive-mode-status.test.ts`、`interactive-tui.test.ts` 和 `lystar-workspace.test.ts`，均已包含在 Coding Agent 全量测试中。当前 Linux 主机没有 MSVC、Windows SDK、ConPTY 或 WebView2 Runtime，Windows x64 原生构建、GUI smoke、MinGit 和 PowerShell 5.1 安装器必须由提交后的 `windows-installer` CI 与 Release Windows job 给出最终证据。

`main` commit `c711f8c4c204b70a867312759c19f83e44c9eb19` 的 CI run `31299283691` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows 原生终端、托管 MinGit 和 PowerShell 5.1 安装器。annotated Tag `v0.84.1-lystar.8` 的 Tag 对象为 `3dfe1e53ecafb09f8d8dd6e8a5abe81af37a6889`，本地和远端解引用后均固定指向该 commit。

Release workflow run `31299456552` 成功，完成 main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、Windows 原生二进制 smoke、artifact attestation 和公开发布。GitHub Release 于 `2026-08-09T06:46:15Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产。公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致；公开 Linux x64 包 SHA-256 为 `d79a623a70c078c6090cc9124d2cdd88a79a70740bdc398bb268ea54c75dc7fd`，GitHub Attestations API 返回 1 条 provenance。

本机通过公开 `la update self` 从 `0.84.1-lystar.7` 原子更新到 `0.84.1-lystar.8`，`current` 指向 `.8`，`previous` 保留 `.7`，再次更新显示已是最新版本。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 展开 12 个 Web Search sources 并持续显示输入框标题；随后在临时 Git 仓库使用真实 `upstream/gpt-5.6-sol` 返回精确结果 `LYSTAR-0841-8-OK`。本轮 tmux server、Session fixture、临时 Git 仓库和候选 Session 均已删除。

### `0.84.1-lystar.7` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.7`，Pi workspace 包版本继续保持 `0.84.1`。Session JSONL 保持向后兼容；远程 client/server wire protocol 从 v1 升到 v2，旧版本会在握手阶段拒绝混用。

`openai-responses` 原生 `web_search` 已改为结构化保存搜索调用、状态、query/queries、完整 sources 和正文 `url_citation`，并贯通同模型 stateless replay、跨模型私有调用剥离、TUI、Print、HTML 导出和远程 Protocol v2。Provider 流中 `web_search_call` 的 added item 可能暂不包含 `action`；转换边界现使用 `search` 占位，并在 done 或 terminal response 回填完整 action。流失败、`response.failed`、提前 EOF 和迭代异常会把未结束搜索统一收尾为 `failed`。

本机已停用用户级 `~/.pi/agent/extensions/openai-web-search.ts`，备份位于 `~/.pi/agent/extensions-disabled/openai-web-search.ts.disabled-20260809`。源码执行路径未发现固定调用 `gpt-5.6-luna` 或 `openai_web_search`。使用构建后的 `upstream/gpt-5.6-sol` 完成真实搜索，Session `2026-08-09T02-55-55-366Z_019fe472-c7e6-756c-929a-3130ff098b61.jsonl` 保存 1 个 completed `webSearchCall`、12 个 sources 和 1 个 `url_citation`，最终模型仍为 `gpt-5.6-sol`。Print 输出正文和引用；同一 Session 导出的 `/tmp/lystar-web-search-export.html` 解码回查得到 `status=completed`、`sources=12`、`citations=1`。

Windows Shell 统一到 `~/.pi/agent/bin/mingit/` 托管 MinGit 的绝对 Bash/Git 路径和显式环境；安装锁包含 PID、token、heartbeat 和 stale 回收。standalone Windows 交互启动新增 `lystar-terminal.exe`，通过 ConPTY 运行现有 TUI，以 WebView2、xterm.js 和本地 Noto Sans CJK 处理 UTF-8、中文输入、resize、剪贴板、链接、关闭确认、窗口状态和品牌图标。`--version`、`--help`、`--print`、JSON/RPC、管道、auth、安装更新和 `--attached` 保留当前终端。

Windows 发行已从 Ubuntu 交叉构建中拆出，改由 `windows-2025` 使用 MSVC 原生构建带 ICO 的 `la.exe` 和静态 MSVC Runtime 的 `lystar-terminal.exe`；CI 会验证 WebView2 smoke、ConPTY 窗口、Unicode 截图、resize、键盘、图标、托管 MinGit 并发/离线初始化，以及使用本次构建 zip、manifest 和固定 checksum MinGit archive 的 `-Offline` 安装、启动和卸载。安装器会在切换 `current` 前精确校验候选和安装后版本。

Linux 本机显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全量 `npm test`。结果：脚本 7 项；Agent Core 402 项通过、1 项跳过；AI 104 个 files/873 项通过、25 个 files/825 项跳过；Client 36 项；Coding Agent 234 个 files/2058 项通过、6 个 files/49 项跳过；Evals 23 项；Protocol 147 项；Server 50 项；Telemetry 15 项；SQLite 81 项；TUI 全量通过。`git diff --check`、`bash -n`、Node 脚本语法、PowerShell UTF-8 BOM、shrinkwrap 和 install lock 均通过。CodeGraph 增量同步 43 个文件，`affected` 返回的 Web Search、TUI、Windows Terminal、Protocol 和 Server 五个测试文件均已覆盖。

当前 Linux 主机没有 MSVC、Windows SDK、ConPTY 或 WebView2 Runtime，因此没有把 `host.cpp` 编译、GUI 截图和 PowerShell 5.1 离线安装写成已通过；这些项目必须由提交后的 `windows-installer` CI job 给出最终运行证据。

### `0.84.1-lystar.6` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.6`，Pi workspace 包版本继续保持 `0.84.1`。本版修复 Subagent parallel 卡片在空 `chain` 参数下显示 `0 个 Agent`、短工具调用的当前动作被合并更新吞掉，以及子会话 Overlay 的滚轮和翻页输入被主会话优先消费三个问题；功能提交为 `36076660d3c390e0cd19e6c52724d617a985f540`。Session JSONL、Subagent Session 引用、Tool Result 和 Extension API 格式不变。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部发布 gate。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 232 个 files/2053 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。第一次 Agent Core 命令使用了不存在的 workspace 名 `@earendil-works/pi-agent`，npm 在执行测试前退出；改用仓库声明的 `@earendil-works/pi-agent-core` 后全量通过。

五平台候选包使用 Bun `1.3.9` 构建，`SHA256SUMS` 五项全部通过，manifest 版本为 `0.84.1-lystar.6`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`，五个平台文件大小和 SHA-256 均与 manifest 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+；所有归档包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。Linux x64 候选包 SHA-256 为 `7b8e60d63823b6d56ac013ce097b5609a07a7ff962a23ef7bdd23f56714d4a95`，其 `la --version`、中文帮助和 `PI_OFFLINE=1 la --list-models` 通过。

Linux x64 候选包在独立 `80x24` tmux PTY 加载包含空 `chain` 和两个 parallel task 的真实 Session，卡片显示 `parallel · 2 个 Agent`，当前动作分别显示 `$ sleep 30` 和 `read docs/lystar-agent-plan.md`。通过 `/agents` 进入 24 条消息的持久子会话后，PageUp 从消息 21–24 上移到 16–19，滚轮下移后显示 17–20，PageDown 回到底部 21–24；Esc 返回主会话，`lystar-0841-6-candidate` tmux server、Session fixture 和候选解压目录均已删除。

CodeGraph 已同步到 1206 个文件、20087 个节点和 77861 条边，pending changes 为 0、`reindexRecommended=false`。受影响范围落在 Subagent RPC 状态、TUI Overlay 输入和子会话滚动链路，对应数量、短命令即时发布、Overlay 输入优先和键鼠滚动回归均已包含在 Coding Agent 全量测试中。

当前 Linux 环境没有 macOS 实机和 Windows Console/ConPTY 的交互证据；这两个平台完成了格式、架构、归档内容和自动测试核验，Windows 安装器链已由 main CI 验证。

`main` commit `f213341f1e3afb2586a5e8b65e99eb3f9563ab18` 的 CI run `31261796935` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows managed MinGit Bash 和 PowerShell 5.1 安装器。annotated Tag `v0.84.1-lystar.6` 的 Tag 对象为 `a9853253d2b1afb0dbe738d20216534ea78af0ee`，本地和远端解引用后均固定指向该 commit。

Release workflow run `31261894244` 成功，完成同 commit main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-08T14:26:41Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产；Release Notes 已列出 parallel 数量、当前动作和子会话滚动三项修复，并保留旧用户级 `~/.pi/agent/extensions/subagent/` 的删除提醒。

公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致。公开 Linux x64 包 SHA-256 为 `9877c9358133cbcfba0869a03b53a95f0619654404415de1d2e06f5d369effed`；GitHub Attestations API 返回 1 条 Sigstore bundle，公开包版本和离线模型列表通过。第一次公开资产下载在 GitHub GraphQL 请求阶段返回 `EOF`，清空临时目录并重试后完整下载和验收通过。

本机通过公开 `la update` 从 `0.84.1-lystar.5` 原子更新到 `0.84.1-lystar.6`，`current` 指向 `.6`，`previous` 保留 `.5`，再次更新显示已是最新版本。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 显示 `parallel · 2 个 Agent` 和 `$ echo installed-latest`、`read AGENT_VERIFICATION.md` 两项当前动作；通过 `/agents` 进入持久子会话后，PageUp、滚轮和 PageDown 均正确移动并返回底部。`lystar-installed-0841-6` tmux server、Session fixture 和临时解压目录已删除，旧用户级 `~/.pi/agent/extensions/subagent/` 仍不存在。

### `0.84.1-lystar.5` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.5`，Pi workspace 包版本继续保持 `0.84.1`。本版为 `apply_patch` 增加文件级增删统计和可展开完整 Diff，并将 Subagent 升级为可点击、可继续输入、可在 RPC 回收或主程序重启后恢复的持久子会话；旧 Subagent 记录没有 Session 引用时保持只读。功能提交为 `7b1c7cd015f3ee91490df000fcfc7e3bbbbdbe80`。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部发布 gate。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 232 个 files/2050 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

五平台候选包使用 Bun `1.3.9` 构建，`SHA256SUMS` 五项全部通过，manifest 版本为 `0.84.1-lystar.5`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`，五个平台文件大小和 SHA-256 均与 manifest 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+；所有归档包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。Linux x64 候选包 SHA-256 为 `b20e309914cd1a980af3a8a61cf3b208e145ee8ca39c3b9eb2cf0ec45860675b`，其 `la --version`、中文帮助和 `PI_OFFLINE=1 la --list-models` 通过。

Linux x64 候选包使用普通启动方式在独立 `100x30` tmux PTY 加载包含 `apply_patch` 和 Subagent 的真实 Session：折叠态持续显示两个文件及总计 `+3 -1`，`Ctrl+O` 展开后显示完整逐行 Diff；`/agents` 选中 worker 后进入独立子会话，Esc 返回主会话。随后 resize 到 `80x24`，顶栏、Diff、Agent 行、Composer 和快捷栏无重叠；`lystar-release-0841-5-candidate` tmux server 与临时 Session 文件均已删除。本机旧用户级 `~/.pi/agent/extensions/subagent/` 已删除，普通启动加载二进制内置新版。

基于功能提交创建独立模拟 worktree，将最新 `upstream/main` `9dd90a49711d088b86fdd9b4aea575913a8328a8` 合入。冲突只落在 `interactive-mode.ts`、`interactive-tui.test.ts` 和 `settings-selector.test.ts`，来自上游新增 fullscreen exit output 与 LYStar workspace 输入、overlay 清理及本地化测试占用相同段落；按双方语义合并后 `npm run check` 和 7 个聚焦测试文件共 64 项通过。模拟 worktree 和独立依赖已删除，没有进入 `main`。

当前 Linux 环境没有 macOS 实机和 Windows Console/ConPTY 的交互证据；这两个平台只验证了格式、架构、归档内容、自动测试和 CI 平台链路。

`main` commit `33912045e12cc10ea07a3631d7f7f07aa3196d2f` 的 CI run `31252058301` 七个 job 全部成功。annotated Tag `v0.84.1-lystar.5` 的 Tag 对象为 `3e5407b94bec0946c1ee680952b364a4b579585a`，本地和远端解引用后均固定指向该 commit。

Release workflow run `31252154589` 成功，完成同 commit main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-08T10:10:39Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产；Release Notes 已写明旧用户级 `~/.pi/agent/extensions/subagent/` 的删除要求。

公开五平台包重新下载后 `SHA256SUMS` 五项全部通过，文件大小和 SHA 与公开 manifest 一致。公开 Linux x64 包 SHA-256 为 `eeddfb5a8712b221c0b09dbbced7312fe5d3876ad440c80044ab1aca07b761f1`；GitHub Attestations API 返回 1 条 Sigstore bundle，公开包版本和离线模型列表通过。

本机通过公开 `la update` 从 `0.84.1-lystar.4` 原子更新到 `0.84.1-lystar.5`，`current` 指向 `.5`，`previous` 保留 `.4`，再次更新显示已是最新版本。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 显示 `apply_patch` 文件统计和完整 Diff，并通过 `/agents` 进入独立子会话；`lystar-release-0841-5-installed` tmux server 与临时 Session 文件已删除。

### `0.84.1-lystar.4` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.4`，Pi workspace 包版本继续保持 `0.84.1`。本版分离模型上下文与完整活动分支 transcript，增加反向 JSONL 分页、渐进 Session opening、hidden `apply_patch`、`edit` 候选行号、最终 Turn 状态判定、Subagent RPC controller、`/agents` 工作台、长 Markdown/代码折叠和性能基准；Session JSONL、Provider、模型 ID、CLI、`PI_*` 与现有 Extension API 保持兼容。功能提交为 `836904e0a`。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部发布 gate。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/402 项通过、1 项跳过；Coding Agent 231 个 files/2044 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

16/64/256 MB Session 均使用 80x24 真实 PTY 完成 2 次 warmup 和 10 次测量。`T_shell` p95 分别为 35/36/50 ms，`T_tail` p95 为 81/83/105 ms，`T_context_ready` p95 为 564/802/2728 ms。256 MB Session 仍由全量 entry 物化和 V8 GC 主导，event-loop p95 为 115.7 ms、峰值 RSS 为 432.1 MiB；Yean 在获知该限制后明确授权发布 `.4`，后续性能工作保留 lazy entry store 和数值化 resize benchmark，不把该余量描述为已解决。

五平台候选包使用 Bun `1.3.9` 构建，`SHA256SUMS` 五项全部通过，manifest 版本为 `0.84.1-lystar.4`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+；Linux x64 候选包 SHA-256 为 `e5406d9bac5be28bcc77f0375ad0b3a0ffe879c931792bf40bf1500b91a90351`，其 `la --version`、中文帮助和 `PI_OFFLINE=1 la --list-models` 通过。

Linux x64 候选包在全新 Git 工作区的独立 `80x24` tmux PTY 正常启动，`/agents` 显示 0 个 Agent 的中文空态，Esc 返回主会话，`/quit` 正常退出；`lystar-release-0841-4-candidate` tmux server 已关闭。此前源码 PTY 另覆盖 `40x20`、`80x8`、`80x24`、`120x36`、活动分支历史分页、Agent 单栏/双栏详情和 256 MB Session resize。

基于功能提交创建独立模拟 worktree，将最新 `upstream/main` `e47b8e37a` 合入。冲突只落在 `interactive-mode.ts`、`interactive-tui.test.ts` 和 `settings-selector.test.ts`，均来自上游新增 fullscreen exit output 与 LYStar 工作区输入测试占用同一段落；按双方语义合并后 `npm run check` 和 6 个聚焦测试文件共 38 项通过。模拟 branch、worktree 和独立依赖已删除，没有进入 `main`。

当前 Linux 环境没有 macOS 实机和 Windows Console/ConPTY 的交互证据；这两个平台只验证了格式、架构、归档、自动测试和 CI 平台链路。

`main` commit `f8c2b6da0a7b2abe5c939a47a80edec9c1d11fb0` 的 CI run `31241929548` 七个 job 全部成功。annotated Tag `v0.84.1-lystar.4` 的 Tag 对象为 `633a9405bd3e193d244512cc23d19b46695175df`，本地和远端解引用后均固定指向该 commit。

Release workflow run `31242031180` 成功，完成同 commit main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-08T05:37:10Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产。

公开 Linux x64 包 SHA-256 为 `0dc732644720fcf49f461a8b7581e90e2777e7d1533ee0bb7430ae94879fe176`，与公开 `SHA256SUMS`、manifest 文件大小和 SHA 一致；GitHub Attestations API 返回 1 条 in-toto provenance。

本机通过公开 `la update` 从 `0.84.1-lystar.3` 原子更新到 `0.84.1-lystar.4`，`current` 指向 `.4`，`previous` 保留 `.3`，再次更新显示已是最新版本。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 使用真实 `upstream/gpt-5.6-sol` 返回 `LYSTAR-0841-4-PROVIDER-OK`，随后 `/quit` 正常退出；`lystar-release-0841-4-installed-final` tmux server 已关闭。

### `0.84.1-lystar.3` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.3`，Pi workspace 包版本、Session、Agent Runtime、Tool 和 Extension API 均未变化。本版只修复 `/changes` 空文件列表的显示判断：只有 `loadingPath` 确实存在且等于选中文件路径时才显示 Diff 加载态，避免 `undefined === undefined` 将空工作区误判为加载中；修复提交为 `555046f`，新增空工作区回归测试。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新完成 `npm run check`、`npm run build:offline` 和全部发布 gate。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/398 项通过、1 项跳过；Coding Agent 227 个 files/1997 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查再次通过。

五平台候选包使用 Bun `1.3.9` 重新构建，`SHA256SUMS` 五项全部通过，manifest 版本为 `0.84.1-lystar.3`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`；格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。Linux x64 候选包 SHA-256 为 `4bdff0830437d121e3cc3578e01051d277ecb96b240792449ca3dbac04f1be1f`，其 `la --version` 与 `PI_OFFLINE=1 la --list-models` 通过。

最终 Linux x64 候选包在全新且干净的 Git 仓库中以 `80x24` tmux PTY 打开 `/changes`，稳定显示“工作区没有未提交变更”和“没有可审阅的文件”，不再显示“正在读取 Diff...”；`/quit` 正常退出，`lystar-release-0841-3-candidate` tmux server 已关闭。基于最终 `.3` 发布树创建独立 worktree，将上游 `upstream/main` `541ed488d89dbe11395e4c108f448e1e253ae4c1` 的 21 个 Tag 后提交执行 `--no-commit --no-ff` 合并，结果无冲突；合并后的 `npm run check` 和 4 个聚焦测试文件共 39 项通过，模拟 branch 与 worktree 已删除。

`main` commit `038b3afd1543ca4bfc7e2e5d1830d89f233ee49c` 的 CI run `31195963110` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows managed MinGit Bash 和 Windows PowerShell 5.1 安装器。annotated Tag `v0.84.1-lystar.3` 的 Tag 对象为 `3b33994713a2b8e9993fbfc3a17bbe02a871d360`，解引用后固定指向该 commit。

Release workflow run `31196208689` 成功，完成 main CI 绑定、版本校验、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-07T16:10:55Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产：五个平台包、`SHA256SUMS`、`release-manifest.json` 和三个安装器。

公开 Linux x64 包 SHA-256 为 `52889b5cb9bf2e945c2cdeccb3e53acccf5b7849c3ae6ccd7508f0f2d332d675`，与公开 `SHA256SUMS`、manifest 和 Release asset 一致；GitHub Attestations API 返回 1 条 Sigstore provenance，绑定 `.github/workflows/release.yml`、Tag `v0.84.1-lystar.3`、commit `038b3afd1` 和 run `31196208689`。公开包版本、离线模型列表和 manifest 仓库字段均通过。

本机通过公开 `la update` 从 `0.84.1-lystar.2` 原子更新到 `0.84.1-lystar.3`，`current` 指向 `.3`，`previous` 保留 `.2`，再次更新显示已是最新版本。安装后的 `/home/yean/.local/bin/la` 在干净 Git 仓库的独立 `80x24` tmux PTY 使用真实 Provider 返回 `OK3`，随后 `/changes` 稳定显示正确空态并正常退出；`lystar-release-0841-3-installed` tmux server 已关闭。

### `0.84.1-lystar.2` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.2`，Pi workspace 包版本和基线继续保持 `0.84.1` 与 `53fa77ccd8a279eb87e92294ef3687b03ff80112`。本版将全屏 TUI 调整为轻量任务工作台：活动条只消费真实 Agent/Tool 事件，完成摘要只在 `agent_settled` 后显示且不写入 Session，`/changes` 严格区分本轮 Edit/Write 文件与 Git 工作区变更；没有修改 Pi Session JSONL、Agent Runtime、Tool、Extension API、Provider、CLI 参数或 `PI_*` 契约。

CodeGraph 增量同步 11 个变更文件、637 个节点，`affected` 只指向 `lystar-workspace.test.ts` 和 `task-workbench-components.test.ts`。基于功能提交 `e63bd5d46` 创建独立模拟 worktree，将上游 `upstream/main` `541ed488d89dbe11395e4c108f448e1e253ae4c1` 的 21 个 Tag 后提交执行 `--no-commit --no-ff` 合并，结果无冲突；模拟合并后的 `npm run check` 和 4 个聚焦测试文件共 38 项通过。模拟 branch 与 worktree 已删除，没有进入 `main`。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和发布 gate。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/398 项通过、1 项跳过；Coding Agent 227 个 files/1996 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

源码构建在独立 tmux PTY 覆盖 `120x36`、`80x24` 和 `80x8`，验证真实 Faux Provider 的思考、Bash、Write、完成摘要、自动重试和取消事件，以及 `/changes` 的本轮/工作区切换和 `/changelog` Overlay；输入区和快捷栏在极小高度保持可见。本轮创建的所有 tmux socket 和临时 Faux 文件均已删除。

五平台候选包使用临时 PATH 中的 Bun `1.3.9` 构建，没有修改项目依赖。`SHA256SUMS` 五项全部通过，manifest 版本为 `0.84.1-lystar.2`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`，五个平台文件、大小和 SHA-256 一致；归档格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，全部包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。Linux x64 候选包 SHA-256 为 `daaa7cf59f204ee5cae0a3aa2a48898ff071e33e09fcd41cb96bc680d7355af6`，其 `la --version`、中文 `la --help`、`PI_OFFLINE=1 la --list-models` 和中文 `la auth --help` 均通过。

Linux x64 候选包在独立 `80x24` tmux PTY 打开 `/changes` 与 `/changelog`，再 resize 到 `80x8` 和 `120x36`，Overlay、顶栏、Composer 和快捷栏均正常；`/quit` 正常退出，`lystar-release-0841-2-candidate` tmux server 已关闭。当前 Linux 环境没有 macOS 实机和 Windows Console/ConPTY 的交互证据；这两个平台当前只验证了格式、架构、归档内容和自动测试，不能视为对应平台实机运行通过。

`main` commit `f9c9fb02323b3019e753a02ca70e2f32cde7399f` 的 CI run `31194116547` 七个 job 全部成功。annotated Tag `v0.84.1-lystar.2` 的 Tag 对象为 `90579650e0026ed38db2542fc69a867b3a7ae62c`，解引用后固定指向该 commit。Release workflow run `31194315795` 成功，GitHub Release 于 `2026-08-07T15:48:17Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产。

公开 Linux x64 包 SHA-256 为 `ac8308b4f06b6420f6b0a32ddb26258ad5960e8d8d8468384850444ef8229ab4`，与公开 `SHA256SUMS`、manifest 和 Release asset 一致；GitHub Attestations API 返回 1 条 Sigstore provenance，绑定 `.github/workflows/release.yml`、Tag `v0.84.1-lystar.2`、commit `f9c9fb023` 和 run `31194315795`。公开包的版本、中文帮助和离线模型列表通过。

本机通过公开 `la update` 从 `0.84.1-lystar.1` 原子更新到 `0.84.1-lystar.2`，`current` 指向 `.2`，`previous` 保留 `.1`，再次更新显示已是最新版本。安装后的真实 Provider PTY 返回 `OK`；随后在干净工作区打开 `/changes`，确认空列表错误持续显示“正在读取 Diff...”。Tag 与 Release 均按历史保留，本问题由后续 `0.84.1-lystar.3` 修复。

### `0.84.1-lystar.1` 发布前核验

上游基线已升级到 Pi `v0.84.1`（`53fa77ccd8a279eb87e92294ef3687b03ff80112`），双 parent merge commit 为 `c13f0ad935403042886d4e179e47febb8c1f6e0f`；LYStar 产品版本为 `0.84.1-lystar.1`，Pi workspace 包版本保持 `0.84.1`。合并保留 `la`、中文全屏工作区、`~/.pi/agent`、项目 `.pi`、`PI_*` 和 `octyean/lystar-agent` 契约，并接入 Qwen Token Plan Individual、`auth check`、blocked `tool_call` 的 `terminate` 结果、活跃运行期间拒绝 `Agent.reset()`、多击文本选择、半页滚动、Windows 全屏右键粘贴、低频鼠标追踪和 Bun cwd `bunfig.toml` 隔离。

离线模型目录完整取自正式 npm 包 `@earendil-works/pi-ai@0.84.1` 的 `dist/providers/data`，manifest 生成时间为 `2026-08-07T05:53:06.539Z`；新增 `qwen-token-plan-individual.json`，GitHub Copilot、OpenCode、OpenRouter 和 Vercel AI Gateway 快照同步更新。`models.generated.ts` 与 `image-models.generated.ts` 和 Pi `v0.84.1` Tag 字节一致，`npm run check:model-data` 通过，没有从实时 API 带入 Tag 之后的数据。

LYStar 全屏继续由 `LystarWorkspace` 管理虚拟历史。工作区输入入口同时识别旧 `app.viewport.*` 与上游新 `tui.altScreen.*` action id，覆盖 `Shift+PageUp/PageDown`、`Ctrl+Home/End`、`PageUp/PageDown`、`Home/End` 和可配置半页滚动；滚轮、点击、运行时 renderer 切换处理器迁移及 SGR `66/67` 横向事件保护保持不变。真实候选包 PTY 首次发现上游默认 `PageUp/PageDown/Home/End` 会被空的继承视口消费，修复后新增真实 renderer 回归覆盖滚轮、整页、半页、首尾和新旧快捷键。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部 workspace 测试。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/398 项通过、1 项跳过；Coding Agent 226 个 files/1986 项通过，6 个 files/49 项跳过。Telemetry 2 个 files/15 项、SQLite Session backend 11 个 files/81 项、Protocol 3 个 files/147 项、Client 6 个 files/36 项、Server 7 个 files/50 项、Evals 4 个 files/23 项全部通过。新增全屏输入定向回归 5 个 files/38 项通过；Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

五平台候选包使用 Bun 1.3.9 构建，`SHA256SUMS` 五项全部通过；manifest 的版本为 `0.84.1-lystar.1`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`，五个平台文件、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+；各归档包含对应 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 候选归档 SHA-256 为 `55dbc0dcb9229413cbb60251d0249e6fd34f44fa9fee8ca0285fe499e7ed0b5a`，其 `la --version`、中文 `la --help`、`PI_OFFLINE=1 la --list-models`、中文 `la auth --help` 和无凭据 `auth check --provider anthropic --no-refresh --json` 均通过。

最终 Linux x64 候选包在独立 `80x24` tmux PTY 加载长 Session：`PageUp` 与底部画面哈希不同，`PageDown` 精确回到底部；`Home` 跳到 Session 开头，`End` 精确回到底部；标准 SGR 滚轮、`Ctrl+U` 半页上移和 `Ctrl+D` 半页下移均产生预期画面。`80x8` 与 `120x36` 下顶栏、历史区、Composer 和快捷栏完整；`/settings` 完成全屏到普通再回全屏的双向切换，切回后的 renderer 继续接收滚轮并显示“下方还有 1 行”。双击 SGR 序列注入后进程保持正常，多击选择语义由 TUI 全量回归覆盖；`/quit` 返回码 0，`lystar-pi0841-candidate` 与 `lystar-pi0841-candidate-final` tmux server 均已关闭。

CodeGraph 在上游合并和 LYStar 适配后增量同步 95 个文件、2879 个节点；最终索引为 1186 files、19368 nodes、78069 edges，pending changes 0、`reindexRecommended=false`。`handleWorkspaceInput` 影响面落在构造、运行时模式切换和设置切换链路；affected 结果列出认证、凭据输出、真实 renderer 输入和 TUI wrapper 四个测试文件，均已包含在全量测试中。

`main` commit `298c396b6662342729f86128596bd0533269c350` 的 CI run `31161459499` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows managed MinGit Bash 和 Windows PowerShell 5.1 安装器。annotated Tag `v0.84.1-lystar.1` 的 Tag 对象为 `8925848f498f0a33d7d3dbfe1a4155d252891b3a`，解引用后固定指向该 commit。

Release workflow run `31161640992` 成功，完成 main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-07T08:26:46Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产：五个平台包、`SHA256SUMS`、`release-manifest.json` 和三个安装器。

公开 Linux x64 包 SHA-256 为 `957a33ec572de089ecdb04bd27e387cf7cb47b70a4783737874cb1e9023d200a`，与公开 manifest、`SHA256SUMS` 和 Release asset digest 完全一致；归档包含 `la`、Linux x64 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。GitHub Attestations API 返回 1 条 Sigstore provenance，证书绑定 `.github/workflows/release.yml`、Tag `v0.84.1-lystar.1`、commit `298c396b6` 和 run `31161640992`，subject 为同一 Linux x64 SHA-256。公开包的版本、中文帮助、离线模型列表和无凭据认证检查均通过。

本机通过公开 `la update` 从 `0.84.0-lystar.2` 原子更新到 `0.84.1-lystar.1`；`current` 指向 `versions/0.84.1-lystar.1`，`previous` 保留 `versions/0.84.0-lystar.2`，再次更新显示已是最新版本，`PI_OFFLINE=1 la --list-models` 通过。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 加载长 Session，`PageUp` 显示“下方还有 16 行”，`PageDown` 精确回到底部；全屏与普通模式双向切换后，滚轮仍显示“下方还有 1 行”，`/quit` 返回码 0，`lystar-release-0841-installed` tmux server 已关闭。

当前 Linux 环境没有 macOS 实机和 Windows Console/ConPTY 的交互证据；Windows PowerShell 5.1 安装器、Windows 启动和卸载链已由 main CI 验证。Node.js `v22.22.2` 仍低于 `@earendil-works/gondolin@0.12.0` 声明的 `>=23.6.0`，本轮构建和测试只有已知 engine 警告，没有行为失败。

### `0.84.0-lystar.2` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.0-lystar.2`，Pi workspace 包版本保持 `0.84.0`。`0.84.0-lystar.1` 的 LYStar 全屏工作区本身管理虚拟历史窗口，但继承的 `TuiAltScreen` 会先消费滚轮和视口快捷键；上游隐式 `ScrollView` 只看到一个刚好等于终端高度的 `LystarWorkspace`，没有可滚内容，真正的工作区输入处理因此收不到事件。运行时从普通模式切换到全屏时，旧 renderer 上注册的工作区监听也没有迁移到新 renderer。

当前修复把 `TuiAltScreen.handleViewportInput()` 调整为受保护的可覆写入口，由 `LystarTUI` 先委托 LYStar 工作区输入；工作区消费滚轮、翻页和实际命中的展开点击，其余鼠标事件继续交给上游文本选择、链接和 ScrollView，弹窗可见时也继续使用上游滚动。工作区处理器随 `createInteractiveTui()` 创建和运行时模式切换绑定，不再维护会丢失的外部 listener。新增真实 renderer 回归发送标准 SGR 滚轮序列 `ESC[<64;10;4M`，验证 30 行历史的首行从 `line-24` 移到 `line-23`；另一项断言确认普通模式切到全屏后同一输入处理仍然存在。

公开 `0.84.0-lystar.1` Linux x64 包加载 178K token 长会话后，发送 `ESC[<64;10;10M` 前后画面完全一致，稳定复现用户报告。修复后的源码构建和最终 `0.84.0-lystar.2` Linux x64 候选包使用同一会话、尺寸和输入序列，均上移一行并显示“下方还有 1 行”；发送滚轮下移后回到底部并恢复自动跟随，`/quit` 正常退出，`lystar-scroll-before`、`lystar-scroll-after-source`、`lystar-scroll-candidate-0840-2` 和 `lystar-scroll-candidate-final-0840-2` tmux server 均已关闭。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、TUI 全量、AI 103 个 test files/849 项、Agent Core 20 个 test files/392 项、Coding Agent 221 个 test files/1948 项和 Unix 安装器验证；AI 跳过 25 个 files/806 项，Agent Core 跳过 1 项，Coding Agent 跳过 6 个 files/49 项。定向回归另覆盖 Coding Agent 38 项，以及上游 `TuiAltScreen`、文本选择、链接、滚动条拖拽、嵌套 ScrollView 和终端模式恢复 26 项；SGR `66/67` 横向触控板事件保持为 `other`，不会被误判成纵向滚轮。

五平台候选包使用 Bun 1.3.9 构建，`SHA256SUMS` 五项全部通过；manifest 版本为 `0.84.0-lystar.2`，Pi 版本、仓库、文件名、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，Linux/Windows 归档包含对应 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 候选包的 `la --version`、`la --help`、`PI_OFFLINE=1 la --list-models` 通过，其 SHA-256 为 `1045222696837b79e2d07334b7e61338f48b09da40792c48e18c18411a4f928b`。

CodeGraph 在核心修复后增量同步 4 个文件、569 个节点，补充横向触控板判定后再同步 2 个文件、6 个节点；基于最新索引的 affected 结果准确指向 `packages/coding-agent/test/interactive-tui.test.ts` 和 `packages/coding-agent/test/mouse.test.ts`。最终索引为 1169 files、19130 nodes、84445 edges，pending changes 0、`reindexRecommended=false`。由于修改仍经过公共 `TuiAltScreen` 输入入口，本轮额外用 TUI、AI、Agent Core 和 Coding Agent 全量测试覆盖。

`main` commit `0e496a61efc917b91f65099b1fb0a35f56005d72` 的 CI run `31148814839` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows managed MinGit Bash 和 Windows PowerShell 5.1 安装器。annotated Tag `v0.84.0-lystar.2` 的 Tag 对象为 `329f7dc1d56bcc4d7231dc413a79190d8a0a7f19`，解引用后固定指向该 commit。

Release workflow run `31148934869` 成功，完成 main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-07T04:56:55Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产：五个平台包、`SHA256SUMS`、`release-manifest.json` 和三个安装器。

公开 Linux x64 包 SHA-256 为 `4ffb1f7bd286bd23252afa276ce54f78ca3c8c800488964d9396d318cf71965a`，与公开 manifest、`SHA256SUMS` 和 Release asset digest 完全一致；归档包含 `la`、Linux x64 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。GitHub attestations API 返回 1 条 Sigstore provenance，绑定 `.github/workflows/release.yml`、Tag `v0.84.0-lystar.2`、commit `0e496a61e` 和 run `31148934869`，subject 中包含同一 Linux x64 SHA-256。

本机通过公开 `la update` 从 `0.84.0-lystar.1` 原子更新到 `0.84.0-lystar.2`；`current` 指向 `versions/0.84.0-lystar.2`，`previous` 保留 `versions/0.84.0-lystar.1`，再次更新显示已是最新版本，`PI_OFFLINE=1 la --list-models` 通过。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 中加载同一 178K token 长会话，标准 SGR 上滚后画面移动并显示“下方还有 1 行”，下滚后恢复自动跟随，`/quit` 正常退出，`lystar-scroll-installed-0840-2` tmux server 已关闭。

当前环境没有 macOS 实机和 Windows Console/ConPTY 的鼠标滚轮交互证据；Windows 安装、版本启动和卸载链已由 main CI 的 Windows PowerShell 5.1 环境验证。

### `0.84.0-lystar.1` 发布前核验

上游基线已升级到 Pi `v0.84.0`（`a5f43bf8aff3c55752432655f7334e3dafd1e256`），LYStar 产品版本为 `0.84.0-lystar.1`，Pi workspace 包版本保持 `0.84.0`。合并保留 `la`、`LYStar Agent`、`~/.pi/agent`、项目 `.pi`、`PI_*` 和 `octyean/lystar-agent` 契约；上游 Harness v2、Telemetry、SQLite Session backend、Protocol、Client、Server、模型与 Provider 变更均已接入。离线模型目录来自正式 npm 包 `@earendil-works/pi-ai@0.84.0`，manifest 生成时间为 `2026-08-06T11:03:30.465Z`；`models.generated.ts` 和 `image-models.generated.ts` 与 `v0.84.0` Tag 字节一致，没有带入 Tag 之后的实时模型数据。

TUI 使用上游 renderer 分层：普通模式为 `TuiMainScreen`，全屏模式为基于 `TuiAltScreen` 的 `LystarTUI`。LYStar 全屏路径保留最后一列、绝对坐标重绘、500ms 完整校准、stdout backpressure、固定输入区、单行滚轮、鼠标和中文工作区；支持上游 `--tui-mode regular|fullscreen`，并兼容旧 `--alt-screen auto|always|never`、`--no-alt-screen` 与 `--mouse`。运行时可在设置中切换普通/全屏模式，稳定 TUI Proxy 会迁移 children、focus、terminal 和设置，不保留第二套 renderer。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部 workspace 测试。TUI 全量通过；AI 103 个 test files、849 项通过，25 个 files、806 项跳过；Coding Agent 1947 项通过；Agent Core 20 个 test files、392 项通过、1 项跳过；Telemetry 2 个 files、15 项通过；SQLite Session backend 8 个 files、77 项通过；Protocol 3 个 files、147 项通过；Server 7 个 files、50 项通过；Client 6 个 files、36 项通过；Evals 4 个 files、23 项通过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

源码构建在独立 tmux PTY 中覆盖 `80x24`、`80x8`、`120x36` resize；真实 TTY 验证 `/settings` 中文“界面模式”、普通/全屏双向切换和“全屏滚动条”设置。Linux x64 候选二进制在 `80x24` 全屏启动并通过 `/quit` 正常退出，终端模式得到恢复；本轮创建的 `lystar-pi0840-upgrade` 和 `lystar-pi0840-candidate` tmux server 已关闭。滚轮单行、鼠标协议、剪贴板查询与复制反馈由 TUI/Coding Agent 自动回归覆盖，本轮没有在交互式 tmux 中逐项手动注入鼠标和系统剪贴板事件。

五平台候选包使用 Bun 1.3.9 构建，`SHA256SUMS` 五项全部通过；manifest 的版本、Pi 版本、仓库、文件名、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，全部归档包含 `LICENSE`、`THIRD_PARTY_LICENSES.md`、可执行文件和对应平台 clipboard 包。Linux x64 归档的 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过，其 SHA-256 为 `e9b61a6f6f9636802a753e30f47f2195ae0729c393aea113f9daf837b6e4ef09`。

CodeGraph 已按 extraction version 24 完整重建到 1169 个文件、19126 个节点和 85027 条边，pending changes 为 0，`reindexRecommended=false`；核心 TUI、Agent、设置、凭据与 OpenAI Responses 入口共追踪 239 个依赖节点，列出的受影响测试均包含在本轮全量测试中。另复跑 12 个兼容测试文件、389 项，覆盖旧 `-c`/`-r` 参数解析、旧 settings、Session 迁移、Package、Skill、Extension 和 `pi-mcp-adapter` 配置读取。

`main` CI run `31143661232` 在 commit `da41aad352d20f08677ed3bbd793687abfb06030` 上全部成功，覆盖源码、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows MinGit Bash 和 PowerShell 5.1 安装器。annotated tag `v0.84.0-lystar.1` 指向同一 commit；Release workflow run `31143930706` 通过 CI 门禁、离线构建、五平台打包、版本校验、artifact attestation 和公开发布。Release 于 `2026-08-07T03:19:32Z` 发布，为正式非草稿版本；五个平台包、三个安装器、`SHA256SUMS` 和 manifest 共 10 个公开资产。

公开 Linux x64 包 SHA-256 为 `847b856d640d2ee8c17ea5c04075378fe501c3ce897ea4d39c87385e400332f5`，与公开 manifest、`SHA256SUMS` 和 GitHub Release digest 一致；GitHub attestations API 返回 1 条 Sigstore provenance，绑定 `release.yml`、Tag、commit 和 Release run。本机通过旧版 `la update` 从 `0.83.0-lystar.7` 原子升级到 `0.84.0-lystar.1`，`current` 指向新版本，`previous` 保留 `0.83.0-lystar.7`；再次更新显示已是最新版本。公开安装后的 `la` 在独立 `80x24` tmux PTY 中使用 `upstream/gpt-5.6-sol` 对“只回复：LYSTAR-0840-OK”返回精确结果 `LYSTAR-0840-OK`，随后 `/quit` 正常退出，本轮 socket 已关闭。

当前环境没有 macOS 实机，也没有 Windows Console/ConPTY 的交互式应用运行证据；Windows 安装、启动版本检查和卸载已由 GitHub CI 的 PowerShell 5.1 环境验证。

### `0.83.0-lystar.7` 发布前核验

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.7`，Pi 包版本保持 `0.83.0`。全屏工作区滚轮从按视口高度放大的每次 2 至 8 行改为固定 1 行；PageUp、PageDown、Home、End、鼠标协议、Pi 公共 TUI renderer、Session、Tool 和 Extension API 均未修改。回归覆盖 3、8、24、60 行视口，以及 500 行历史连续向下 80 次、向上 80 次滚动，每个事件均移动一行。

源码构建后的真实 tmux PTY 在 `80x24`、当前 SSH/tmux 的 `77x59` 和 `120x36` 下验证：一次滚轮事件只移出对话区顶部一行并从底部补入一行，终端高度不再改变速度。Linux x64 候选归档在 `80x24` 下从历史顶部滚动一次后，“下方还有 51 行”变为 50 行，`/quit` 正常退出；本轮创建的 tmux server、socket 和临时目录均已清理。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、TUI 全量、AI 96 个 test files 共 767 项、Coding Agent 192 个 test files 共 1742 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。Agent Core 的截断输出用例在四 workspace 并行时因资源竞争缺少末尾输出，单独全量复跑全部通过，没有持续断言失败。

五平台包使用 Bun 1.3.9 构建，`SHA256SUMS` 全部通过；manifest 的版本、Pi 版本、仓库、五个平台文件、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，全部归档包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。Linux x64 候选归档的 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过。CodeGraph 增量同步后，影响面收敛到 `LystarWorkspace` 和对应回归测试；Windows 与 macOS 本轮只完成归档格式、架构、SHA 和自动测试核验，没有对应系统实机运行证据。

### `0.83.0-lystar.6` 发布前核验

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.6`，Pi 包版本保持 `0.83.0`。`.5` 保留最后一个物理列只能避开自动换行触发条件，不能修复实际终端光标与 renderer 内部 `hardwareCursorRow` 失配。`.6` 让 LYStar fullscreen 使用固定视口路径：每个变更范围先按绝对行列清理，再按绝对行列写入；画面、Kitty 图片和硬件光标合并到同一个 synchronized-output 写入块；不发送换行、相对上下移动或 `CSI 2J`。每 500ms 的活跃渲染至少执行一次完整逐行覆盖，使外层终端丢失或错放中间帧后能在下一校准帧恢复。inline 模式继续走 Pi 原 renderer，消息事件、Workspace、Session、Tool 和 Extension API 未改。

确定性故障注入先在旧实现复现三项失败：把真实光标拨到第 1 行后，更新第 3 行会错误覆盖顶栏；外部覆盖顶栏后，同内容重绘无法恢复；画面与 IME 光标分两次写入。新路径对应回归全部通过，并覆盖 Kitty 图片先清占位行再绘制、越界组件的 ANSI 感知裁切、物理末列光标、overlay 安全宽度、`80x8 -> 120x36` resize 和 stdout 背压只保留最后一帧。

Linux 使用不经过 tmux 的真实 PTY 在 `80x8`、`80x24`、`120x36` 下各执行 120 次中文流式重排，并主动注入错误光标坐标和 `CORRUPT-HEADER`。每种尺寸均得到 31 个绘制帧和 3 次完整校准；ANSI 回放确认顶栏、最终内容、Composer 和快捷栏完整，污染文本消失，scroll buffer 未增长，所有文本绘制避开物理最后一列。独立 tmux socket 另完成 `80x24` 原始转发回放，以及运行中 `80x8 -> 120x36` resize；resize 后出现 3 个覆盖至第 36 行的完整帧，最终固定区域完整。真实 `tmux attach` 外层输出中，未变化的顶栏随校准帧重新发送了 3 次；在第 58 帧后只污染外层终端、不修改 tmux 内部画面，继续回放后顶栏、最终第 120 帧和固定底栏全部恢复。本轮 socket 已关闭。

OpenAI Responses 增加 opt-in 的托管 `web_search`：模型或 Provider 设置 `compat.supportsWebSearch = true` 后，请求附带 `tools: [{ type: "web_search" }]` 和 `web_search_call.action.sources` include；流结束时从搜索 action 与 URL citation 收集、规范化并去重来源，通过正常 text 事件追加到同一 AssistantMessage。`models.json` schema 已接通该字段，其他模型默认关闭。两项新增协议回归通过；最终离线构建使用本机 `upstream/gpt-5.6-luna` 做真实请求，正文返回 OpenAI 官方 Web Search 指南 URL，并收到完整来源列表。

`npm run check`、`npm run build:offline`、TUI 全量、AI 96 个 test files 共 767 项、Coding Agent 192 个 test files 共 1741 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器通过；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。五平台最终打包显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1`，SHA-256、manifest 版本/Pi 版本/仓库/资产大小、许可证和 executable 格式全部通过。Linux x64 候选归档的 `la --version`、`la --help`、离线模型列表通过；候选二进制在 `80x24`、`80x8`、`120x36` 下保留顶栏、Composer、模型状态和快捷栏，`/quit` 正常退出。安全重打包前后的 Linux x64 可执行文件 SHA-256 相同，本轮 tmux socket 已确认关闭。

CodeGraph 增量同步后，影响面收敛到 OpenAI Responses 参数/流处理、`models.json` compat、`TUI.doRender()`、`LystarTUI` 和四份受影响测试。与最新 `upstream/main = aa0ec808b970db31822e07835a46647cb51d9d66` 的临时 commit 合并预演显示：上游新增 `TuiBase/TuiAltScreen` 重构已使当前 HEAD 存在基线冲突；本轮把回归放入独立测试文件后，没有增加冲突文件。上游 alt-screen 同样采用绝对行地址，但目前仍使用 `CSI 2J` 且没有周期自校准，后续升级需将本轮减一列和校准规则移植到该 renderer。当前环境没有 Windows Console/ConPTY、macOS cmux 客户端实机证据；应用能保证后续完整帧恢复，不能保证第三方终端直接丢弃整次写入时该单帧完全不闪。Windows 和 macOS 本轮只完成归档格式、架构、SHA 和自动测试核验。

### `0.83.0-lystar.5` 发布前核验

本版针对普通终端和 Windows Console/ConPTY 一类终端的右边界滚屏，在 `LystarTUI` fullscreen 下保留最后一个物理列，基础帧和 overlay 使用同一安全宽度。该措施消除了满宽自动换行这一触发条件，并通过 Linux PTY 验证；后续 cmux/SSH/tmux 新会话仍复现坐标漂移，证明它不能修复相对坐标 renderer 的内部光标账本失真，完整修复见上方当前未发布记录。inline 模式仍使用完整宽度并保留现有自动换行生命周期。

Pi 公共 TUI renderer 只增加一个默认返回 `terminal.columns` 的受保护渲染宽度入口，并在 `doRender()` 使用该入口；默认行为、`Terminal` 接口、差量算法、Session、Tool 和 Extension API 均未改变。LYStar 的减一列策略留在自身维护文件，上游合并影响限制在公共 TUI 的一个方法和一行取值。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.5`，Pi 包版本保持 `0.83.0`。使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、TUI 全量、AI 95 个 test files 共 765 项、Coding Agent 192 个 test files 共 1739 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。

Linux 使用 `script(1)` 创建不经过 tmux 的真实 PTY，在 80x8、80x24 和 120x36 下分别连续执行 120 次中文流式更新。原始 ANSI 逐帧回放得到 41、42、42 个绘制帧：三种尺寸均未使用物理最后一列，alternate screen 滚屏为 0，重复段落为 0 帧，输入框缺失为 0 帧。Linux x64 候选归档的 `la --version`、`la --help`、`PI_OFFLINE=1 la --list-models` 通过；候选二进制在 80x24、80x8、120x36 真实 PTY 中保留 Composer、模型状态和快捷栏，`/quit` 正常退出。

五个平台归档的 SHA-256、manifest 版本与仓库、资产大小、许可证和 executable 格式通过。CodeGraph 增量同步与 affected 检查完成；`LystarTUI` 调用入口仍只有 `InteractiveMode`，影响面覆盖流式消息、Tool、状态、Extension UI、overlay、resize 和退出生命周期。临时 PTY 文件与本轮 tmux socket 已清理；macOS 和 Windows 只完成归档格式、架构和自动测试核验，没有对应系统实机运行证据。

### `0.83.0-lystar.4` 发布前核验

本版为 Provider 流阶段失败补充结构化 `provider_stream_failure` 诊断，覆盖 Responses `response.failed`、流内 `error`、提前 EOF 和迭代读取异常。自动重试先排除鉴权、配额、参数、上下文、模型和策略等永久错误，再按结构化诊断处理未来未知流错误；默认最多重试 5 次，间隔为 1s、2s、4s、8s、16s。文本兼容分类中的 `ended without` 收紧为 `stream ended without`，避免确定性的 Provider 协议错误耗尽 31 秒重试预算。

Release workflow 会等待同一 commit 的 main push CI 完成，成功后继续发布，失败则阻止；Node 固定为 `22.19.0`，npm 参数与 main CI 对齐，Checkout、Node、Bun 和 attestation Action 固定到明确 commit。Tag 与源码版本在安装依赖前校验，产物版本在打包后再次校验。真实成功 CI run `30688818708` 可通过门禁，真实失败 run `30688294491` 被阻止。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.4`，Pi 包版本保持 `0.83.0`。`npm run check`、`npm run build:offline`、TUI 全量、AI 95 个 test files 共 765 项、Coding Agent 192 个 test files 共 1738 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器通过；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。

五个平台归档的 SHA-256、manifest 版本与仓库、资产大小、许可证和 executable 格式通过。Linux x64 候选包的 `la --version`、`la --help`、`PI_OFFLINE=1 la --list-models` 以及 80x24、80x8、120x36 真实 PTY 通过，本轮 tmux socket 与临时依赖目录已清理；macOS 和 Windows 只完成归档格式、架构和自动测试核验，没有对应系统实机运行证据。

### `0.83.0-lystar.3` 发布前核验

本版包含 `0.83.0-lystar.2` 的 TUI 信息层级与 Windows 一键安装修复，并修正 Release 五平台打包的依赖物化方式。旧脚本在根 monorepo 已执行 `npm ci` 后再次运行 `npm install --force`，GitHub runner 自带的 npm `10.9.8` 连续触发 Arborist `edgesOut` 内部异常。当前脚本把六个平台的 clipboard 原生包安装到独立临时目录，归档直接从该目录取对应平台文件，不再改写根 `node_modules`；成功、失败和退出都会清理临时目录。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.3`，Pi 包版本保持 `0.83.0`。npm `10.9.8` 与 Bun `1.3.9` 已完成 Windows x64 单平台打包回归，zip、manifest 和临时目录清理通过。使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新完成 `npm ci --ignore-scripts`、`npm run check`、`npm run build:offline`、TUI/AI/Coding Agent/Agent Core 全量测试、Unix 安装器和五平台离线打包。

结果：TUI 全量通过；AI 95 个 test files、755 项通过，25 个 files、784 项跳过；Coding Agent 192 个 test files、1736 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。五个平台归档的 SHA-256、manifest 版本与仓库、资产大小、许可证和可执行格式全部通过；Windows zip 包含 `clipboard-win32-x64-msvc` 平台包及正确的 `.node` 文件。Linux x64 归档的版本、帮助、离线模型列表和 80x24、80x8、120x36 真实 PTY 通过，本轮 tmux socket 与临时目录已清理。

### `0.83.0-lystar.2` 发布前核验（未创建 Release）

本版调整 TUI 信息层级：顶栏按宽度保留产品、项目、分支、会话和上下文，用单行摘要替代启动资源墙，用户消息增加任务轨道，Composer 集中展示模型、思考强度和项目可信状态，快捷操作与累计用量合并为单行。主题文件、Pi 公共 TUI renderer、Session、Tool 和 Extension API 均未修改。

Windows 一键安装入口增加 60 秒超时、三次重试和 MB 大小提示；PowerShell 安装器改从 `release-manifest.json` 获取版本、Windows 资产与预期大小，下载后同时校验大小和 SHA-256。托管 MinGit 下载也按 MB 显示。Windows CI 已改为物化当前安装器后真实执行安装、`la --version` 和卸载，并在结束时恢复用户 PATH。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.2`，Pi 包版本保持 `0.83.0`。使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量通过；AI 95 个 test files、755 项通过，25 个 files、784 项跳过；Coding Agent 192 个 test files、1736 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。静态检查、离线构建和 `git diff --check` 通过。

五个平台归档的 SHA-256 全部通过，manifest 的版本、Pi 版本、仓库、文件大小和五个平台资产一致；归档均包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。产物格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。Linux x64 归档的 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过；发行包真实 PTY 覆盖 80x24、80x8、120x36 resize 和 `/quit` 退出恢复，本轮 tmux socket 与临时目录已清理。Windows PowerShell 5.1 的真实安装、启动和卸载由 main push CI run `30688225986` 执行并通过。

Tag `v0.83.0-lystar.2` 已推送且保持不可变；Release workflow run `30688294491` 在五平台打包阶段连续两次触发 npm `10.9.8` Arborist `Cannot read properties of null (reading 'edgesOut')`，版本校验、attestation 和资产发布均未执行，GitHub Release 未创建。修复进入新的 `0.83.0-lystar.3`，不移动或复用 `.2` tag。

### `0.83.0-lystar.1` 发布前核验

上游基线已升级到 Pi `v0.83.0`（`845d6ff1f6643aba440341cce877ce1c43ebbc39`），上游 merge commit `87fe99f9` 的第二个 parent 为该 commit。LYStar 保留 `la` 命令、中文产品配置、全屏 TUI、Session/Extension/Tool 契约和 `octyean/lystar-agent` 发行源，并合入凭据导出、OpenRouter 远程登录、请求级 `fetch`、`rawStopReason`、`ctx.scopedModels`、Session 重绑保护、并发 Bash 取消和 Resource Loader 修复。发布事实源为 `piConfig.productVersion = 0.83.0-lystar.1`，Pi 包版本为 `0.83.0`。

使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量退出码 0；AI 95 个 test files、755 项通过，25 个 files、784 项跳过；Coding Agent 192 个 test files、1733 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。`main` CI run `30498563387` 全部通过，覆盖源码、构建、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows MinGit Bash 和 PowerShell 5.1 安装器。

五个平台归档的 SHA-256 全部通过，manifest 的版本、Pi 版本、仓库、文件大小和五个平台资产一致；全部归档包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。从 Linux x64 归档运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过；真实 PTY 覆盖 80x24 启动、80x8 和 120x36 resize、无模型提示和 `/quit` 退出恢复。本轮独立 tmux socket 与临时文件已关闭并清理。Windows 与 macOS 以 CI、归档格式、架构和 SHA 为证据，未做对应系统的二进制实机运行。

### `0.82.1-lystar.11` 发布前核验

本版将全屏历史区改为有界双向滑动窗口，只保留视口前后缓冲区；离开窗口的渲染块会释放，主题等全局失效在历史块再次进入窗口时执行。顶栏上下文用量改为按 Session、消息数量、模型和完成事件刷新，不再随每个 TUI 帧扫描完整会话。Pi 的 TUI renderer、Session、Tool、Extension API 和存储格式未修改。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.11`。以下 gate 通过：

```bash
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1696 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。五个平台归档的 SHA-256 全部通过，manifest 的版本、Pi 版本、仓库和五个平台资产一致；macOS ARM64/x64、Linux ARM64/x64、Windows x64 格式正确，全部归档包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 包通过 `--version`、`--help` 和离线模型列表 smoke。

确定性回归使用 5000 个历史组件验证：跳到首屏和深度滚动后的单帧只读取少于 200 个组件；可从首屏连续翻到 `message-4999` 并恢复 following；全局失效只刷新可见窗口；离开窗口的块缓存会释放。顶栏上下文用量在状态未变化的连续帧只计算一次。

最终 Linux x64 二进制使用 16 MB、3346 条记录的真实 Session 在 PTY 验证：100x30 同机对照中，`.10` 跳到历史开头为 167ms，当前实现为 46ms；最终 `.11` 包在 80x24 下跳顶为 40ms，连续 120 次翻页与输入在 703ms 内完成，120x36 resize 后输入框、Footer 和快捷栏完整，tmux `history_size=0`。本轮独立 socket 和临时 Session 已关闭并清理。

CodeGraph 增量同步和 affected 检查完成，影响面收敛到 `LystarWorkspace`、Interactive 顶栏组合逻辑及两个对应测试文件。上游 Pi 公共包和协议没有变化。

### `0.82.1-lystar.10` 发布前核验

本版将同轮 Bash 命令组改为执行期间展开、全部结束后自动折叠，并为折叠摘要补齐块间距；上下文压缩触发续跑时恢复“正在执行...”状态和终端 progress。Session 格式、Agent 行为、Tool 协议与 Extension API 保持原样。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.10`。以下 gate 通过：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1692 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。五个平台归档的 SHA-256 全部通过，manifest 版本、Pi 版本、仓库和五个平台资产一致；格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。

Linux x64 发行包使用真实历史 Session 在 100x30 PTY 验证：4 条已完成 Bash 命令默认折叠为 `4 条命令执行完成`，摘要前后保留空行，点击摘要后 4 条命令全部展开。本轮 tmux socket 和临时 Session 已关闭并清理。

五平台打包会物化发行依赖，不能与读取根 `node_modules` 的 Vitest 并行。一次并发尝试导致 Vitest worker 短暂缺少 `vite/module-runner` 等文件，并使 Agent Core 50ms 超时用例在资源竞争下失败；重新执行 `npm ci --ignore-scripts` 后，Coding Agent 和 Agent Core 单独全量复跑均通过。后续可并行各测试 workspace，但发行打包必须放在测试之后。

### `0.82.1-lystar.9` 发布前核验

本版修复 `/resume` 选择器获得焦点后不可见、长 Session 首帧同步物化全部历史、Session 切换继承旧滚动状态、普通 Tool 消息紧贴和图片剪贴板在 SSH/tmux 中失效的问题。Session 格式、Agent 行为、Tool 协议、Extension API 与 `PI_*` 契约保持原样。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.9`。使用 Node.js 22.22.2、npm 11.11.0、Bun 1.3.9 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：静态检查、离线构建和 Unix 安装器通过；TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1691 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过。

真实 PTY 使用 16 MB、3327 条消息的 Session 验证：`/resume` 列表 251ms 内出现，选择后 368ms 内显示历史尾部和继续提示；首帧只物化当前视口尾部，向上翻页可渐进加载旧历史。100x30 下普通 `read/edit/write/bash` Tool 之间保留一行间距，alternate screen 的 `history_size` 保持 0。

图片粘贴保留 native、Wayland、X11 和 WSL 后端，并新增 Kitty OSC 5522 MIME 查询、分片合并、50 MB 上限与 tmux passthrough。协议单测覆盖 MIME 列表、图片优先级、分片、无匹配类型、tmux 包装和输入隔离；真实 SSH/tmux PTY 注入 OSC 5522 响应后，输入框出现临时 PNG 路径且文件字节正确。无可用后端时显示可操作的中文提示，不再静默吞掉失败。

五平台包使用 Bun 1.3.9 构建，五个归档的 `SHA256SUMS` 全部通过；manifest 的版本、Pi 版本、仓库、文件、大小和 SHA-256 一致；归档均包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。格式核验覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。

从 Linux x64 归档运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过。发行包真实 PTY 覆盖 80x24 启动、80x8 和 120x36 resize、OSC 5522 图片粘贴、固定输入区、退出恢复和 `history_size = 0`；本轮独立 tmux socket 与临时文件已关闭并清理。Windows 与 macOS 仍以自动测试、归档格式、架构和 SHA 为证据，不宣称本地实机运行。

CodeGraph 在修改后完成增量同步；`queryTerminalClipboard` 影响面收敛到 TUI 协议处理、`handleClipboardPaste` 和对应测试，Tool 间距影响实时事件与历史重建两条渲染路径。

### `0.82.1-lystar.8` 发布前核验

本版完成 CI 并行拆分、长会话块缓存、Footer 用量缓存、自适应滚动、结构化 Composer、上下文快捷栏、Windows 内置安全字符、同轮 Bash 命令组和 TPS 中文化。Session、Tool、Extension、Provider 与 `PI_*` 契约保持原样。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.8`。以下 gate 在该版本号下通过：

```bash
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
```

结果：TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1688 项测试通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器完整链路通过。

五平台产物使用 Bun 1.3.9 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新构建。五个归档的 `SHA256SUMS` 全部通过；manifest 版本、Pi 版本、仓库、平台文件、大小和 SHA-256 一致；归档均包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。格式核验覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。

从 Linux x64 归档解压后，`la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过。真实 PTY 覆盖 80x24 输入、80x8 Bash 运行状态与动态 `Esc 取消`、120x36 resize 和退出恢复；本轮独立 tmux socket 已关闭。Windows 安全字符分支通过自动测试，Windows 与 macOS 仍以 GitHub runner、归档格式和架构为证据，不宣称本地实机运行。

静态检查与离线构建：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
```

Coding Agent 全量测试：

```bash
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
```

结果：184 个 test files 通过、6 个跳过；1672 项测试通过、48 项跳过。Token 请求前保护、连续 Tool Result 压缩切点、托管 Bash Shell 解析和既有 Session/Extension 链路均已覆盖。

README 与中文文档：

- 根 README 已改为普通用户入口，明确独立发行包无需 Node.js，Unix 安装命令使用 Bash。
- `docs/` 已拆分安装、快速开始、Provider、中国大陆网络、TUI、Session、配置、更新、生态、排障和开发文档。
- 一次性 Node 链接检查覆盖 README 与 `docs/` 共 24 个 Markdown 文件，本地链接目标全部存在。
- 最终用户文档未发现残留 `pi install`、`pi update` 或 `install.sh | sh` 命令。
- README 使用当前源码、隔离配置和本地假 Provider 在 120x30 真实 PTY 中生成的 1280x680 PNG；Playwright 截图后已关闭本轮浏览器和 tmux 会话。

TUI 全量测试：

```bash
npm --workspace @earendil-works/pi-tui test
```

结果：退出码 0。包含 alternate screen、SGR mouse 和 reduceMotion 新增回归。

AI 全量测试：

```bash
npm --workspace @earendil-works/pi-ai test
```

结果：89 个 test files 通过、25 个跳过；670 项测试通过、783 项跳过。

Agent Core 全量回归：

```bash
npm --workspace @earendil-works/pi-agent-core test
```

结果：18 个 test files、240 项测试通过，1 项跳过。`preserves truncated output when a command times out` 改为使用 Bash 内建 `printf` 一次生成 3000 行，再保留真实 50ms 超时和完整输出首尾断言；该用例连续复跑 10 次通过，Agent Core 全量回归通过。

Unix 安装器安装、PATH、校验失败、回退、卸载和用户数据保留：

```bash
bash scripts/test-install-sh.sh
```

结果：本地假 Release 分别通过 curl 和仅 wget 下载，latest manifest 版本解析、SHA-256、executable smoke、PATH 幂等写入、`--no-path-update`、坏 SHA 拒绝、回退、卸载和 release materialization 全部通过。该测试不访问网络，已加入 CI 与 Release workflow。

Windows 安装器源码继续保持 UTF-8 BOM 和 CRLF；`0.82.1-lystar.7` 修复托管 MinGit staging 自检遗漏自身 PATH 的问题。自检现在显式加入 `cmd`、`mingw64/bin` 和 `usr/bin`，并先确认 `where.exe git.exe` 的首个结果位于托管目录。Windows 集成 gate 会移除 runner 预装 Git 后并发准备 MinGit，避免系统 Git 再次遮住缺陷。

Release workflow 在 tag 触发后通过 GitHub Actions API 核对同一 commit 已有成功的 `main` CI，且该 run 必须来自 `main` push；核验后只执行依赖安装、离线构建、五平台打包、版本校验、attestation 和发布，不再重复全量测试与 Windows 集成 gate。API 查询已用 `0d684429` 的成功 CI 验证返回 1 条。

五平台独立发行包：

```bash
bash scripts/build-binaries.sh --offline-model-data
cd packages/coding-agent/binaries
sha256sum -c SHA256SUMS
```

结果：`0.82.1-lystar.6` 的 macOS ARM64/x64、Linux ARM64/x64、Windows x64 五个压缩包全部校验通过。`release-manifest.json` 的版本、Pi 版本、仓库、五个平台文件、大小和 SHA-256 与产物一致；归档包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 包已实机运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models`；Windows x64 executable 已核对为 PE32+ x86-64。

真实 PTY 使用独立 tmux socket 和临时工作目录验证：

- 120x36 首次启动显示中文主题选择。
- 120x36 主界面显示固定顶栏、独立对话区、输入区和快捷栏。
- 顶栏持续显示工作目录、Git 分支、会话名和上下文占用；Footer 删除重复的工作目录与会话名。
- Footer 只占一行，使用中文标签和大写 `K/M/B`，不再显示 `↑/↓/R/W/CH`；完整输入量与 `/session` 口径一致，缓存读取和缓存写入作为输入细分项按宽度显示。
- 使用包含 8 次压缩的真实 Session 快照验证 58x20 Footer 显示 `输入 276M · 输出 595K · 缓存读取 271M · 本次命中 99.5%`，顶部上下文显示 `242K/272K`。
- 80x8 同时保留单行 Footer、单行 Extension 状态、三行输入框和单行快捷栏；58x20 快捷栏显示 `Shift+Tab 思考强度 │ Esc 取消 │ Ctrl+O 展开 │ /`，不再换行。
- 多 Provider 时 provider、模型、双语思考强度和信任状态统一显示在 composer 边框，分隔符使用紧凑的 ` · `；`/session` 标题为 `Token 用量（会话累计）`。
- Shell 执行图标改为 `$`；折叠状态点击摘要任意位置可展开，展开后点击输出中间行可收起。Shift+点击输出行保持展开并交给终端文字选择。
- 三行输入时 `❯` 位于中间行；单行和多行输入都保持稳定边框。
- `high` 显示为 `高(high)`；默认展开模型返回的思考过程正文，用户仍可主动折叠。
- 80x24 下连续执行 Bash、创建、编辑和读取操作，成功结果各占一行；点击摘要可展开，点击已展开内容的任意行可收起。
- 58x20 移动端宽度下，20 行 Shell 输出默认保持一行摘要，输入区、Footer 和 `Esc 取消` 快捷提示保持可见。
- Markdown 代码围栏默认隐藏，长代码行换行后每行保留左侧 `│`；`/settings` 可搜索并切换“Markdown 代码围栏”。
- 80x8 下叠加 10 行 Extension Widget，输入框与快捷栏仍保留最后 4 行，附加状态只使用剩余空间。
- `/settings` 显示中文设置名、中文枚举值、Markdown 围栏开关和明确的搜索提示。
- `/session`、`/hotkeys`、分支、压缩、登录、Shell 状态和常见错误使用中文界面文案。
- resize 后布局保持终端总行数，无控件重叠或进程退出。
- 从 `0.82.1-lystar.5` Linux x64 发行包启动 80x24 真实 PTY，输入框、项目信任、快捷栏和退出恢复正常。
- README 截图使用本地 OpenAI 兼容假 Provider 完成一轮中文问答，不读取真实认证、不消耗真实模型额度；图片中文字、上下文、输入框、累计用量和快捷栏无裁切。
- 生态资源在独立 `PI_CODING_AGENT_DIR` 中核验：`@tintinweb/pi-tasks@0.7.2` 安装、`/tasks`、更新和卸载通过，上游 191 项测试通过；`badlogic/pi-skills` commit `90bb51c` 的 8 个 Skill 均被发现并进入 `/skill:` 补全。
- `pi-sandbox@0.6.1` 安装和加载成功，但真实启动因当前环境缺少上游 README 未列出的 `socat` 而未启用，已明确放入未通过清单，没有作为已适配资源推荐。
- Windows 安装器源码和物化资产都以 UTF-8 BOM `EF BB BF` 开头；CI 与 Release 保留 Windows PowerShell 5.1 `Parser.ParseFile` gate。
- Skill 引用局部测试 6 项通过：`$` / `@`、部分名称、显式方括号、文件候选共存、多 Skill 顺序去重、普通环境变量和失效引用均已覆盖。
- 上下文上限回归已用 `215K Provider usage + 大段中文新增内容` 和连续大 Tool Result 形态覆盖。Provider usage 作为历史锚点，新增内容按 UTF-8 bytes/3 轻量估算并触发请求前压缩；估算不再作为 Provider tokenizer 的绝对事实，只有不可拆增量本身达到窗口才本地停止，其余真实 overflow 保留压缩和单次重试。连续 Tool Result 超预算时回到最后一个合法 Assistant Tool Call 切点，手动 `/compact` 才能继续的故障已进入自动回归。
- subagent 已作为隐藏内建 Extension 编入 Coding Agent，三个内建 Agent、项目覆盖和外部同名 Extension 后备优先级测试通过；Coding Agent 全量 1670 项通过。
- Linux x64 独立二进制成功编入 3168 个模块，`--version`、`PI_OFFLINE=1 --list-models`、归档 SHA-256 和真实 PTY 通过。80x8 保留输入框、Skill 候选和快捷栏，120x36 下 `$` Skill 与 `@README` 文件补全均正常。
- Windows Release 保留 `install.cmd` 和 PowerShell 5.1 parser gate，并新增托管 MinGit `2.55.0.3`：npmmirror 优先、Git for Windows 官方 Release 回退、固定 SHA-256、staging 自检、原子替换、跨进程锁和 `PI_OFFLINE=1` 禁止隐式下载。Windows CI 会并发启动两个准备进程，再验证 Bash 专属语法、Git、grep/sed/awk/find、中文空格路径和重复检查。

## 发行产物

目录：`packages/coding-agent/binaries/`

```text
lystar-agent-v<version>-darwin-arm64.tar.gz
lystar-agent-v<version>-darwin-x64.tar.gz
lystar-agent-v<version>-linux-arm64.tar.gz
lystar-agent-v<version>-linux-x64.tar.gz
lystar-agent-v<version>-windows-x64.zip
```

同时生成 `SHA256SUMS`、`release-manifest.json`、`install.sh`、`install.ps1`、`install.cmd` 和 `VERSION`。

## 已知限制

Pi `v0.82.1` 发布基线的完整 `npm test` 已通过。本轮 AI 670 项、Agent Core 241 项和 Coding Agent 1672 项通过；Agent Core 的 50ms 命令超时用例已移除逐行 shell 循环的负载依赖，连续 10 次局部回归和最终全量回归均通过。

本轮 `0.82.1-lystar.8` 发布仍以 GitHub Windows x64 runner 在移除预装 Git 的 PATH 后通过真实 npmmirror 下载、固定 SHA、自检、并发锁和命令集 gate 作为打 tag 前置条件。尚未覆盖 Windows ARM64；macOS 归档继续只有构建、格式、架构和 SHA 证据，没有 macOS 实机安装证据。

当前环境的 `/tmp` 是 tmpfs，Bun 1.3.9 把 `--compile` 输出直接写入该目录时会产生同尺寸全零文件；改用项目所在 ext4 临时目录后生成正常 ELF。正式构建默认输出到仓库 `packages/coding-agent/binaries/`，不受这个本地 tmpfs 限制。

`npm audit --audit-level=high` 仍报告 3 个上游 high severity 告警：`brace-expansion`、`postcss` 和 `shell-quote`。`@earendil-works/gondolin@0.12.0` 仍要求 Node.js `>=23.6.0`，当前验证环境为 Node.js 22；本轮没有脱离 Pi `v0.82.1` 依赖基线单独执行 `npm audit fix`。
