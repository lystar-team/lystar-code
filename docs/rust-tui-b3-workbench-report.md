# Rust TUI B3 会话工作台核验

核验日期：2026-08-16。范围是 Linux x64 上的 Rust TUI、GUI Host 和 Unix fd3/fd4 FIFO bridge；Runtime 使用 fake adapter，Session 使用真实临时 JSONL。未调用真实 Provider，未访问网络。

## 本轮证据

- `packages/gui-host/test/rust-tui-e2e.test.ts` 的完整 fd bridge E2E 连续执行两轮，均为 `11/11`。每轮使用新的临时 JSONL、FIFO、tmux socket 与 artifact；会话切换记录 A->B 的严格 `dispose:A` 后 `open:B`、B 获取失败后重新获取 A、双失败后自动打开来源为 `RecoverySession` 的 Sessions chooser。该恢复 chooser 仅在 active session 和 lease 均为空时让 `q` 退出；普通用户打开的 Sessions 中 `q` 仍作为筛选，Esc 关闭，Ctrl+C 仍走全局 abort 语义。`q` 退出后关闭 Host connection，覆盖 `releaseClient` 清理路径，Host `LeaseManager` 为 0，终端 `stty -g` 前后一致。
- B3 response 继续按 request ID 匹配；设置写入后触发的刷新与前一轮请求并行返回时，不再被全局 request generation 误丢。
- 只读场景用 `v` 打开非当前 Session，覆盖初始页、更早页、搜索和滚动。期间 adapter `openSession` 调用数及 Host lease count 均不变，临时 `<session>.lock` 不存在。向主会话注入 progress 和 commit，关闭只读视图后主 transcript 可显示新的 commit。
- page response 的 trace 由 `apply_response` 统一补回 `page_apply_start`、`page_apply_end` 和 `page_applied`。这是 fd bridge 的旧 page/首帧验收和本轮可观测性断言共同依赖的运行态事件。
- `80x8` 下 Sessions 打开和 Esc 返回 Composer 已在两轮只读场景覆盖；在 `120x36 -> 80x8` resize 往返后 Composer 快捷栏仍可见。
- Tree 的两轮外部 FIFO 矩阵已完成：filter、label/clear、navigate cancelled、summary、editor replace、fork、错误后重试和掉 B3 回包后的幂等重试均由真实 Host-Rust bridge 覆盖；`80x8` 关闭后 Composer 与快捷栏仍可见。

## B3 工作台基准

命令：

```bash
npm run benchmark:rust-b3-workbench
npm run benchmark:rust-b3-workbench:verify
```

基准使用正式 `AppState`、`TranscriptWindow`、`TranscriptView`、`WorkbenchOverlayView`、Ratatui `TestBackend` 和 `CrosstermBackend<CountingWriter>`。每条 record 在计时前建立 active 10,000 Tool rounds 与 readonly 10,000 Tool rounds；两侧均受 `400 rounds / 800 items / 4 MiB` 缓存上限约束。三尺寸、五场景、五轮共 75 条 JSONL record，verifier 严格检查数量、轮次、缓存、regroup、p95/p99/RSS 预算。最新一次命令执行全部通过，最大 p95/p99 为 `5.555ms`，RSS p95 为 `25.805MiB`。

| 场景 | 尺寸 | p50 / p95 / p99 / max ms | bytes p95 | RSS p95 MiB | active / readonly cache rounds |
| --- | --- | ---: | ---: | ---: | ---: |
| readonly_open | 80x24 | 4.262 / 4.565 / 4.565 / 4.565 | 3,075 | 25.805 | 400 / 400 |
| readonly_open | 120x36 | 4.522 / 4.660 / 4.660 / 4.660 | 3,075 | 25.805 | 400 / 400 |
| readonly_open | 200x60 | 4.583 / 5.555 / 5.555 / 5.555 | 3,075 | 25.805 | 400 / 400 |
| older_scroll | 80x24 | 4.108 / 4.406 / 4.406 / 4.406 | 3,075 | 25.805 | 400 / 400 |
| older_scroll | 120x36 | 4.382 / 5.083 / 5.083 / 5.083 | 3,075 | 25.805 | 400 / 400 |
| older_scroll | 200x60 | 4.501 / 5.329 / 5.329 / 5.329 | 3,075 | 25.805 | 400 / 400 |
| search | 80x24 | 4.032 / 5.323 / 5.323 / 5.323 | 3,087 | 25.805 | 400 / 400 |
| search | 120x36 | 4.778 / 4.828 / 4.828 / 4.828 | 3,087 | 25.805 | 400 / 400 |
| search | 200x60 | 4.533 / 4.660 / 4.660 / 4.660 | 3,087 | 25.805 | 400 / 400 |
| tree_open | 80x24 | 3.346 / 3.623 / 3.623 / 3.623 | 2,496 | 25.805 | 400 / 400 |
| tree_open | 120x36 | 3.614 / 3.722 / 3.722 / 3.722 | 2,496 | 25.805 | 400 / 400 |
| tree_open | 200x60 | 3.730 / 4.008 / 4.008 / 4.008 | 2,496 | 25.805 | 400 / 400 |
| tree_filter | 80x24 | 3.533 / 4.113 / 4.113 / 4.113 | 2,448 | 25.805 | 400 / 400 |
| tree_filter | 120x36 | 3.605 / 4.166 / 4.166 / 4.166 | 2,448 | 25.805 | 400 / 400 |
| tree_filter | 200x60 | 4.099 / 4.611 / 4.611 / 4.611 | 2,448 | 25.805 | 400 / 400 |

最大 p95 为 `5.555ms`，最大 p99 为 `5.555ms`，RSS p95 为 `25.805MiB`，均低于本项 `p95 <= 50ms`、`p99 <= 75ms`、`RSS <= 180MiB`。所有 record 的 `transcriptRegroupBefore` 与 `transcriptRegroupAfter` 一致。

## 运行边界

- 只验证 Linux x64、Unix FIFO/tmux 和 Rust fd3/fd4 transport；Windows named pipe 未验证。
- fake adapter 用于可控的 lease、response-drop 和 Runtime 事件；不等同于真实 Provider 或远端 Host。
- 本报告只覆盖 B3 会话工作台范围；不表示 B3 总体完成，也不表示 M9-M11 或 Rust 默认切换完成。M10 的相对 CPU/写量 release gate 仍然有效。
