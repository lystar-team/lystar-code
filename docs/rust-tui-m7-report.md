# Rust M7 只读工作台核验

核验日期：2026-08-15。

## 已验证

- 协议：`search_transcript` 由 TypeBox schema 单源生成 Rust 类型与 TS/Rust 双向 golden。请求要求非空 `query`，`limit` 上限为 100；结果只包含 generation、命中摘要和下页 cursor。
- Host：`TranscriptReader` 对完整 JSONL 尾、append、rewrite 和 cursor 失效保持原有语义。搜索索引按 `path + generation` 缓存，最多保留 8 个 Session、总文本上限 64 MiB；JSONL 变更后重建。Rust 不接收完整 Session。
- 10,000 Tool rounds：Host 回归生成 20,000 条 Tool call/result JSONL 记录，尾页为 200 条，热搜索连续 25 次的 p95 断言为 `<= 50ms`。首次建索引不计入热搜索阈值。
- Rust：`--run <sessionPath>` 使用 fd3/fd4 完成 typed hello，发起初始 `read_transcript(limit=200)`；窗口最多保留 400 个 Tool round。revision gap、generation 改变和 `transcript_changed` 会清缓存并重读；`session_progress` 只显示未提交预览。
- E2E：tmux + FIFO 的真实 fd bridge 验证 Rust hello、Node `GuiHostService` 初始分页与 pipe EOF。该测试没有直接读取 Session 文件。
- PTY：release 二进制在 `80x8`、`80x24`、`120x36`、`200x60` 下覆盖 EOF、panic、SIGINT、SIGTERM，四例 `stty` 均恢复。

## 数据边界

- 内存：Rust 单元测试验证 transcript round cache 严格不超过 400。此轮没有采集 M7 真实交互进程的 RSS；不得用 B0 benchmark RSS 代替 M7 RSS。
- 首屏：E2E 验证 Host 收到初始 `read_transcript(limit=200)`，没有采集端到端首屏耗时。
- 输入注入：隔离 tmux/FIFO bridge 已验证 hello、初始页和 EOF。tmux 向该隔离 pane 注入滚动和搜索键未形成稳定测试证据，因此滚动、搜索、append 的状态转换目前由 Rust 单元测试与 Host 集成测试覆盖，不把它们写成完整 PTY E2E 结论。

## 执行入口

```bash
npm --workspace @lystar/code-gui-protocol exec vitest -- --run test/protocol.test.ts
npm --workspace @lystar/code-gui-host exec vitest -- --run test/transcript-reader.test.ts test/rust-tui-e2e.test.ts
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo build --release -p lystar-tui
bash crates/lystar-tui/tests/pty-terminal-guard.sh target/release/lystar-tui
```
