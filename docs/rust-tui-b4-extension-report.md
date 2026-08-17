# Rust TUI B4 Extension Component Bridge 核验

核验日期：2026-08-17。范围是 Linux x64 上真实 `CodingAgentRuntimeAdapter`、`runtime-contract-extension.ts`、GUI Host、Unix fd3/fd4 FIFO 与 Rust TUI。未调用外部 Provider。

## Tier 状态

| Tier | 状态 | 证据 |
| --- | --- | --- |
| Tier 0：状态、widget、terminal listener | 已验收 | 既有真实 Runtime Adapter E2E 与 Host 单测持续通过。 |
| Tier 1：Extension Component bridge | 已验收 | 两轮真实 Rust E2E 覆盖 mount/frame、header/footer、above/below widget、custom overlay、键盘 raw input、resize、hide/show、done、Esc cancel 与 replace。 |
| Tier 2：跨平台、真实 Provider、图片终端 | 未验收 | 本轮未做 Windows named pipe、Kitty/iTerm2 实机或外部 Provider 验证。 |

## CustomEditor 交互与释放

`extension_component_input` 的响应现在可携带可选 `appAction`。Host 在同步调用 active editor 的 `handleInput()` 期间捕获 `CustomEditor` 触发的 app action，并将它随同本次 `{ accepted: true }` 响应返回；不会再额外发布同一动作的异步 event。Rust 只有收到该响应的 `app.interrupt` 时才执行中断。若有 Rust overlay，键盘分发仍先处理 overlay；component input 超时才对 active editor 使用本地 raw key fallback。

`raw_key()` 保留 Alt+Enter 为 `\x1b\r`，timeout fallback 可恢复 Ctrl+D 和 Ctrl 字母控制序列，避免 Rust 在正常 bridge 路径抢先处理 editor key。`extension-ui-bridge.test.ts` 覆盖同步 `app.interrupt` result 且断言不重复发 event；`lystar-tui` 单元覆盖 Alt+Enter 与 Ctrl+D 原始序列。

`AgentSessionRuntime` 在 `dispose()` 和 session replacement 的 teardown 都会先请求 abort，并最多等待 2 秒后继续 shutdown、invalidate 和资源释放。这个边界处理的是未结束 faux stream 让 `RuntimeAdapter.dispose()` 无限等待的问题，不依赖放宽 E2E timeout。

`rust-tui-e2e.test.ts` 的 `通过 tmux/FIFO 两轮加载真实 Pi custom Editor examples` 对 `border-status-editor`、`modal-editor`、`rainbow-editor` 各运行两轮，使用真实原 example module 和真实 `CustomEditor` 基类。每轮确认 session-start draft 与 editor frame 挂载，并在 EOF 后确认不再 apply editor frame。该组 artifact 关闭 `terminal-output.raw`，仅写 example/round/frame count 元数据；测试扫描 artifact，拒绝编辑器全文、base64 和典型凭据模式。

本轮没有运行 CustomEditor 性能基准；下方既有 Component storm 基准记录不代表本轮的 CustomEditor latency 结论。

## 真实 Component E2E

`packages/gui-host/test/rust-tui-e2e.test.ts` 的 `drives real Extension Components through Rust mount, input, visibility, completion, and cancellation twice` 连续运行两轮。每轮从 `80x8` 启动，确认 custom overlay 只占 Composer 以外的工作台区域，快捷栏仍可见；随后 `80x24` 检查 header、footer、above/below widget 和 resize frame。

Extension fixture 实际渲染 SGR 文本，Host bridge 与 `pi-tui` headless adapter 使用相同允许集：仅保留 SGR 和安全 OSC8（`https`、`http`、`mailto`、`file`），其余 C0/C1/ESC 序列被剥离。Rust 侧 rich text parser 对 OSC8 href 再做同样的 scheme/control-character 收敛。E2E 还确认 `Up` 被 Rust 编码为 `\x1b[A` 并发送为 `extension_component_input`。

custom `done()` 和 `Esc` 都由 Host 发出 `extension_component_unmount`，Rust 清除活动 overlay 并恢复 Composer；footer 同一生命周期中 replace 后会卸载旧 generation、挂载新 generation。组件 input 异常由 Host 卸载并报告，不把异常传播到 terminal 进程；该隔离路径由 `extension-ui-bridge.test.ts` 覆盖。

