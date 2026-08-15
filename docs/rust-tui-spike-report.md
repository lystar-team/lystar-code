# Rust TUI B0 Spike Report

日期：2026-08-15

## 机器与版本

- Linux x64 / Debian 13
- Node.js v22.21.1 / npm 11.11.0
- Rust/Cargo 1.97.1
- Ratatui 0.30.2 / Crossterm 0.29.0 / Ciborium 0.2.2 / Typify 0.7.0

## 已执行命令

```bash
npm run generate:schema
node --import tsx packages/gui-protocol/scripts/generate-rust-fixtures.mjs
cargo run -p lystar-protocol --example generate_fixtures
node --import tsx packages/gui-protocol/scripts/check-rust-fixtures.mjs
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cd packages/tui && node --test test/headless-adapter.test.ts
node --import tsx packages/gui-protocol/scripts/rust-handshake-spike.mjs
```

结果：以上局部 B0 命令通过。Node host 从 Rust 子进程 fd4 读取客户端 hello，使用现有 GUI Protocol CBOR framing 向 fd3 写回 server hello；Rust 以 0 退出。协议消息没有写入 TTY stdout。

## 协议与终端边界

- `packages/gui-protocol/src/schemas.ts` 继续是 wire schema 唯一手写来源。
- 导出脚本把 TypeBox cyclic `JsonValue` 规范化到根 `$defs/JsonValue`，使 Typify 可生成 Rust 类型；TS wire schema 语义未变。
- Rust framing 使用 4-byte 大端长度前缀、CBOR、16 MiB 上限、增量 decoder；覆盖分片、合帧、截断、超长、decoder failed 和 hello 未知字段。
- Rust B0 shell 使用 Ratatui/Crossterm 的 raw mode、alternate screen、cursor 与 mouse guard，并通过 Drop 恢复。SIGTERM tmux smoke 后进程结束，但没有可审计的终端状态快照。

## Rust 基准

场景：10,000 项输入源、最多 400 项 page cache、300 次滚动。每个固定终端尺寸运行 5 次。单位为毫秒，数据保存在本机 `.artifacts/rust-tui-spike/benchmark-rust.jsonl`，不纳入提交。

| 尺寸 | p50 范围 | p95 范围 | p99 范围 | 最大值范围 | bytes | idle frames |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 80x8 | 0.000043-0.000047 | 0.000045-0.000049 | 0.000047-0.000075 | 0.000821-0.001059 | 0 | 0 |
| 80x24 | 0.000038-0.000045 | 0.000039-0.000048 | 0.000042-0.000056 | 0.000872-0.001149 | 0 | 0 |
| 120x36 | 0.000040-0.000048 | 0.000041-0.000054 | 0.000047-0.000058 | 0.000770-0.001223 | 0 | 0 |
| 200x60 | 0.000038-0.000074 | 0.000040-0.000093 | 0.000051-0.000117 | 0.000957-0.001221 | 0 | 0 |

这些仅衡量 Rust B0 的 page-cache 滚动循环，不含终端 flush、Node host、真实 transcript 解析或 RSS，不能与 TypeScript TUI 直接比较。

## 未验证项

- 现有 `render-churn-bench.ts` 尚未扩展为要求的 10k/input/paste/20-60-120 chunk/s/scroll/resize/static JSON 基线，故没有 TS 绝对数据或相对变化。
- 未取得 panic、child EOF 后终端状态的可审计 PTY snapshot；SIGINT 的 raw-mode 输入路径未实现为退出动作。
- 未验证 Windows ConPTY、真实 IME、图片、SSH、跨平台 pipe 等价实现。
- headless adapter 的异步 invalidate、输入、resize 和 dispose 已由最小 Component 测试；未驱动真实 Extension factory。

## B0 结论

**停止，不进入 B1。**

协议生成、双向 golden、Node/Rust hello、Rust framing、TestBackend 虚拟 transcript 和 headless adapter 局部测试已通过，但硬退出条件未满足：缺少与合并后 TypeScript 基线等价的五轮机器可读性能数据，且终端 panic/child EOF 恢复没有可审计证据。因此不能宣称输入、滚动、流式三项中有至少两项达到绝对预算或显著优于 TypeScript。
