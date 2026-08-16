# Rust TUI B3 会话工作台核验

核验日期：2026-08-16。范围是 Linux x64 上的 Rust TUI、GUI Host 和 Unix fd3/fd4 FIFO bridge；Runtime 使用 fake adapter，Session 使用真实临时 JSONL。未调用真实 Provider，未访问网络。

## 富文本与图片补充

Rust B3 transcript 已通过 typed `render_rich_text` 与 `read_image_content` 接入 Host。Host 使用 Coding Agent 的 `Markdown`、当前主题、Mermaid 和 active runtime Extension markdown transformers 渲染 ANSI 行；没有向 TTY 写入控制序列。Rust 解析 ANSI SGR/OSC 8 为 Ratatui spans，按可见区最多预取 8 条记录，rich text 缓存限制为 256 entries / 16 MiB，失败或未知序列回退纯文本。Session 切换、transcript commit 和 resize 会失效对应缓存。

图片在 transcript projection 中只保留 `contentRef`、MIME、字节数和可选 alt，不传 base64。Rust 在可见区按需读取，图片缓存限制为 16 entries / 32 MiB；读取失败、引用过期、超限和未知终端都保留 `[图片 MIME 字节数]` 占位。TTY sidecar 只由 Rust 处理 Kitty、iTerm2 和 tmux passthrough，滚动、resize、overlay 或退出时会清理 Kitty 图像；Node 不生成图片 escape sequence。

本轮已实际执行：GUI Protocol `13/13`，Host content store/projection `1/1`，Rust TUI `34/34`，Rust Host build，Host-Rust tmux/FIFO 全量 E2E `13/13`，以及 `npm run benchmark:rust-b3-workbench` 的 240 records verifier。该基准的最大 end-to-frame p95 为 `5.057ms`，RSS p95 为 `28,434,432` bytes（约 27.12 MiB），active/readonly cache rounds 仍为 `400/400`。Kitty、iTerm2 和 Windows named pipe 没有实机终端验证。

## 本轮证据

- `packages/gui-host/test/rust-tui-e2e.test.ts` 的完整 fd bridge E2E 连续执行两轮，均为 `13/13`。每轮使用新的临时 JSONL、FIFO、tmux socket 与 artifact；新增 Subagent 路径覆盖 `/subagents` 的 committed/live 列表、嵌套详情/只读记录、运行态停止确认、已结束继续、掉 B3 回包后的幂等重试，以及 `/clipboard` 的 capability、文本预览、插入、预览复制、输入框写入和上下文复制。既有项目工作台路径继续覆盖 `/changes` 的 Tab、筛选、Diff 摘要/展开与刷新，`/skills` 的作用域切换与 journaled write，`/trust` 的 canonical cwd、风险提示与确认切换，`/instructions` 的项目/本机浏览编辑、`expectedHash` 冲突重新加载，`/packages` 的安装、删除、更新，以及仅检查版本的 `/update`。
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

基准使用正式 `AppState`、`TranscriptWindow`、`TranscriptView`、`WorkbenchOverlayView`、Ratatui `TestBackend` 和 `CrosstermBackend<CountingWriter>`。每条 record 在计时前建立 active 10,000 Tool rounds 与 readonly 10,000 Tool rounds；两侧均受 `400 rounds / 800 items / 4 MiB` 缓存上限约束。三尺寸、十六场景、五轮共 240 条 JSONL record，新增 `subagents_open`、`subagent_detail`、`subagent_nested`、`clipboard_open` 与 `clipboard_insert`，验证列表、详情、嵌套和文本剪贴板路径不会触发 active transcript regroup；verifier 严格检查数量、轮次、缓存、regroup、p95/p99/RSS 预算。

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

新增五个 Subagent/剪贴板场景的逐尺寸数据保留在 `.artifacts/rust-tui-b3-workbench/benchmark.jsonl`；最新数值以本轮 `npm run benchmark:rust-b3-workbench:verify` 输出为准。

## 运行边界

- 只验证 Linux x64、Unix FIFO/tmux 和 Rust fd3/fd4 transport；Windows named pipe 未验证。
- fake adapter 用于可控的 lease、response-drop 和 Runtime 事件；不等同于真实 Provider 或远端 Host。
- 本报告只覆盖 B3 会话工作台范围；不表示 B3 总体完成，也不表示 M9-M11 或 Rust 默认切换完成。M10 的相对 CPU/写量 release gate 仍然有效。
