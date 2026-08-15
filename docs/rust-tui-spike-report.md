# Rust TUI B0 Spike Report

日期：2026-08-15

## 实际环境

- Linux x64 / Debian 13
- Node.js v22.21.1 / npm 11.11.0
- Rust/Cargo 1.97.1
- Ratatui 0.30.2 / Crossterm 0.29.0 / Ciborium 0.2.2 / Typify 0.7.0

## 已验证

```bash
npm run check:schema
node --import tsx packages/gui-protocol/scripts/generate-rust-fixtures.mjs
cargo run -p lystar-protocol --example generate_fixtures
node --import tsx packages/gui-protocol/scripts/check-rust-fixtures.mjs
node --test --import tsx packages/tui/test/headless-adapter.test.ts
node --import tsx packages/gui-protocol/scripts/rust-handshake-spike.mjs
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo build --release -p lystar-tui
bash crates/lystar-tui/tests/pty-terminal-guard.sh
```

结果：schema、Rust 编译、clippy、8 个 Rust 测试、headless 测试和 Node/Rust handshake 均通过。`target/` 已加入 `.gitignore`，不再作为未跟踪工作区内容出现。

## Protocol

- `decode_client_message` 和 `decode_server_message` 直接反序列化为 Typify 生成的 `ClientMessage`、`ServerMessage`；wire 边界不再返回 `serde_json::Value`。
- hello 的协议版本与 server response 判别字段在生成消息类型上检查。
- Rust 专用 schema 将实际 CBOR codec 不支持的 JSON 浮点数规范为整数，否则 Typify 的 `f64` 会重编码成 TS decoder 拒绝的浮点 CBOR。TS wire schema未改。
- golden 覆盖 client hello、`read_transcript` 的缺失 cursor、ui response、server hello、成功/失败 response、`transcript_committed` 和 `ui_request` event。TS 生成完整对象与 frame；Rust typed decode 后重编码；TS 正式 decoder 对 Rust frame 做完整对象深比较。

### 仍未关闭的 typed protocol 条件

Typify 将 `value?: JsonValue` 生成为 `Option<JsonValue>`。Serde 对该字段的 CBOR `null` 与字段缺失都会反序列化为 `None`，因此无法在生成类型内保留 null presence；重新编码会把 `value: null` 变成缺失字段。测试显式锁定了这个行为，避免把“可接受 null”错误写成“可无损保留 null”。

这不满足 B0 的 optional-vs-null typed decode/round-trip 条件。修复需要给 Typify 生成字段增加 presence-aware 自定义反序列化，或更换能表达三态 optional/null/value 的代码生成路径；两者都超出 B0 允许的最小适配范围。

## Headless 与 Handshake

- Headless adapter 仅投影 Component，未拥有 TTY；frame 输出 lines、cursor 和按行的 component hit regions。
- 回归使用真实 `Input` Component 验证输入、cursor、resize 宽度和命中区；扩展风格 footer fixture 验证异步 requestRender、下一帧、dispose exactly once。
- Node spawn 使用 fd3/fd4 收发 typed hello，并断言 stdout 与成功 stderr 均为空。

## Terminal Guard PTY 证据

`crates/lystar-tui/tests/pty-terminal-guard.sh` 使用本轮唯一 tmux socket 覆盖：

| 路径 | 退出码 | `stty -g` | 收尾序列 |
| --- | ---: | --- | --- |
| child fd EOF | 1 | 进入前后相同 | mouse disable / cursor show / leave alt screen |
| panic | 101 | 进入前后相同 | mouse disable / cursor show / leave alt screen |
| SIGINT | 0 | 进入前后相同 | mouse disable / cursor show / leave alt screen |
| SIGTERM | 0 | 进入前后相同 | mouse disable / cursor show / leave alt screen |

`TerminalGuard::enter()` 还增加了 unit fault injection：alternate screen 进入失败时必须恢复 raw mode。

## Benchmark

旧 `benchmark.rs` 只有缓存滚动循环，未实际渲染至内存 terminal，也没有 TS 对照、统一场景、RSS、bytes、idle 或五轮 JSONL。因此它不能作为 B0 性能证据。

本轮没有手填或伪造 benchmark 数据。由于 typed protocol 已出现不可逆 null-presence 缺口，B0 的 Go 前置条件已经失败；在该前置条件失败时继续报告速度/RSS 比较没有决策价值。统一五轮 release Rust/normal Node benchmark 仍未实现，不能宣称输入、滚动或流式任两项达标。

## B0 结论

**Stop，不进入 B1，不迁移默认 TUI。**

原因是明确且可重复的：生成 Rust 类型无法保留 full schema 中 optional JsonValue 的 null presence；同时 B0 尚无符合规格的可比五轮 benchmark。headless、fd handshake 和 terminal restore 已通过，但不抵消 protocol 与 performance 两个 Go 前置条件。
