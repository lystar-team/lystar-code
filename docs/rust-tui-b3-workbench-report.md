# Rust TUI B3 会话工作台核验

核验日期：2026-08-16。范围是 Linux x64 上的 Rust TUI、GUI Host 和 Unix fd3/fd4 FIFO bridge；Runtime 使用 fake adapter，Session 使用真实临时 JSONL。未调用真实 Provider，未访问网络。

## Extension Tier0/1

Rust TUI 已通过 GUI Host 的 `ExtensionUIContext` bridge 接入 Tier0/1：现有通用 Tool card 继续渲染 Extension Tool 的 `content`、`details`、`error` 和图片元数据；Tier1 支持 `select`、`confirm`、`input`、`editor`、`notify`、status、working、文本 Widget、title、编辑器镜像和 terminal input listener。状态通过有界 `extension_ui_snapshot`/`extension_ui_delta`/`extension_editor_action` 事件同步，编辑器和原始终端输入通过 request/response 回传。重载、Session 切换和 dispose 会清空 bridge 状态；listener 存在时 key、paste、滚轮和 resize 走带超时的回传，超时或断连后回退本地输入，不能阻塞 Composer。

`custom()`、Header/Footer Component、Editor Component 和 autocomplete provider 仍属于 Tier3，Host 通过通知给出 `Tier3 bridge pending` 诊断，不伪装为可用。真实 Extension fixture 已覆盖状态、Widget、working/title 事件、编辑器动作和 terminal listener；工作台基准新增 `extension_ui`，在 80x24、120x36、200x60 各五轮共 15 条记录。最新一次 `extension_ui` p95 为 2.918ms 至 3.429ms，RSS p95 约 27.25 MiB。

## B3 最终补充：Rust 运行模式与退出输出

本轮在 Linux x64 完成 Rust TUI 的 `--run <session> --mode auto|fullscreen|regular --exit-output transcript|resume-hint`。旧 `--run <session>` 参数仍可用。`auto` 先读取 `PI_TUI_MODE`，再根据 stdin/stdout TTY、`TERM=dumb` 和 alternate-screen 能力决定模式；Coding Agent 的 LYStar-owned launch options helper 只把 SettingsManager 的 `tui-mode` 与 `fullscreen-exit-output` 映射为 Rust argv，不改 Node `InteractiveMode` 默认路径。

fullscreen 进入 alternate screen、启用 mouse 和 cursor guard；regular 使用 raw mode、隐藏 cursor 和 Ratatui `Viewport::Inline`，不进入 alternate screen、不启 mouse，图片保留文本元数据 fallback。EOF、panic、SIGINT、SIGTERM、启动中断与 Host 关闭路径均恢复终端；regular 不清除已有 scrollback。Linux PTY guard 已覆盖两种模式的四类生命周期，共 8 个用例，逐项确认 `stty -g` 恢复，regular 输出不含 alternate-screen 或 mouse escape sequence。

fullscreen 正常退出会先释放 Host lease、恢复终端，再按 `exit-output` 写 stdout。`resume-hint` 输出中文恢复提示和 shell-safe quoted `lc -r <sessionPath>`，不含 ANSI。`transcript` 以每页最多 200 条读取完整 Host transcript，磁盘临时页反向流式输出以控制内存，并保留 Tool、Diff、summary 与图片元数据；读取失败回退 resume hint，临时目录会被删除。tmux/FIFO E2E 连续两轮使用 620 条记录验证跨 UI cache 的完整时序回放、3 页以上分页、lease 为 0、`stty` 恢复，以及 regular 的 80x8 -> 120x36 resize、overlay、scrollback 与无重复退出提示。

## 富文本与图片补充

Rust B3 transcript 已通过 typed `render_rich_text` 与 `read_image_content` 接入 Host。Host 使用 Coding Agent 的 `Markdown`、当前主题、Mermaid 和 active runtime Extension markdown transformers 渲染 ANSI 行；没有向 TTY 写入控制序列。Rust 解析 ANSI SGR/OSC 8 为 Ratatui spans，按可见区最多预取 8 条记录，rich text 缓存限制为 256 entries / 16 MiB，失败或未知序列回退纯文本。Session 切换、transcript commit 和 resize 会失效对应缓存。

图片在 transcript projection 中只保留 `contentRef`、MIME、字节数和可选 alt，不传 base64。Rust 在可见区按需读取，图片缓存限制为 16 entries / 32 MiB；读取失败、引用过期、超限和未知终端都保留 `[图片 MIME 字节数]` 占位。TTY sidecar 只由 Rust 处理 Kitty、iTerm2 和 tmux passthrough，滚动、resize、overlay 或退出时会清理 Kitty 图像；Node 不生成图片 escape sequence。

本轮已实际执行：GUI Protocol `13/13`，Rust TUI `34/34`，Rust Host build，图片附件 Host-Rust tmux/FIFO 定向 E2E `1/1`（测试内部连续两轮），以及 `npm run benchmark:rust-b3-workbench` 的 270 records verifier。该基准的最大 end-to-frame p95 为 `5.321ms`，RSS p95 为 `28,594,176` bytes（约 27.27 MiB），active/readonly cache rounds 仍为 `400/400`。Kitty、iTerm2 和 Windows named pipe 没有实机终端验证。

## 本轮证据

- `packages/gui-host/test/rust-tui-e2e.test.ts` 新增图片附件 fd bridge E2E，内部连续两轮覆盖 `/attach` typed completion（目录继续补全、含中文和空格的路径）、项目图片读取、`/attachments` 的 80x8 列表、预览、删除确认、`/clipboard` 并行文本/图片读取，以及 dropped response 后使用同一 response ID、client request ID 和 frozen image 重试。tmux 在当前配置下会把 `Ctrl+Shift+V` 编码成普通 `Ctrl+V`，该修饰组合无法在 FIFO 字节流中单独断言；Rust 按键分支仍对带 Shift 的事件发起双读。
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

基准使用正式 `AppState`、`TranscriptWindow`、`TranscriptView`、`WorkbenchOverlayView`、Ratatui `TestBackend` 和 `CrosstermBackend<CountingWriter>`。每条 record 在计时前建立 active 10,000 Tool rounds 与 readonly 10,000 Tool rounds；两侧均受 `400 rounds / 800 items / 4 MiB` 缓存上限约束。三尺寸、二十二场景、五轮共 330 条 JSONL record，其中 `regular_initial`、`regular_input`、`regular_overlay` 和 `regular_scroll` 使用 Ratatui `Viewport::Inline`；每个 regular record 还验证 2 秒空闲窗口没有额外写帧。最新实测全矩阵最大 end-to-frame p95 为 `5.380481ms`，RSS p95 为 `28,651,520` bytes（约 27.32 MiB），active/readonly cache rounds 仍为 `400/400`。verifier 同时校验场景模式、regular idle 时间/0 invalid frame、数量、轮次、缓存、regroup、p95/p99/RSS 预算。

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

新增 regular 场景的逐尺寸数据保留在 `.artifacts/rust-tui-b3-workbench/benchmark.jsonl`；最新数值以本轮 `npm run benchmark:rust-b3-workbench:verify` 输出为准。

## 运行边界

- 只验证 Linux x64、Unix FIFO/tmux 和 Rust fd3/fd4 transport；Windows named pipe 未验证。
- fake adapter 用于可控的 lease、response-drop 和 Runtime 事件；不等同于真实 Provider 或远端 Host。
- 本报告只覆盖 B3 会话工作台范围；不表示 B3 总体完成，也不表示 M9-M11 或 Rust 默认切换完成。M10 的相对 CPU/写量 release gate 仍然有效。
