# Rust TUI B4 Extension Component Bridge 核验

核验日期：2026-08-16。范围是 Linux x64 上真实 `CodingAgentRuntimeAdapter`、`runtime-contract-extension.ts`、GUI Host、Unix fd3/fd4 FIFO 与 Rust TUI。未调用外部 Provider。

## Tier 状态

| Tier | 状态 | 证据 |
| --- | --- | --- |
| Tier 0：状态、widget、terminal listener | 已验收 | 既有真实 Runtime Adapter E2E 与 Host 单测持续通过。 |
| Tier 1：Extension Component bridge | 已验收 | 两轮真实 Rust E2E 覆盖 mount/frame、header/footer、above/below widget、custom overlay、键盘 raw input、resize、hide/show、done、Esc cancel 与 replace。 |
| Tier 2：跨平台、真实 Provider、图片终端 | 未验收 | 本轮未做 Windows named pipe、Kitty/iTerm2 实机或外部 Provider 验证。 |

## 真实 Component E2E

`packages/gui-host/test/rust-tui-e2e.test.ts` 的 `drives real Extension Components through Rust mount, input, visibility, completion, and cancellation twice` 连续运行两轮。每轮从 `80x8` 启动，确认 custom overlay 只占 Composer 以外的工作台区域，快捷栏仍可见；随后 `80x24` 检查 header、footer、above/below widget 和 resize frame。

Extension fixture 实际渲染 SGR 文本，Host bridge 与 `pi-tui` headless adapter 使用相同允许集：仅保留 SGR 和安全 OSC8（`https`、`http`、`mailto`、`file`），其余 C0/C1/ESC 序列被剥离。Rust 侧 rich text parser 对 OSC8 href 再做同样的 scheme/control-character 收敛。E2E 还确认 `Up` 被 Rust 编码为 `\x1b[A` 并发送为 `extension_component_input`。

custom `done()` 和 `Esc` 都由 Host 发出 `extension_component_unmount`，Rust 清除活动 overlay 并恢复 Composer；footer 同一生命周期中 replace 后会卸载旧 generation、挂载新 generation。组件 input 异常由 Host 卸载并报告，不把异常传播到 terminal 进程；该隔离路径由 `extension-ui-bridge.test.ts` 覆盖。

## 基准

执行：`cargo run -p lystar-tui --example b3_workbench_benchmark --release`

输出 `.artifacts/rust-tui-b3-workbench/benchmark.jsonl` 共 345 条记录，覆盖 `80x24`、`120x36`、`200x60`，5 轮和 23 个 workbench 场景。四个 regular 场景在 15 个尺寸/轮次组合中均为 `invalidIdleFrames=0`；最后一条记录的 event-to-frame 为 `3.774ms`，RSS 为 `28,602,368` bytes。基准同时断言 transcript regroup signature、rich text cache 上限和输出字节非零。

## 未验证项

- 没有单独采集“高频 `requestRender()` invalidate storm”的 p95/p99；常规 benchmark 的 idle 无额外帧只能证明静态 idle，不代表 storm 吞吐。
- 未实机验证 Windows named pipe、Kitty/iTerm2 图片终端和真实外部 Provider。
- 本轮 E2E 使用 faux provider；不宣称真实模型流式输出下的 Extension Component 时延。
