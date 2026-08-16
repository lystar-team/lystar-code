# Rust TUI B4 Extension Tier0/1 核验

核验日期：2026-08-16。范围是 Linux x64 上真实 `CodingAgentRuntimeAdapter`、`runtime-contract-extension.ts`、GUI Host、Unix fd3/fd4 FIFO 与 tmux Rust TUI。未调用外部 Provider。

## 结论

- `ExtensionUiBridge.reset()` 和 `dispose()` 会在注销 listener 或标记 disposed 前发出最后一个空 snapshot；状态、widget、working 文本、title 和 terminal listener count 均被清空。Runtime dispose 先处理 bridge，再取消 Session subscription。
- widget budget 只由外层全屏区域计算。`80x8` 的 budget 为 0，Composer 和快捷栏固定保留；更高窗口按 above/below 的注册顺序逐行投影，超出的内容显示剩余行数。
- Extension 可控的状态、widget、working、title、UI 请求文本与编辑器文本会剥离 C0/C1、ESC、BEL、OSC/APC 控制字符。Rust 对所有 Ratatui 单行和 rich text 再做一次控制字符过滤；OSC 8 只允许无空白、无控制字符的 `https`、`http`、`mailto` 和 `file` href。title 支持 `string | null`，null 写安全的空 `OSC 0`。
- Host EOF、协议解析错误和正常退出会在 terminal guard 恢复前执行 ImageSidecar clear 并写空 title。Kitty delete 仍有 Rust sidecar 回归覆盖。

## 真实 PTY

`packages/gui-host/test/rust-tui-e2e.test.ts` 的真实 Runtime Adapter 用例连续两轮从 `80x8` 启动。它实际输入 Extension slash command，完成 `select`、`confirm`、`input`、`editor`、`notify`，验证 status、widget、working、title、编辑器 set/paste、terminal listener consume/rewrite，随后 resize 到 `80x24` 检查 widget 投影。恶意 fixture 注入 ESC/BEL/C1/OSC 文本后，artifact 只保留净化后的显示文本，没有 `ESC ] 0 ; injected` 控制注入；EOF 后包含空 `OSC 0`。

## Dedicated Input Perf

同一真实 PTY/Extension listener 逐个发送 200 个被 consume 的可打印输入。Host request receipt 与 Rust `extension_input_applied` trace 按 request ID 配对：

| 轮次 | 样本 | p95 | p99 | 超时 fallback | 重复应用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 200 | 2ms | 2ms | 0 | 0 |
| 2 | 200 | 2ms | 2ms | 0 | 0 |

两轮均满足 p95 `<=16ms`、p99 `<=33ms`。无 listener 时实际键入 `idle`，没有发送 `extension_terminal_input` round-trip。artifact 位于 `.artifacts/rust-tui-m7/extension-runtime-*/extension-input-perf.json`。

## 边界

本结论只覆盖 Linux x64、tmux、Unix FIFO/fd3/fd4 和 faux provider。Windows named pipe、Kitty/iTerm2 实机图片终端与真实外部 Provider 未验证。
