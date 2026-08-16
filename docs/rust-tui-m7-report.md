# Rust M7 只读工作台核验

核验日期：2026-08-16。范围仅限 M7 的 Rust 只读 Transcript；不包含 Composer、Tool 执行、Overlay、Session 切换或设置修改。Windows named-pipe transport 留给 M10，不能由本报告推断为已验证。

## 已验证

- 协议：`read_transcript` 的 `context` 绑定 generation、revision、cursor；`search_transcript` cursor 绑定 generation、revision、query 与 mode。append 后旧搜索 cursor 返回 `cursor_stale`，重新搜索结果保持顺序、唯一和完整。
- Host：JSONL 前向和反向扫描分块进行，单行超过 4 MiB 在累积前以 `transcript_line_too_large` 失败；搜索索引缓存只保留投影文本，不保留完整 raw JSON payload。10,000 Tool rounds 覆盖完整分页与搜索遍历。
- Rust 边界：TUI 只消费 `lystar-protocol` 的 `ReadOnlyMessage`、`ReadOnlyResponse` 和 `ReadOnlyEvent` 投影；generated wire types、generic frame encoder 与 `serde_json::Value` 解析不进入 TUI。FrameDecoder 在扩容前拒绝超过 `MAX_FRAME_LENGTH` 的首帧。
- 一致性：旧页请求必须同时匹配 request/current generation 和 revision；旧 revision、未来 revision 均拒绝并触发 reload。prepend 保持 revision，commit/reload 清空 stream preview。
- 渲染：`session_progress` 预览在 Host 与 Rust 边界均限制为 8 KiB，诊断记录 preview 与总缓存字节。OSC 8 用实际渲染出的链接 label 的列、行覆盖，不再固定写入 `(1,1)`。
- Linux E2E：正式 `GuiHostService`、Unix fd3/fd4 bridge、tmux 和 FIFO 覆盖 hello、初始页、翻页、搜索、append、EOF 与退出。性能 artifact 每轮记录 RSS 样本、round、pane PID、进程树 PID、样本数和 10ms 间隔，按 5 轮计算 p95。

## 本轮命令

```bash
npm --workspace @lystar/code-gui-protocol exec vitest -- --run test/protocol.test.ts
npm --workspace @lystar/code-gui-host exec vitest -- --run test/transcript-reader.test.ts test/rust-tui-e2e.test.ts
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo build --release -p lystar-tui
bash crates/lystar-tui/tests/pty-terminal-guard.sh target/release/lystar-tui
npm run check:rust-spike
```

前六项已在 Linux 执行通过：GUI Protocol `9/9`，GUI Host `13/13`，Rust workspace 全部测试通过，release PTY guard 覆盖 EOF、panic、SIGINT、SIGTERM 且 `stty` 恢复。提交后的 `npm run check:rust-spike` 已完整通过。

## 未验证

- Windows named-pipe transport、Windows/macOS 实机和 M10 默认切换未验证。
- 不做真实 Provider 调用；M7 不包含 Composer、Tool、Overlay、Extension 交互和 Session/设置操作。