## Invalidate 合并与真实 storm 基准

`ExtensionUiBridge` 按组件保留最多 `10,000` 条纯数值 invalidate ring：每条只含 `invalidateRequestedAt`、对应 `publishedAt` 和覆盖它的 `revision`；组件诊断还提供 `renderCount`、`publishCount`、`coalescedCount` 和可选数值 `lastFinalState`。它不复制 component lines、扩展文本、base64 或 secret。活动 Runtime 的 `get_diagnostics` 在 `extensionComponents` 下暴露这份结构化数据，供 Host/Rust E2E 读取。

Rust 在每次真实 apply frame 时输出 `extension_component_frame_applied componentId=<id> revision=<revision> at_ms=<monotonic>`；Linux 使用 `CLOCK_MONOTONIC`，与 Host `process.hrtime()` 同一时钟域关联 publish revision，trace 不包含 lines。

真实 fixture 的 `/contract-components-storm` 在约 500ms 内均匀调度 1000 次 `state increment + tui.requestRender()`，第 1000 次并发写入 done 状态。`scripts/benchmark-rust-extension-component-storm.mjs` 通过真实 `CodingAgentRuntimeAdapter -> GUI Host -> fd3/fd4 FIFO -> tmux Rust TUI` 执行，`scripts/verify-rust-extension-component-storm.mjs` 严格校验 15 条 JSONL 的尺寸/轮次集合、预算、最终状态、nonzero 指标、ring 上限和禁止字段；脚本负向测试覆盖 final state、frame 预算、时延预算和 base64 字段。

完整 artifact：`.artifacts/rust-tui-extension-component-storm/benchmark.jsonl`，Linux x64，`80x24`、`120x36`、`200x60` 各 5 轮，共 15 条。每条均为 final `1000`，每条 1000 invalidate；render/publish 为 `28..31`，coalesced 为 `971..973`，且均不超过 `ceil(elapsed / 16.67ms) + 2`。

| 尺寸 | invalidate->publish ms p50/p95/p99/max | publish->apply ms p50/p95/p99/max | end-to-end ms p50/p95/p99/max | RSS p95/max | active/idle CPU ms |
| --- | --- | --- | --- | --- | --- |
| 80x24 | 9.418 / 17.284 / 18.291 / 21.292 | 0.650 / 0.851 / 1.056 / 1.056 | 10.079 / 17.947 / 18.969 / 22.014 | 9.40 / 9.41 MiB | 40..50 / 0..10 |
| 120x36 | 3.585 / 16.895 / 18.112 / 20.620 | 0.560 / 0.708 / 0.761 / 0.995 | 4.122 / 17.466 / 18.679 / 21.131 | 9.59 / 9.59 MiB | 50..60 / 0..10 |
| 200x60 | 8.641 / 17.208 / 18.543 / 19.917 | 0.547 / 0.687 / 0.768 / 0.778 | 9.195 / 17.825 / 19.071 / 20.574 | 10.33 / 10.33 MiB | 70..80 / 0..10 |

所有 Host p95/p99 分别低于 `33/50ms`，Rust apply p95/p99 低于 `16/33ms`，端到端 p95/p99 低于 `50/75ms`。idle 对照 15/15 为 0 component frame；CPU 仅记录实际 process tree 的采样值，不设绝对 CPU 门槛。

`packages/tui/test/headless-adapter.test.ts` 继续覆盖同步/500ms requestRender 合并、即时 input、dispose timer 清理和组件独立性；`packages/gui-host/test/extension-ui-bridge.test.ts` 覆盖 bridge dirty set、timer、input 和 unmount 清理。`npm run check:rust-spike` 追加一轮真实 `80x24` storm smoke；Extended Quality 的 `rust-component-benchmark` 仅 workflow_dispatch 可选执行，不提高主 CI 或定时 B0 benchmark 频率。

## 未验证项

- Windows named pipe、Kitty/iTerm2 图片终端和真实外部 Provider 仍未实机验证。
- 本轮 E2E 使用 faux provider；不宣称真实模型流式输出下的 Extension Component 时延。
