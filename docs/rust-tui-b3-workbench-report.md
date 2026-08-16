# Rust TUI B3 会话工作台核验

核验日期：2026-08-16。范围是 Linux x64 上的 Rust TUI、GUI Host 和 Unix fd3/fd4 FIFO bridge；Runtime 使用 fake adapter，Session 使用真实临时 JSONL。未调用真实 Provider，未访问网络。

## 本轮证据

- `packages/gui-host/test/rust-tui-e2e.test.ts` 新增两轮 Host-Rust tmux/FIFO 场景。会话列表由三个真实 tmp JSONL 构成，A->B 严格记录为 `dispose:A` 后 `open:B`；B 获取失败后重新获取 A；B 和 A 都失败后直接读取 Host `LeaseManager`，确认 lease count 为 0。`q` 退出后再次确认 lease count 为 0，终端 `stty -g` 前后一致。
- 只读场景用 `v` 打开非当前 Session，覆盖初始页、更早页、搜索和滚动。期间 adapter `openSession` 调用数及 Host lease count 均不变，临时 `<session>.lock` 不存在。向主会话注入 progress 和 commit，关闭只读视图后主 transcript 可显示新的 commit。
- page response 的 trace 由 `apply_response` 统一补回 `page_apply_start`、`page_apply_end` 和 `page_applied`。这是 fd bridge 的旧 page/首帧验收和本轮可观测性断言共同依赖的运行态事件。
- `80x8` 下 Sessions 打开和 Esc 返回 Composer 已在两轮只读场景覆盖；在 `120x36 -> 80x8` resize 往返后 Composer 快捷栏仍可见。

当前 Tree 的完整外部操作矩阵尚未在本报告中声明完成。已有 Rust unit/workbench coverage 和 B3 benchmark 覆盖 Tree open/filter 的状态与渲染路径；label/clear、navigate cancelled、summary、editor replace、fork、错误后重试仍需要独立 fd bridge E2E 扩展。本文不把这部分写成完成。

## B3 工作台基准

命令：

```bash
npm run benchmark:rust-b3-workbench
npm run benchmark:rust-b3-workbench:verify
```

基准使用正式 `AppState`、`TranscriptWindow`、`TranscriptView`、`WorkbenchOverlayView`、Ratatui `TestBackend` 和 `CrosstermBackend<CountingWriter>`。每条 record 在计时前建立 active 10,000 Tool rounds 与 readonly 10,000 Tool rounds；两侧均受 `400 rounds / 800 items / 4 MiB` 缓存上限约束。三尺寸、五场景、五轮共 75 条 JSONL record，verifier 严格检查数量、轮次、缓存、regroup、p95/p99/RSS 预算。

| 场景 | 尺寸 | p50 / p95 / p99 / max ms | bytes p95 | RSS p95 MiB | active / readonly cache rounds |
| --- | --- | ---: | ---: | ---: | ---: |
| readonly_open | 80x24 | 3.963 / 4.381 / 4.381 / 4.381 | 3,075 | 25.680 | 400 / 400 |
| readonly_open | 120x36 | 4.365 / 4.423 / 4.423 / 4.423 | 3,075 | 25.680 | 400 / 400 |
| readonly_open | 200x60 | 4.612 / 5.304 / 5.304 / 5.304 | 3,075 | 25.680 | 400 / 400 |
| older_scroll | 80x24 | 4.356 / 4.487 / 4.487 / 4.487 | 3,075 | 25.680 | 400 / 400 |
| older_scroll | 120x36 | 4.499 / 4.677 / 4.677 / 4.677 | 3,075 | 25.680 | 400 / 400 |
| older_scroll | 200x60 | 4.914 / 5.158 / 5.158 / 5.158 | 3,075 | 25.680 | 400 / 400 |
| search | 80x24 | 4.411 / 4.739 / 4.739 / 4.739 | 3,087 | 25.680 | 400 / 400 |
| search | 120x36 | 4.230 / 4.301 / 4.301 / 4.301 | 3,087 | 25.680 | 400 / 400 |
| search | 200x60 | 4.776 / 5.051 / 5.051 / 5.051 | 3,087 | 25.680 | 400 / 400 |
| tree_open | 80x24 | 3.319 / 3.591 / 3.591 / 3.591 | 2,496 | 25.680 | 400 / 400 |
| tree_open | 120x36 | 3.454 / 3.929 / 3.929 / 3.929 | 2,496 | 25.680 | 400 / 400 |
| tree_open | 200x60 | 3.903 / 4.411 / 4.411 / 4.411 | 2,496 | 25.680 | 400 / 400 |
| tree_filter | 80x24 | 3.374 / 3.468 / 3.468 / 3.468 | 2,448 | 25.680 | 400 / 400 |
| tree_filter | 120x36 | 3.661 / 4.005 / 4.005 / 4.005 | 2,448 | 25.680 | 400 / 400 |
| tree_filter | 200x60 | 3.959 / 5.151 / 5.151 / 5.151 | 2,448 | 25.680 | 400 / 400 |

最大 p95 为 `5.304ms`，最大 p99 为 `5.304ms`，RSS p95 为 `25.680MiB`，均低于本项 `p95 <= 50ms`、`p99 <= 75ms`、`RSS <= 180MiB`。所有 record 的 `transcriptRegroupBefore` 与 `transcriptRegroupAfter` 一致。

## 运行边界

- 只验证 Linux x64、Unix FIFO/tmux 和 Rust fd3/fd4 transport；Windows named pipe 未验证。
- fake adapter 用于可控的 lease、response-drop 和 Runtime 事件；不等同于真实 Provider 或远端 Host。
- B3 会话工作台仍不是 M9-M11 或 Rust 默认切换完成证明。M10 的相对 CPU/写量 release gate 仍然有效。
