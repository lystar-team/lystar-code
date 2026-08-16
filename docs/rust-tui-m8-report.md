# Rust TUI M8 Composer 与运行状态核验

核验日期：2026-08-16。范围仅限 GUI Protocol、GUI Host、`lystar-protocol` 和 `lystar-tui`；未修改 `packages/agent`、`packages/tui` 或 InteractiveMode 语义。

## 完成内容

- Protocol 增加 `steer`、`follow_up`、`clear_queue` 请求，以及受限的 `SessionProgress` 联合类型。Session snapshot 暴露活动状态、steering 队列数和 follow-up 队列数。
- Host 只在 `CoreRuntimeSession` 通过公开 `AgentSession` 方法调用 `steer`、`followUp`、`clearQueue`。运行时事件投影成受限进度；未知事件退化为最长 1024 字节的状态文本，不透传原始事件负载。
- 队列命令进入既有 operation journal，响应写出后再开始执行。相同 client request ID 与 payload 的重试复用同一 operation，不会重复执行。
- Rust TUI 使用固定底部 Composer，支持 UTF-8 grapheme 编辑、多行、光标移动、删除、粘贴、64 KiB 输入上限、200 条历史、100 步 undo/redo。Enter 根据运行状态发出 `prompt` 或 `steer`，Alt+Enter 发出 `follow_up`，Esc/Ctrl+C 中止活动 operation。
- 实时 assistant/thinking/tool 进度保存在 Rust 状态中；Tool 以 `toolCallId` 关联，最终 transcript commit 不会由进度层重复追加。

## 实际验证

```bash
npm --workspace @lystar/code-gui-protocol exec vitest -- --run test/protocol.test.ts
npm --workspace @lystar/code-gui-host exec tsc -- -p tsconfig.build.json --noEmit
npm --workspace @lystar/code-gui-host exec vitest -- --run test/runtime-adapter.test.ts test/operation-journal.test.ts
npm --workspace @lystar/code-gui-host exec vitest -- --run test/rust-tui-e2e.test.ts
npm run generate:rust-fixtures
cargo fmt --check
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

GUI Protocol 为 10/10，Host runtime/journal 聚焦测试为 12/12，Rust fd bridge tmux/FIFO E2E 为 3/3。新增 E2E 在真实 Rust 二进制、FIFO bridge 和 Host service 下验证 prompt、streaming steer、Alt+Enter follow-up、typed Tool 状态、Esc abort、重复 prompt 重试和重复 `clear_queue` 的幂等性。性能回归继续保留 M7 的五轮 10,000 Tool 首帧、翻页和 RSS 采样：首帧 p95 不超过 100 ms，旧页 p95 不超过 50 ms，Rust pane RSS p95 不超过 40 MiB。

`npm run check:rust-spike` 的首段“生成后 schema 必须零 diff”会在本次 schema 源码变更存在时故意失败；生成结果已通过 `generate:rust-fixtures` 及后续 clippy、测试、握手、release build、PTY guard 和 smoke 分项验证。

## 未验证边界

- 仅在 Linux x64 验证 Unix fd3/fd4 bridge 和 tmux PTY；Windows named pipe 传输未实机验证。
- 未调用真实 Provider；运行时 E2E 使用可控 fake RuntimeSession。
- M10 默认切换仍受 B0 相对性能门槛约束，M8 不改变该结论。
