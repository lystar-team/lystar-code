# Rust TUI B0 评估

日期：2026-08-15

## 决策

- `developmentDecision: go`：协议生成、终端恢复、headless bridge、80x8 兼容性和绝对预算全部满足时，允许进入 B1。`80x8` 只作为兼容性检查，不参与性能比较。
- `releaseDecision: stop`：相对 frame/write 与 CPU 门槛只约束 M10 默认切换；为 `stop` 不阻止 Rust 自有可见 TUI 继续迁移。

## 功能前提

| 检查 | 结果 |
| --- | --- |
| protocolGeneration | 通过 |
| terminalRestore | 通过 |
| headlessBridge | 通过 |
| smallTerminalCompatibility | 通过 |

## 可比口径

- 5 轮、3 个性能尺寸：`80x24`、`120x36`、`200x60`。`80x8` 另行验证布局、Composer 底部与退出恢复，不写入性能 records。
- 主 fixture 是同一 Session 的 10,000 个 Tool 调用轮次；每轮均含 `toolCall` 与 `toolResult`，并混入长输出、diff、错误、图片与 `content_ref` 摘要。流式场景更新已有 Tool Result。
- TS 使用真实 `LystarWorkspace`、`TuiAltScreen` 和全量 Tool 行；Rust 用 100 项页、最多 4 页缓存，仅投影可见窗口加 2 倍预取窗口。
- `workloadHash` 覆盖 Tool id/name/args、result/status/diff/error、最终 editor、尺寸和 viewport；同一场景、尺寸、轮次的 TS/Rust hash 必须完全一致。
- RSS 先 warmup，再保持至少 1 秒，以不超过 10ms 的间隔采样目标 PID 与其 child tree。TS、Rust、`GuiHostService`+完成 typed handshake 的 Rust child 分开报告；不计 orchestrator、npm 或 cargo。

## 绝对预算

| 场景 | 尺寸 | TS frame ms p50/p95/p99/max | Rust frame ms p50/p95/p99/max | Rust bytes p95 | TS bytes p95 | Workload SHA-256 | 结果 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| static-idle | 80x24 | 0.000/0.000/0.000/0.000 | 0.000/0.000/0.000/0.000 | 0.000 | 0.000 | 21bcadff3c63c6efcdad0102940cd5647aade18820680d44f91c6b77491add0b | 通过 |
| static-idle | 120x36 | 0.000/0.000/0.000/0.000 | 0.000/0.000/0.000/0.000 | 0.000 | 0.000 | 338398156eb32550de887721b9d35078eaec9229771f10eb61e49e761a39ebfb | 通过 |
| static-idle | 200x60 | 0.000/0.000/0.000/0.000 | 0.000/0.000/0.000/0.000 | 0.000 | 0.000 | 4172ab3189da59d6887191c54925583c7bb4c7e38c75ae3b96d62ac53ce8cf01 | 通过 |
| input300 | 80x24 | 0.682/1.098/3.406/13.605 | 5.481/6.342/7.042/9.465 | 46.000 | 22.000 | 9bc9b4e5984f9da76a85d7f0b3c81d0a6aa0219a89b65c3f5dc152fcb3f5c992 | 通过 |
| input300 | 120x36 | 1.058/1.249/11.913/18.400 | 5.484/6.284/6.821/7.381 | 46.000 | 22.000 | e93c7405dd25c4317774a9f15ed5eab0d47015cc1aab2031fbc72a6409190011 | 通过 |
| input300 | 200x60 | 1.630/1.909/13.782/17.679 | 5.505/6.347/6.911/7.982 | 46.000 | 22.000 | 63a798ac18aa4d289bf365553420b42c57a01e436ffdafeae90bc5cd8930e2f6 | 通过 |
| paste5000 | 80x24 | 0.708/0.838/1.079/1.079 | 5.479/6.285/6.664/6.664 | 25.000 | 22.000 | fcc1e5837dda86b03526afa0c4be98e2d66094a9a2041ebdb1776af0cf6505f4 | 通过 |
| paste5000 | 120x36 | 1.059/1.388/19.880/19.880 | 5.589/6.388/6.689/6.689 | 25.000 | 22.000 | 97c33a7fdff79782756492177bb361c050b541681c2dd7627e442379f3e69d75 | 通过 |
| paste5000 | 200x60 | 1.686/2.209/18.125/18.125 | 5.716/6.311/6.390/6.390 | 25.000 | 22.000 | 85401461c39147597de2338796108c0a83982fcc9a4b553856e8b4aa678b1bbb | 通过 |
| stream20 | 80x24 | 1.054/1.363/1.495/1.495 | 5.572/6.529/6.548/6.548 | 145.000 | 130.000 | bd6a5a91eb6122445d95ce5a1092eb7573b64b72939cd2f1b78e971fdb59f8b0 | 通过 |
| stream20 | 120x36 | 1.719/2.379/16.202/16.202 | 5.459/6.709/6.946/6.946 | 145.000 | 166.000 | d4506f62eb5e30d440a810137aa33ba929f3d57f01622399102ee78575ec4b48 | 通过 |
| stream20 | 200x60 | 2.548/13.948/18.828/18.828 | 5.521/6.591/6.872/6.872 | 25.000 | 246.000 | 91f6e585952e91afb59eb91d47b12b335857f61acac3c6447427dfb4141ba672 | 通过 |
| stream60 | 80x24 | 1.078/4.354/14.830/14.830 | 5.486/6.425/6.646/6.646 | 145.000 | 130.000 | 27617c3a19f410c818fb1810a4a13f8aad826e83437709460b61d648a564de06 | 通过 |
| stream60 | 120x36 | 1.920/2.273/16.190/16.190 | 5.659/6.889/7.214/7.214 | 138.000 | 166.000 | 00ad2ba89d32bb8df469558d4b3d26f5e467fbe672d703f9433001644501116c | 通过 |
| stream60 | 200x60 | 2.936/10.932/17.008/17.008 | 5.558/6.420/7.125/7.125 | 138.000 | 246.000 | fec43d46f6eba95629bd9a7a955a5a286debc267a4faa8975daffbb809507a8e | 通过 |
| stream120 | 80x24 | 1.071/1.272/13.436/15.336 | 5.523/6.439/6.796/7.296 | 140.000 | 129.000 | 6d6ae054fd110ecfb41536b8ed67f570d9763b052871b90dd2d816e13c026648 | 通过 |
| stream120 | 120x36 | 1.946/2.693/13.735/16.335 | 5.540/6.334/6.597/6.818 | 134.000 | 166.000 | 0c3531122e41807d2b44fc5c45e24fee92c6107cb2ec2e6816176ce59b8b2e61 | 通过 |
| stream120 | 200x60 | 2.965/4.229/15.785/17.456 | 5.542/6.856/7.587/7.651 | 134.000 | 246.000 | b5ab29bcddc609472fbf4445c83288906496ae87851eeccd47ee810b1db991cd | 通过 |
| scroll300 | 80x24 | 0.937/1.390/11.949/15.399 | 5.587/6.651/7.183/7.890 | 1426.000 | 2398.000 | 9b1b2c0a545733ca10c543bab356a8418df35aa4dd50535054eda6c4a7afdfd6 | 通过 |
| scroll300 | 120x36 | 1.367/1.712/13.030/13.981 | 5.531/6.209/6.634/7.074 | 1436.000 | 5021.000 | f0432ae66833628b1360b70dcb8b6853ba32d52a25751621dd19154696c0a5bf | 通过 |
| scroll300 | 200x60 | 2.206/2.610/14.438/18.776 | 5.509/6.213/6.755/7.036 | 1436.000 | 13147.000 | 266886b4ce6bef044a5d40db7b7efe11a88ac6763e2c4fb7adf85d7370414986 | 通过 |
| resize | 80x24 | 0.741/0.974/18.709/18.709 | 5.485/6.400/6.532/6.532 | 1812.000 | 2462.000 | eb70a442b64ff6f76aaefbd57d3e599fab3627a18e2d01b631cd4f728c5accf5 | 通过 |
| resize | 120x36 | 1.139/1.389/18.190/18.190 | 5.458/6.375/6.639/6.639 | 1831.000 | 5126.000 | 2d7fbe4bac6eee6f5c40849ebeac52e6a8481ee4ec9901b36c38cc4f68f8c309 | 通过 |
| resize | 200x60 | 1.816/13.839/29.842/29.842 | 5.613/6.628/7.246/7.246 | 1795.000 | 13330.000 | a6bcf3d5b7c52581a267cf9eb9c5f080720b53913ff7a97b26f98b309d811c0a | 通过 |

