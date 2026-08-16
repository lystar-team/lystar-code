# Rust TUI M8 Composer 与运行状态核验

核验日期：2026-08-16。M8 在 Linux x64 完成本地硬验收；范围限于 GUI Protocol、GUI Host、`lystar-protocol` 和 `lystar-tui`，未修改 `packages/agent`、`packages/tui` 或 InteractiveMode 语义。

## 完成内容

- Protocol 增加 `steer`、`follow_up`、`clear_queue` 请求，以及受限的 `SessionProgress` 联合类型。Session snapshot 暴露活动状态、steering 队列数和 follow-up 队列数。
- Host 只在 `CoreRuntimeSession` 通过公开 `AgentSession` 方法调用 `steer`、`followUp`、`clearQueue`。运行时事件投影成受限进度；未知事件退化为最长 1024 字节的状态文本，不透传原始事件负载。
- 队列命令进入既有 operation journal，响应写出后再开始执行。相同 client request ID 与 payload 的重试复用同一 operation，不会重复执行。
- Rust Protocol 不再用 Typify 的顶层 event 联合体解码 Server wire；该生成类型会拒绝合法的 `session_progress.status`。现在先校验受限 envelope，再由只读投影解析字段；新增 TypeScript 编码的 status golden frame，避免运行中状态使 TUI 退出。
- Rust TUI 使用固定底部 Composer，支持 UTF-8 grapheme 编辑、多行、光标移动、删除、粘贴、64 KiB 输入上限、200 条历史、100 步 undo/redo。Enter 根据运行状态发出 `prompt` 或 `steer`，Alt+Enter 发出 `follow_up`，Esc/Ctrl+C 中止活动 operation。
- 实时 assistant/thinking/tool 进度保存在 Rust 状态中；Tool 以 `toolCallId` 关联，最终 transcript commit 不会由进度层重复追加。

## 实际验证

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

GUI Protocol 聚焦测试为 `10/10`，Host runtime/journal 与 Rust fd bridge tmux/FIFO 为 `18/18`。Host 两连接 E2E 让首次 prompt accepted 回包真实 reject 并关闭连接；新连接复用相同 `clientInstanceId`，重新 hello/acquire 后按相同 `clientRequestId` 重发，Fake Runtime 的 prompt 恰好一次，journal 终态 `completed`。steer、follow_up、clear_queue 同样覆盖首次运行完成后掉回包、重连复发和 existing completed；并发 prompt 恰好一次，相同 ID 不同 payload 返回 `operation_payload_mismatch`，idle steer/follow_up 返回 `session_not_active`，idle clear_queue 可用。

`projectRuntimeProgress` 继续使用真实 `AgentSessionEvent` 结构覆盖 assistant、thinking、tool start/update/end、queue_update、usage 以及最长 1024 字节的未投影状态。新的 TypeScript status golden frame 覆盖此前会导致 Rust decoder 退出的 `session_progress.status`。

## 正式 Editor 基准

`npm run benchmark:rust-m8` 生成 `.artifacts/rust-tui-m8/benchmark.jsonl`。每个 record 使用正式 `AppState`、`EditorState`、`TranscriptView`、`ComposerView`、Ratatui `TestBackend` 和 `CrosstermBackend<CountingWriter>`；10,000 个 Tool rounds 的 setup 不计时。全部 30 条记录均为三尺寸、两场景、每组五轮；缓存固定 `400 rounds / 800 items / 63,191 bytes`，`transcriptRegroupBefore` 与 `transcriptRegroupAfter` 均为 `400:tool-call-09600:tool-result-09999`。

| 场景 | 尺寸 | event-to-frame p50/p95/p99/max ms | bytes p95 | RSS p95 MiB |
| --- | --- | ---: | ---: | ---: |
| input300 | 80x24 | 2.979 / 3.721 / 4.083 / 4.604 | 48 | 22.898 |
| input300 | 120x36 | 3.042 / 3.932 / 4.327 / 7.015 | 48 | 22.898 |
| input300 | 200x60 | 3.195 / 3.865 / 4.318 / 6.132 | 48 | 22.902 |
| paste5000 | 80x24 | 4.349 / 4.836 / 4.836 / 4.836 | 260 | 22.898 |
| paste5000 | 120x36 | 4.580 / 5.229 / 5.229 / 5.229 | 299 | 22.902 |
| paste5000 | 200x60 | 4.675 / 5.214 / 5.214 / 5.214 | 299 | 22.906 |

input300 的每个单字符 insert 都执行一次 layout 和 draw；paste5000 仅一个 paste 事件、5,000 个字符、一次 draw。所有 group 的 event-to-frame p95 不超过 16 ms、p99 不超过 33 ms；同一指标作为 frame 口径时 p95 不超过 8 ms、p99 不超过 16 ms。verifier 会拒绝缺轮次、paste events/characters 不符、regroup 改变、0/null 指标、缓存超限或预算超限。

真实 tmux 80x8 验收走 10 行按键输入路径，捕获中 Transcript 错误 Tool 行、Composer 边框、光标、运行状态和快捷栏均在 8 行内且顺序不重叠；resize 到 80x24、120x36、200x60 后再回 80x8 仍可见，退出前后 `stty -g` 完全相同。M8 Host↔Rust E2E 的完整交互流重复两次。

`npm run check:rust-spike` 已实际通过：schema 生成后零 diff、fixture、Rust formatting/clippy/test、B0 smoke、协议握手、release build 和 PTY guard 均通过；它不是预期失败的 gate。

## 未验证边界

- 仅在 Linux x64 验证 Unix fd3/fd4 bridge 和 tmux PTY；Windows named pipe 传输未实机验证。
- 未调用真实 Provider；运行时 E2E 使用可控 fake RuntimeSession。
- M10 默认切换仍受 B0 相对性能门槛约束，M8 不改变该结论。
