# Rust TUI M8 Composer 与运行状态核验

核验日期：2026-08-16。M8 在 Linux x64 完成本地硬验收；范围限于 GUI Protocol、GUI Host、`lystar-protocol` 和 `lystar-tui`，未修改 `packages/agent`、`packages/tui` 或 InteractiveMode 语义。

## 完成内容

- Protocol 增加 `steer`、`follow_up`、`clear_queue` 请求，以及受限的 `SessionProgress` 联合类型。Session snapshot 暴露活动状态、steering 队列数和 follow-up 队列数。
- Host 只在 `CoreRuntimeSession` 通过公开 `AgentSession` 方法调用 `steer`、`followUp`、`clearQueue`。运行时事件投影成受限进度；未知事件退化为最长 1024 字节的状态文本，不透传原始事件负载。
- 队列命令进入既有 operation journal，响应写出后再开始执行。相同 client request ID 与 payload 的重试复用同一 operation，不会重复执行。
- Rust Protocol 不再用 Typify 的顶层 event 联合体解码 Server wire；该生成类型会拒绝合法的 `session_progress.status`。现在先校验受限 envelope，再由只读投影解析字段；新增 TypeScript 编码的 status golden frame，避免运行中状态使 TUI 退出。
- Rust TUI 使用固定底部 Composer，支持 UTF-8 grapheme 编辑、多行、光标移动、删除、粘贴、64 KiB 输入上限、200 条历史、100 步 undo/redo。Enter 根据运行状态发出 `prompt` 或 `steer`，Alt+Enter 发出 `follow_up`，Esc/Ctrl+C 中止活动 operation。
- 实时 assistant/thinking/tool 进度保存在 Rust 状态中；Tool 以 `toolCallId` 关联，最终 transcript commit 不会由进度层重复追加。

## B3 设置、模型、认证、会话与分支工作台

- Ctrl+P 命令面板及精确 slash 拦截已接入 `/settings`、`/model`、`/thinking`、`/login`、`/sessions`、`/tree`；带额外文本或后缀的 slash 不会被截获，仍作为普通 prompt。
- 会话 Overlay 由 Host 的 `list_sessions`、`create_session`、`rename_session`、`delete_session`、`fork_session`、`acquire_session`、`release_session` 驱动。切换严格按 release old lease -> acquire target 执行；目标获取失败时重新获取原会话并恢复 transcript、editor、scroll 和 overlay，失效 generation 的响应不会写入新会话。
- 新建会话先由 Host 创建并获取新租约，再释放旧租约；旧租约释放失败时释放新租约并恢复原会话。删除当前会话先释放租约、再删除、最后获取另一会话；删除失败时会重新获取原会话。退出 TUI 时会释放当前租约。
- `v` 打开的只读会话视图只调用 `read_transcript`，使用独立 `TranscriptWindow` 保存分页和滚动，不 acquire、不 `ensureRuntime`，也不修改主会话。
- Tree Overlay 使用 `get_session_tree`、`set_entry_label`、`navigate_session_tree`：支持输入筛选、标签编辑、带确认的摘要跳转、从选中记录分叉，以及 `n` / `p` 在标签间跳转。
- Rust 只消费 Host 返回的 B3 descriptor/result：设置包含显示值、整数边界、scope、只读和重启标记；模型包含认证可用性、推理能力和支持的思考级别；Provider 包含认证方式。Rust 不读取 settings/auth/model 文件，也不持久化认证输入。
- 设置支持布尔切换、枚举选择、整数边界校验、字符串编辑和只读拦截；所有写入经既有 session/host operation journal，并保留原始 B3 payload 以便超时后按 `r` 重试。同一 `clientRequestId` 的重试不会重复执行 Host 写入。
- 模型切换与思考强度使用 `set_session_model`、`set_session_thinking`；未认证模型仍显示，但不能选择。思考级别以中文显示，并按当前模型 capability 禁用不支持的选项。
- 登录先选择 Provider 与认证方式，再通过 Host `ui_request` 依次桥接 select、input/secret、notify、confirm。select option 优先返回 `value`、其次 `id`，展示 `label` 与 `description`；`editor` 使用既有文本编辑器。`notify` 只显示受限的认证链接、设备码或进度详情，并在 Rust 本地按请求 ID 仅确认一次，不建立 pending UI request 或取消认证；设备码可通过 Host journal 化的 `write_clipboard_text` 复制。密文编辑器仅渲染掩码，认证值只通过单次 `ui_response` 交给 Host。

## Rust 工作台 Overlay 基础

- Overlay stack 提供 List、Detail、TextEditor、Confirm 四个原语，打开时保存 composer 焦点，关闭或断连后恢复；支持 toast、错误、pending request generation 和 stale response 丢弃。
- Ctrl+P 命令面板接入 `/help`、`/about`、`/doctor`、`/settings`、`/model`、`/thinking`、`/login`、`/sessions` 与 `/tree`。前者本地显示；`/about`、`/doctor` 和工作台数据经 typed B3 或 Host 会话协议校验后渲染。
- Host 事件 `ui_request` 通过 `ui_response` 桥接 select、confirm、input、secret、editor；认证 `notify` 直接显示本地受限详情，未知 kind 才返回 cancelled，不让请求悬挂。

## 验证命令