## M10 相对门槛

| 类别 | 全尺寸相对 frame/write 门槛 |
| --- | --- |
| input | 未通过：input300/80x24, input300/120x36, input300/200x60, paste5000/80x24, paste5000/120x36, paste5000/200x60 |
| scroll | 通过 |
| stream | 未通过：stream20/80x24, stream20/120x36, stream60/80x24, stream60/120x36, stream120/80x24, stream120/120x36 |

| 尺寸 | TS 非 idle 总 frame CPU ms | Rust 非 idle 总 frame CPU ms | 降低 | 40% 门槛 |
| --- | ---: | ---: | ---: | --- |
| 80x24 | 4559.141 | 24537.829 | -438.212% | 未通过 |
| 120x36 | 7094.474 | 24561.435 | -246.205% | 未通过 |
| 200x60 | 11256.792 | 24611.732 | -118.639% | 未通过 |

## RSS

| 目标 | steady p50 MiB | steady p95 MiB | steady max MiB |
| --- | ---: | ---: | ---: |
| TS baseline | 172.0 | 172.0 | 172.0 |
| Rust child | 3.0 | 3.0 | 3.0 |
| GuiHostService + Rust child | 137.6 | 137.6 | 137.6 |

## Development 未达项

无。

## Release 未达项

- input relative frame/write gate: input300/80x24, input300/120x36, input300/200x60, paste5000/80x24, paste5000/120x36, paste5000/200x60
- stream relative frame/write gate: stream20/80x24, stream20/120x36, stream60/80x24, stream60/120x36, stream120/80x24, stream120/120x36
- CPU 80x24: -438.212% < 40%
- CPU 120x36: -246.205% < 40%
- CPU 200x60: -118.639% < 40%

## 历史基线

2026-08-15 的旧 B0 Stop 数据保留为历史性能基线。Yean 于同日调整判定：相对 CPU/写量门槛不再停止 B1-B9 开发，只阻止 M10 默认切换。

## Protocol

公开 `ClientMessage` / `ServerMessage` 是 opaque wrapper，内部 generated Typify 类型与 decoded holder 均为 crate 私有。公开面只保留受控 decode/new/encode、presence、message kind、protocol version 和只读诊断投影；没有 `Serialize`、inner、generated 或 raw 可变引用入口。generated 类型的精确匹配只在 crate 内部 unit tests 中覆盖。