```bash
npm --workspace @lystar/code-gui-protocol exec vitest -- --run test/protocol.test.ts
npm --workspace @lystar/code-gui-host exec tsc -- -p tsconfig.build.json --noEmit
npm --workspace @lystar/code-gui-host exec vitest -- --run test/runtime-adapter.test.ts test/operation-journal.test.ts
npm --workspace @lystar/code-gui-host exec vitest -- --run test/rust-tui-e2e.test.ts
npm run check:rust-spike
npm run benchmark:rust-m8
npm run benchmark:rust-m8:verify
node --test scripts/verify-rust-m8-benchmark.test.mjs
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo test --example benchmark
node --test scripts/compare-rust-tui-spike.test.mjs
npm --workspace @earendil-works/pi-coding-agent exec vitest -- --run test/lystar-workspace.test.ts
node --test --import tsx packages/tui/test/headless-adapter.test.ts
node --import tsx packages/gui-protocol/scripts/rust-handshake-spike.mjs
cargo build --release -p lystar-tui
bash crates/lystar-tui/tests/pty-terminal-guard.sh
node --import tsx packages/tui/test/render-churn-bench.ts --compatibility
node --import tsx packages/tui/test/render-churn-bench.ts --smoke --out /tmp/lystar-ts-b0-smoke.jsonl
cargo run -q -p lystar-tui --release --example benchmark -- --smoke --out /tmp/lystar-rust-b0-smoke.jsonl
```

GUI Protocol 聚焦测试为 `13/13`，Rust protocol/TUI workspace 为 `30/30`。Host runtime/journal 与 Rust fd bridge tmux/FIFO 现在为 `8/8`：B3 设置写入掉响应后按原请求重试、模型与思考 session 写入，以及 fake-auth 的 `select(id) -> input -> secret -> auth_url/device_code/progress notify -> confirm -> completed`。认证 E2E 断言登录和登出各一次、登录 B3 回包丢失后同一请求重试不会重复调用 Host、设备码复制经 Host、Rust trace 与 artifact 不含密文。另有三组 10,000 Tool rounds 的 older-page 测量，每组五轮、每轮五个分页样本：每组 `end-to-frame` p95 为 `30ms`，`decode+apply+draw` p95 为 `10ms`，RSS p95 为 `16.285 MiB`；空闲两秒为 124 次 16ms 等待、0 帧和 10ms 进程树 CPU。

`projectRuntimeProgress` 继续使用真实 `AgentSessionEvent` 结构覆盖 assistant、thinking、tool start/update/end、queue_update、usage 以及最长 1024 字节的未投影状态。新的 TypeScript status golden frame 覆盖此前会导致 Rust decoder 退出的 `session_progress.status`。

## 正式 Editor 基准

`npm run benchmark:rust-m8` 生成 `.artifacts/rust-tui-m8/benchmark.jsonl`。每个 record 使用正式 `AppState`、`EditorState`、`TranscriptView`、`ComposerView`、Ratatui `TestBackend` 和 `CrosstermBackend<CountingWriter>`；10,000 个 Tool rounds 的 setup 不计时。全部 45 条记录均为三尺寸、三场景、每组五轮；缓存固定 `400 rounds / 800 items / 63,191 bytes`，`transcriptRegroupBefore` 与 `transcriptRegroupAfter` 均为 `400:tool-call-09600:tool-result-09999`。

| 场景 | 尺寸 | event-to-frame p50/p95/p99/max ms | bytes p95 | RSS p95 MiB |
| --- | --- | ---: | ---: | ---: |
| input300 | 80x24 | 2.815 / 3.300 / 3.585 / 4.010 | 48 | 22.957 |
| input300 | 120x36 | 2.871 / 3.516 / 3.747 / 3.981 | 48 | 22.961 |
| input300 | 200x60 | 3.023 / 3.481 / 3.815 / 4.347 | 48 | 22.961 |
| paste5000 | 80x24 | 4.020 / 4.884 / 4.884 / 4.884 | 260 | 22.961 |
| paste5000 | 120x36 | 4.318 / 4.550 / 4.550 / 4.550 | 299 | 22.961 |
| paste5000 | 200x60 | 4.256 / 4.421 / 4.421 / 4.421 | 299 | 22.965 |
| palette_open | 80x24 | 3.239 / 3.579 / 3.579 / 3.579 | 2,484 | 22.961 |
| palette_open | 120x36 | 3.578 / 4.223 / 4.223 / 4.223 | 2,484 | 22.961 |
| palette_open | 200x60 | 3.858 / 4.653 / 4.653 / 4.653 | 2,484 | 22.965 |

`palette_open` 以一次 Ctrl+P 等价的 overlay open 和首帧 draw 为口径，p95 不超过 16 ms，RSS p95 不超过 180 MiB；verifier 会拒绝缺轮次、paste events/characters 不符、palette 指标超限、regroup 改变、0/null 指标、缓存超限或预算超限。

真实 tmux 80x8 验收走 10 行按键输入路径，捕获中 Transcript 错误 Tool 行、Composer 边框、光标、运行状态和快捷栏均在 8 行内且顺序不重叠；resize 到 80x24、120x36、200x60 后再回 80x8 仍可见，退出前后 `stty -g` 完全相同。M8 Host↔Rust E2E 的完整交互流重复两次。

`npm run check:rust-spike` 本轮已执行 schema 生成，但脚本内的 `git diff --exit-code` 会把尚未提交的 generated schema/`generated.rs` 视为工作区差异并退出 1；提交前无法用它证明完整 gate 已通过。

## 未验证边界

- 仅在 Linux x64 验证 Unix fd3/fd4 bridge 和 tmux PTY；Windows named pipe 传输未实机验证。
- 未调用真实 Provider；运行时 E2E 使用可控 fake RuntimeSession。
- M10 默认切换仍受 B0 相对性能门槛约束，M8 不改变该结论。
