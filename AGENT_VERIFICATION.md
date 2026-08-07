# AGENT_VERIFICATION

最后核验时间：2026-08-07T16:01:08Z

环境：

```text
Node.js v22.22.2
npm 11.11.0
Bun 1.3.9
Linux x64
```

当前交互 Shell 继承了不安全的 `NODE_TLS_REJECT_UNAUTHORIZED=0`。最终依赖安装、静态检查、离线构建和五平台打包均显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新执行，日志不再出现关闭 TLS 校验警告；正式发布环境不得设置为 `0`。

## 已通过

### `0.84.1-lystar.3` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.3`，Pi workspace 包版本、Session、Agent Runtime、Tool 和 Extension API 均未变化。本版只修复 `/changes` 空文件列表的显示判断：只有 `loadingPath` 确实存在且等于选中文件路径时才显示 Diff 加载态，避免 `undefined === undefined` 将空工作区误判为加载中；修复提交为 `555046f`，新增空工作区回归测试。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新完成 `npm run check`、`npm run build:offline` 和全部发布 gate。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/398 项通过、1 项跳过；Coding Agent 227 个 files/1997 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查再次通过。

五平台候选包使用 Bun `1.3.9` 重新构建，`SHA256SUMS` 五项全部通过，manifest 版本为 `0.84.1-lystar.3`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`；格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。Linux x64 候选包 SHA-256 为 `4bdff0830437d121e3cc3578e01051d277ecb96b240792449ca3dbac04f1be1f`，其 `la --version` 与 `PI_OFFLINE=1 la --list-models` 通过。

最终 Linux x64 候选包在全新且干净的 Git 仓库中以 `80x24` tmux PTY 打开 `/changes`，稳定显示“工作区没有未提交变更”和“没有可审阅的文件”，不再显示“正在读取 Diff...”；`/quit` 正常退出，`lystar-release-0841-3-candidate` tmux server 已关闭。基于最终 `.3` 发布树创建独立 worktree，将上游 `upstream/main` `541ed488d89dbe11395e4c108f448e1e253ae4c1` 的 21 个 Tag 后提交执行 `--no-commit --no-ff` 合并，结果无冲突；合并后的 `npm run check` 和 4 个聚焦测试文件共 39 项通过，模拟 branch 与 worktree 已删除。

### `0.84.1-lystar.2` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.1-lystar.2`，Pi workspace 包版本和基线继续保持 `0.84.1` 与 `53fa77ccd8a279eb87e92294ef3687b03ff80112`。本版将全屏 TUI 调整为轻量任务工作台：活动条只消费真实 Agent/Tool 事件，完成摘要只在 `agent_settled` 后显示且不写入 Session，`/changes` 严格区分本轮 Edit/Write 文件与 Git 工作区变更；没有修改 Pi Session JSONL、Agent Runtime、Tool、Extension API、Provider、CLI 参数或 `PI_*` 契约。

CodeGraph 增量同步 11 个变更文件、637 个节点，`affected` 只指向 `lystar-workspace.test.ts` 和 `task-workbench-components.test.ts`。基于功能提交 `e63bd5d46` 创建独立模拟 worktree，将上游 `upstream/main` `541ed488d89dbe11395e4c108f448e1e253ae4c1` 的 21 个 Tag 后提交执行 `--no-commit --no-ff` 合并，结果无冲突；模拟合并后的 `npm run check` 和 4 个聚焦测试文件共 38 项通过。模拟 branch 与 worktree 已删除，没有进入 `main`。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和发布 gate。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/398 项通过、1 项跳过；Coding Agent 227 个 files/1996 项通过，6 个 files/49 项跳过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

源码构建在独立 tmux PTY 覆盖 `120x36`、`80x24` 和 `80x8`，验证真实 Faux Provider 的思考、Bash、Write、完成摘要、自动重试和取消事件，以及 `/changes` 的本轮/工作区切换和 `/changelog` Overlay；输入区和快捷栏在极小高度保持可见。本轮创建的所有 tmux socket 和临时 Faux 文件均已删除。

五平台候选包使用临时 PATH 中的 Bun `1.3.9` 构建，没有修改项目依赖。`SHA256SUMS` 五项全部通过，manifest 版本为 `0.84.1-lystar.2`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`，五个平台文件、大小和 SHA-256 一致；归档格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，全部包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。Linux x64 候选包 SHA-256 为 `daaa7cf59f204ee5cae0a3aa2a48898ff071e33e09fcd41cb96bc680d7355af6`，其 `la --version`、中文 `la --help`、`PI_OFFLINE=1 la --list-models` 和中文 `la auth --help` 均通过。

Linux x64 候选包在独立 `80x24` tmux PTY 打开 `/changes` 与 `/changelog`，再 resize 到 `80x8` 和 `120x36`，Overlay、顶栏、Composer 和快捷栏均正常；`/quit` 正常退出，`lystar-release-0841-2-candidate` tmux server 已关闭。当前 Linux 环境没有 macOS 实机和 Windows Console/ConPTY 的交互证据；这两个平台当前只验证了格式、架构、归档内容和自动测试，不能视为对应平台实机运行通过。

`main` commit `f9c9fb02323b3019e753a02ca70e2f32cde7399f` 的 CI run `31194116547` 七个 job 全部成功。annotated Tag `v0.84.1-lystar.2` 的 Tag 对象为 `90579650e0026ed38db2542fc69a867b3a7ae62c`，解引用后固定指向该 commit。Release workflow run `31194315795` 成功，GitHub Release 于 `2026-08-07T15:48:17Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产。

公开 Linux x64 包 SHA-256 为 `ac8308b4f06b6420f6b0a32ddb26258ad5960e8d8d8468384850444ef8229ab4`，与公开 `SHA256SUMS`、manifest 和 Release asset 一致；GitHub Attestations API 返回 1 条 Sigstore provenance，绑定 `.github/workflows/release.yml`、Tag `v0.84.1-lystar.2`、commit `f9c9fb023` 和 run `31194315795`。公开包的版本、中文帮助和离线模型列表通过。

本机通过公开 `la update` 从 `0.84.1-lystar.1` 原子更新到 `0.84.1-lystar.2`，`current` 指向 `.2`，`previous` 保留 `.1`，再次更新显示已是最新版本。安装后的真实 Provider PTY 返回 `OK`；随后在干净工作区打开 `/changes`，确认空列表错误持续显示“正在读取 Diff...”。Tag 与 Release 均按历史保留，本问题由后续 `0.84.1-lystar.3` 修复。

### `0.84.1-lystar.1` 发布前核验

上游基线已升级到 Pi `v0.84.1`（`53fa77ccd8a279eb87e92294ef3687b03ff80112`），双 parent merge commit 为 `c13f0ad935403042886d4e179e47febb8c1f6e0f`；LYStar 产品版本为 `0.84.1-lystar.1`，Pi workspace 包版本保持 `0.84.1`。合并保留 `la`、中文全屏工作区、`~/.pi/agent`、项目 `.pi`、`PI_*` 和 `octyean/lystar-agent` 契约，并接入 Qwen Token Plan Individual、`auth check`、blocked `tool_call` 的 `terminate` 结果、活跃运行期间拒绝 `Agent.reset()`、多击文本选择、半页滚动、Windows 全屏右键粘贴、低频鼠标追踪和 Bun cwd `bunfig.toml` 隔离。

离线模型目录完整取自正式 npm 包 `@earendil-works/pi-ai@0.84.1` 的 `dist/providers/data`，manifest 生成时间为 `2026-08-07T05:53:06.539Z`；新增 `qwen-token-plan-individual.json`，GitHub Copilot、OpenCode、OpenRouter 和 Vercel AI Gateway 快照同步更新。`models.generated.ts` 与 `image-models.generated.ts` 和 Pi `v0.84.1` Tag 字节一致，`npm run check:model-data` 通过，没有从实时 API 带入 Tag 之后的数据。

LYStar 全屏继续由 `LystarWorkspace` 管理虚拟历史。工作区输入入口同时识别旧 `app.viewport.*` 与上游新 `tui.altScreen.*` action id，覆盖 `Shift+PageUp/PageDown`、`Ctrl+Home/End`、`PageUp/PageDown`、`Home/End` 和可配置半页滚动；滚轮、点击、运行时 renderer 切换处理器迁移及 SGR `66/67` 横向事件保护保持不变。真实候选包 PTY 首次发现上游默认 `PageUp/PageDown/Home/End` 会被空的继承视口消费，修复后新增真实 renderer 回归覆盖滚轮、整页、半页、首尾和新旧快捷键。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部 workspace 测试。TUI 全量退出码 0；AI 104 个 test files/870 项通过，25 个 files/825 项跳过；Agent Core 20 个 files/398 项通过、1 项跳过；Coding Agent 226 个 files/1986 项通过，6 个 files/49 项跳过。Telemetry 2 个 files/15 项、SQLite Session backend 11 个 files/81 项、Protocol 3 个 files/147 项、Client 6 个 files/36 项、Server 7 个 files/50 项、Evals 4 个 files/23 项全部通过。新增全屏输入定向回归 5 个 files/38 项通过；Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

五平台候选包使用 Bun 1.3.9 构建，`SHA256SUMS` 五项全部通过；manifest 的版本为 `0.84.1-lystar.1`、Pi 版本为 `0.84.1`、仓库为 `octyean/lystar-agent`，五个平台文件、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+；各归档包含对应 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 候选归档 SHA-256 为 `55dbc0dcb9229413cbb60251d0249e6fd34f44fa9fee8ca0285fe499e7ed0b5a`，其 `la --version`、中文 `la --help`、`PI_OFFLINE=1 la --list-models`、中文 `la auth --help` 和无凭据 `auth check --provider anthropic --no-refresh --json` 均通过。

最终 Linux x64 候选包在独立 `80x24` tmux PTY 加载长 Session：`PageUp` 与底部画面哈希不同，`PageDown` 精确回到底部；`Home` 跳到 Session 开头，`End` 精确回到底部；标准 SGR 滚轮、`Ctrl+U` 半页上移和 `Ctrl+D` 半页下移均产生预期画面。`80x8` 与 `120x36` 下顶栏、历史区、Composer 和快捷栏完整；`/settings` 完成全屏到普通再回全屏的双向切换，切回后的 renderer 继续接收滚轮并显示“下方还有 1 行”。双击 SGR 序列注入后进程保持正常，多击选择语义由 TUI 全量回归覆盖；`/quit` 返回码 0，`lystar-pi0841-candidate` 与 `lystar-pi0841-candidate-final` tmux server 均已关闭。

CodeGraph 在上游合并和 LYStar 适配后增量同步 95 个文件、2879 个节点；最终索引为 1186 files、19368 nodes、78069 edges，pending changes 0、`reindexRecommended=false`。`handleWorkspaceInput` 影响面落在构造、运行时模式切换和设置切换链路；affected 结果列出认证、凭据输出、真实 renderer 输入和 TUI wrapper 四个测试文件，均已包含在全量测试中。

`main` commit `298c396b6662342729f86128596bd0533269c350` 的 CI run `31161459499` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows managed MinGit Bash 和 Windows PowerShell 5.1 安装器。annotated Tag `v0.84.1-lystar.1` 的 Tag 对象为 `8925848f498f0a33d7d3dbfe1a4155d252891b3a`，解引用后固定指向该 commit。

Release workflow run `31161640992` 成功，完成 main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-07T08:26:46Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产：五个平台包、`SHA256SUMS`、`release-manifest.json` 和三个安装器。

公开 Linux x64 包 SHA-256 为 `957a33ec572de089ecdb04bd27e387cf7cb47b70a4783737874cb1e9023d200a`，与公开 manifest、`SHA256SUMS` 和 Release asset digest 完全一致；归档包含 `la`、Linux x64 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。GitHub Attestations API 返回 1 条 Sigstore provenance，证书绑定 `.github/workflows/release.yml`、Tag `v0.84.1-lystar.1`、commit `298c396b6` 和 run `31161640992`，subject 为同一 Linux x64 SHA-256。公开包的版本、中文帮助、离线模型列表和无凭据认证检查均通过。

本机通过公开 `la update` 从 `0.84.0-lystar.2` 原子更新到 `0.84.1-lystar.1`；`current` 指向 `versions/0.84.1-lystar.1`，`previous` 保留 `versions/0.84.0-lystar.2`，再次更新显示已是最新版本，`PI_OFFLINE=1 la --list-models` 通过。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 加载长 Session，`PageUp` 显示“下方还有 16 行”，`PageDown` 精确回到底部；全屏与普通模式双向切换后，滚轮仍显示“下方还有 1 行”，`/quit` 返回码 0，`lystar-release-0841-installed` tmux server 已关闭。

当前 Linux 环境没有 macOS 实机和 Windows Console/ConPTY 的交互证据；Windows PowerShell 5.1 安装器、Windows 启动和卸载链已由 main CI 验证。Node.js `v22.22.2` 仍低于 `@earendil-works/gondolin@0.12.0` 声明的 `>=23.6.0`，本轮构建和测试只有已知 engine 警告，没有行为失败。

### `0.84.0-lystar.2` 发布前核验

发布事实源为 `piConfig.productVersion = 0.84.0-lystar.2`，Pi workspace 包版本保持 `0.84.0`。`0.84.0-lystar.1` 的 LYStar 全屏工作区本身管理虚拟历史窗口，但继承的 `TuiAltScreen` 会先消费滚轮和视口快捷键；上游隐式 `ScrollView` 只看到一个刚好等于终端高度的 `LystarWorkspace`，没有可滚内容，真正的工作区输入处理因此收不到事件。运行时从普通模式切换到全屏时，旧 renderer 上注册的工作区监听也没有迁移到新 renderer。

当前修复把 `TuiAltScreen.handleViewportInput()` 调整为受保护的可覆写入口，由 `LystarTUI` 先委托 LYStar 工作区输入；工作区消费滚轮、翻页和实际命中的展开点击，其余鼠标事件继续交给上游文本选择、链接和 ScrollView，弹窗可见时也继续使用上游滚动。工作区处理器随 `createInteractiveTui()` 创建和运行时模式切换绑定，不再维护会丢失的外部 listener。新增真实 renderer 回归发送标准 SGR 滚轮序列 `ESC[<64;10;4M`，验证 30 行历史的首行从 `line-24` 移到 `line-23`；另一项断言确认普通模式切到全屏后同一输入处理仍然存在。

公开 `0.84.0-lystar.1` Linux x64 包加载 178K token 长会话后，发送 `ESC[<64;10;10M` 前后画面完全一致，稳定复现用户报告。修复后的源码构建和最终 `0.84.0-lystar.2` Linux x64 候选包使用同一会话、尺寸和输入序列，均上移一行并显示“下方还有 1 行”；发送滚轮下移后回到底部并恢复自动跟随，`/quit` 正常退出，`lystar-scroll-before`、`lystar-scroll-after-source`、`lystar-scroll-candidate-0840-2` 和 `lystar-scroll-candidate-final-0840-2` tmux server 均已关闭。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、TUI 全量、AI 103 个 test files/849 项、Agent Core 20 个 test files/392 项、Coding Agent 221 个 test files/1948 项和 Unix 安装器验证；AI 跳过 25 个 files/806 项，Agent Core 跳过 1 项，Coding Agent 跳过 6 个 files/49 项。定向回归另覆盖 Coding Agent 38 项，以及上游 `TuiAltScreen`、文本选择、链接、滚动条拖拽、嵌套 ScrollView 和终端模式恢复 26 项；SGR `66/67` 横向触控板事件保持为 `other`，不会被误判成纵向滚轮。

五平台候选包使用 Bun 1.3.9 构建，`SHA256SUMS` 五项全部通过；manifest 版本为 `0.84.0-lystar.2`，Pi 版本、仓库、文件名、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，Linux/Windows 归档包含对应 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 候选包的 `la --version`、`la --help`、`PI_OFFLINE=1 la --list-models` 通过，其 SHA-256 为 `1045222696837b79e2d07334b7e61338f48b09da40792c48e18c18411a4f928b`。

CodeGraph 在核心修复后增量同步 4 个文件、569 个节点，补充横向触控板判定后再同步 2 个文件、6 个节点；基于最新索引的 affected 结果准确指向 `packages/coding-agent/test/interactive-tui.test.ts` 和 `packages/coding-agent/test/mouse.test.ts`。最终索引为 1169 files、19130 nodes、84445 edges，pending changes 0、`reindexRecommended=false`。由于修改仍经过公共 `TuiAltScreen` 输入入口，本轮额外用 TUI、AI、Agent Core 和 Coding Agent 全量测试覆盖。

`main` commit `0e496a61efc917b91f65099b1fb0a35f56005d72` 的 CI run `31148814839` 七个 job 全部成功，覆盖源码核验与构建、Unix 安装器、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows managed MinGit Bash 和 Windows PowerShell 5.1 安装器。annotated Tag `v0.84.0-lystar.2` 的 Tag 对象为 `329f7dc1d56bcc4d7231dc413a79190d8a0a7f19`，解引用后固定指向该 commit。

Release workflow run `31148934869` 成功，完成 main CI 绑定、版本校验、离线构建、Bun 1.3.9 五平台打包、artifact attestation 和公开发布。GitHub Release 于 `2026-08-07T04:56:55Z` 发布，为非草稿、非预发布正式版本，共有 10 个公开资产：五个平台包、`SHA256SUMS`、`release-manifest.json` 和三个安装器。

公开 Linux x64 包 SHA-256 为 `4ffb1f7bd286bd23252afa276ce54f78ca3c8c800488964d9396d318cf71965a`，与公开 manifest、`SHA256SUMS` 和 Release asset digest 完全一致；归档包含 `la`、Linux x64 clipboard 原生包、`LICENSE` 和 `THIRD_PARTY_LICENSES.md`。GitHub attestations API 返回 1 条 Sigstore provenance，绑定 `.github/workflows/release.yml`、Tag `v0.84.0-lystar.2`、commit `0e496a61e` 和 run `31148934869`，subject 中包含同一 Linux x64 SHA-256。

本机通过公开 `la update` 从 `0.84.0-lystar.1` 原子更新到 `0.84.0-lystar.2`；`current` 指向 `versions/0.84.0-lystar.2`，`previous` 保留 `versions/0.84.0-lystar.1`，再次更新显示已是最新版本，`PI_OFFLINE=1 la --list-models` 通过。安装后的 `/home/yean/.local/bin/la` 在独立 `80x24` tmux PTY 中加载同一 178K token 长会话，标准 SGR 上滚后画面移动并显示“下方还有 1 行”，下滚后恢复自动跟随，`/quit` 正常退出，`lystar-scroll-installed-0840-2` tmux server 已关闭。

当前环境没有 macOS 实机和 Windows Console/ConPTY 的鼠标滚轮交互证据；Windows 安装、版本启动和卸载链已由 main CI 的 Windows PowerShell 5.1 环境验证。

### `0.84.0-lystar.1` 发布前核验

上游基线已升级到 Pi `v0.84.0`（`a5f43bf8aff3c55752432655f7334e3dafd1e256`），LYStar 产品版本为 `0.84.0-lystar.1`，Pi workspace 包版本保持 `0.84.0`。合并保留 `la`、`LYStar Agent`、`~/.pi/agent`、项目 `.pi`、`PI_*` 和 `octyean/lystar-agent` 契约；上游 Harness v2、Telemetry、SQLite Session backend、Protocol、Client、Server、模型与 Provider 变更均已接入。离线模型目录来自正式 npm 包 `@earendil-works/pi-ai@0.84.0`，manifest 生成时间为 `2026-08-06T11:03:30.465Z`；`models.generated.ts` 和 `image-models.generated.ts` 与 `v0.84.0` Tag 字节一致，没有带入 Tag 之后的实时模型数据。

TUI 使用上游 renderer 分层：普通模式为 `TuiMainScreen`，全屏模式为基于 `TuiAltScreen` 的 `LystarTUI`。LYStar 全屏路径保留最后一列、绝对坐标重绘、500ms 完整校准、stdout backpressure、固定输入区、单行滚轮、鼠标和中文工作区；支持上游 `--tui-mode regular|fullscreen`，并兼容旧 `--alt-screen auto|always|never`、`--no-alt-screen` 与 `--mouse`。运行时可在设置中切换普通/全屏模式，稳定 TUI Proxy 会迁移 children、focus、terminal 和设置，不保留第二套 renderer。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline` 和全部 workspace 测试。TUI 全量通过；AI 103 个 test files、849 项通过，25 个 files、806 项跳过；Coding Agent 1947 项通过；Agent Core 20 个 test files、392 项通过、1 项跳过；Telemetry 2 个 files、15 项通过；SQLite Session backend 8 个 files、77 项通过；Protocol 3 个 files、147 项通过；Server 7 个 files、50 项通过；Client 6 个 files、36 项通过；Evals 4 个 files、23 项通过。Unix 安装器的安装、PATH、SHA 校验、回退、卸载和物化检查通过。

源码构建在独立 tmux PTY 中覆盖 `80x24`、`80x8`、`120x36` resize；真实 TTY 验证 `/settings` 中文“界面模式”、普通/全屏双向切换和“全屏滚动条”设置。Linux x64 候选二进制在 `80x24` 全屏启动并通过 `/quit` 正常退出，终端模式得到恢复；本轮创建的 `lystar-pi0840-upgrade` 和 `lystar-pi0840-candidate` tmux server 已关闭。滚轮单行、鼠标协议、剪贴板查询与复制反馈由 TUI/Coding Agent 自动回归覆盖，本轮没有在交互式 tmux 中逐项手动注入鼠标和系统剪贴板事件。

五平台候选包使用 Bun 1.3.9 构建，`SHA256SUMS` 五项全部通过；manifest 的版本、Pi 版本、仓库、文件名、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，全部归档包含 `LICENSE`、`THIRD_PARTY_LICENSES.md`、可执行文件和对应平台 clipboard 包。Linux x64 归档的 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过，其 SHA-256 为 `e9b61a6f6f9636802a753e30f47f2195ae0729c393aea113f9daf837b6e4ef09`。

CodeGraph 已按 extraction version 24 完整重建到 1169 个文件、19126 个节点和 85027 条边，pending changes 为 0，`reindexRecommended=false`；核心 TUI、Agent、设置、凭据与 OpenAI Responses 入口共追踪 239 个依赖节点，列出的受影响测试均包含在本轮全量测试中。另复跑 12 个兼容测试文件、389 项，覆盖旧 `-c`/`-r` 参数解析、旧 settings、Session 迁移、Package、Skill、Extension 和 `pi-mcp-adapter` 配置读取。

`main` CI run `31143661232` 在 commit `da41aad352d20f08677ed3bbd793687abfb06030` 上全部成功，覆盖源码、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows MinGit Bash 和 PowerShell 5.1 安装器。annotated tag `v0.84.0-lystar.1` 指向同一 commit；Release workflow run `31143930706` 通过 CI 门禁、离线构建、五平台打包、版本校验、artifact attestation 和公开发布。Release 于 `2026-08-07T03:19:32Z` 发布，为正式非草稿版本；五个平台包、三个安装器、`SHA256SUMS` 和 manifest 共 10 个公开资产。

公开 Linux x64 包 SHA-256 为 `847b856d640d2ee8c17ea5c04075378fe501c3ce897ea4d39c87385e400332f5`，与公开 manifest、`SHA256SUMS` 和 GitHub Release digest 一致；GitHub attestations API 返回 1 条 Sigstore provenance，绑定 `release.yml`、Tag、commit 和 Release run。本机通过旧版 `la update` 从 `0.83.0-lystar.7` 原子升级到 `0.84.0-lystar.1`，`current` 指向新版本，`previous` 保留 `0.83.0-lystar.7`；再次更新显示已是最新版本。公开安装后的 `la` 在独立 `80x24` tmux PTY 中使用 `upstream/gpt-5.6-sol` 对“只回复：LYSTAR-0840-OK”返回精确结果 `LYSTAR-0840-OK`，随后 `/quit` 正常退出，本轮 socket 已关闭。

当前环境没有 macOS 实机，也没有 Windows Console/ConPTY 的交互式应用运行证据；Windows 安装、启动版本检查和卸载已由 GitHub CI 的 PowerShell 5.1 环境验证。

### `0.83.0-lystar.7` 发布前核验

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.7`，Pi 包版本保持 `0.83.0`。全屏工作区滚轮从按视口高度放大的每次 2 至 8 行改为固定 1 行；PageUp、PageDown、Home、End、鼠标协议、Pi 公共 TUI renderer、Session、Tool 和 Extension API 均未修改。回归覆盖 3、8、24、60 行视口，以及 500 行历史连续向下 80 次、向上 80 次滚动，每个事件均移动一行。

源码构建后的真实 tmux PTY 在 `80x24`、当前 SSH/tmux 的 `77x59` 和 `120x36` 下验证：一次滚轮事件只移出对话区顶部一行并从底部补入一行，终端高度不再改变速度。Linux x64 候选归档在 `80x24` 下从历史顶部滚动一次后，“下方还有 51 行”变为 50 行，`/quit` 正常退出；本轮创建的 tmux server、socket 和临时目录均已清理。

显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、TUI 全量、AI 96 个 test files 共 767 项、Coding Agent 192 个 test files 共 1742 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。Agent Core 的截断输出用例在四 workspace 并行时因资源竞争缺少末尾输出，单独全量复跑全部通过，没有持续断言失败。

五平台包使用 Bun 1.3.9 构建，`SHA256SUMS` 全部通过；manifest 的版本、Pi 版本、仓库、五个平台文件、大小和 SHA-256 一致。格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+，全部归档包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。Linux x64 候选归档的 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过。CodeGraph 增量同步后，影响面收敛到 `LystarWorkspace` 和对应回归测试；Windows 与 macOS 本轮只完成归档格式、架构、SHA 和自动测试核验，没有对应系统实机运行证据。

### `0.83.0-lystar.6` 发布前核验

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.6`，Pi 包版本保持 `0.83.0`。`.5` 保留最后一个物理列只能避开自动换行触发条件，不能修复实际终端光标与 renderer 内部 `hardwareCursorRow` 失配。`.6` 让 LYStar fullscreen 使用固定视口路径：每个变更范围先按绝对行列清理，再按绝对行列写入；画面、Kitty 图片和硬件光标合并到同一个 synchronized-output 写入块；不发送换行、相对上下移动或 `CSI 2J`。每 500ms 的活跃渲染至少执行一次完整逐行覆盖，使外层终端丢失或错放中间帧后能在下一校准帧恢复。inline 模式继续走 Pi 原 renderer，消息事件、Workspace、Session、Tool 和 Extension API 未改。

确定性故障注入先在旧实现复现三项失败：把真实光标拨到第 1 行后，更新第 3 行会错误覆盖顶栏；外部覆盖顶栏后，同内容重绘无法恢复；画面与 IME 光标分两次写入。新路径对应回归全部通过，并覆盖 Kitty 图片先清占位行再绘制、越界组件的 ANSI 感知裁切、物理末列光标、overlay 安全宽度、`80x8 -> 120x36` resize 和 stdout 背压只保留最后一帧。

Linux 使用不经过 tmux 的真实 PTY 在 `80x8`、`80x24`、`120x36` 下各执行 120 次中文流式重排，并主动注入错误光标坐标和 `CORRUPT-HEADER`。每种尺寸均得到 31 个绘制帧和 3 次完整校准；ANSI 回放确认顶栏、最终内容、Composer 和快捷栏完整，污染文本消失，scroll buffer 未增长，所有文本绘制避开物理最后一列。独立 tmux socket 另完成 `80x24` 原始转发回放，以及运行中 `80x8 -> 120x36` resize；resize 后出现 3 个覆盖至第 36 行的完整帧，最终固定区域完整。真实 `tmux attach` 外层输出中，未变化的顶栏随校准帧重新发送了 3 次；在第 58 帧后只污染外层终端、不修改 tmux 内部画面，继续回放后顶栏、最终第 120 帧和固定底栏全部恢复。本轮 socket 已关闭。

OpenAI Responses 增加 opt-in 的托管 `web_search`：模型或 Provider 设置 `compat.supportsWebSearch = true` 后，请求附带 `tools: [{ type: "web_search" }]` 和 `web_search_call.action.sources` include；流结束时从搜索 action 与 URL citation 收集、规范化并去重来源，通过正常 text 事件追加到同一 AssistantMessage。`models.json` schema 已接通该字段，其他模型默认关闭。两项新增协议回归通过；最终离线构建使用本机 `upstream/gpt-5.6-luna` 做真实请求，正文返回 OpenAI 官方 Web Search 指南 URL，并收到完整来源列表。

`npm run check`、`npm run build:offline`、TUI 全量、AI 96 个 test files 共 767 项、Coding Agent 192 个 test files 共 1741 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器通过；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。五平台最终打包显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1`，SHA-256、manifest 版本/Pi 版本/仓库/资产大小、许可证和 executable 格式全部通过。Linux x64 候选归档的 `la --version`、`la --help`、离线模型列表通过；候选二进制在 `80x24`、`80x8`、`120x36` 下保留顶栏、Composer、模型状态和快捷栏，`/quit` 正常退出。安全重打包前后的 Linux x64 可执行文件 SHA-256 相同，本轮 tmux socket 已确认关闭。

CodeGraph 增量同步后，影响面收敛到 OpenAI Responses 参数/流处理、`models.json` compat、`TUI.doRender()`、`LystarTUI` 和四份受影响测试。与最新 `upstream/main = aa0ec808b970db31822e07835a46647cb51d9d66` 的临时 commit 合并预演显示：上游新增 `TuiBase/TuiAltScreen` 重构已使当前 HEAD 存在基线冲突；本轮把回归放入独立测试文件后，没有增加冲突文件。上游 alt-screen 同样采用绝对行地址，但目前仍使用 `CSI 2J` 且没有周期自校准，后续升级需将本轮减一列和校准规则移植到该 renderer。当前环境没有 Windows Console/ConPTY、macOS cmux 客户端实机证据；应用能保证后续完整帧恢复，不能保证第三方终端直接丢弃整次写入时该单帧完全不闪。Windows 和 macOS 本轮只完成归档格式、架构、SHA 和自动测试核验。

### `0.83.0-lystar.5` 发布前核验

本版针对普通终端和 Windows Console/ConPTY 一类终端的右边界滚屏，在 `LystarTUI` fullscreen 下保留最后一个物理列，基础帧和 overlay 使用同一安全宽度。该措施消除了满宽自动换行这一触发条件，并通过 Linux PTY 验证；后续 cmux/SSH/tmux 新会话仍复现坐标漂移，证明它不能修复相对坐标 renderer 的内部光标账本失真，完整修复见上方当前未发布记录。inline 模式仍使用完整宽度并保留现有自动换行生命周期。

Pi 公共 TUI renderer 只增加一个默认返回 `terminal.columns` 的受保护渲染宽度入口，并在 `doRender()` 使用该入口；默认行为、`Terminal` 接口、差量算法、Session、Tool 和 Extension API 均未改变。LYStar 的减一列策略留在自身维护文件，上游合并影响限制在公共 TUI 的一个方法和一行取值。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.5`，Pi 包版本保持 `0.83.0`。使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成 `npm run check`、`npm run build:offline`、TUI 全量、AI 95 个 test files 共 765 项、Coding Agent 192 个 test files 共 1739 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。

Linux 使用 `script(1)` 创建不经过 tmux 的真实 PTY，在 80x8、80x24 和 120x36 下分别连续执行 120 次中文流式更新。原始 ANSI 逐帧回放得到 41、42、42 个绘制帧：三种尺寸均未使用物理最后一列，alternate screen 滚屏为 0，重复段落为 0 帧，输入框缺失为 0 帧。Linux x64 候选归档的 `la --version`、`la --help`、`PI_OFFLINE=1 la --list-models` 通过；候选二进制在 80x24、80x8、120x36 真实 PTY 中保留 Composer、模型状态和快捷栏，`/quit` 正常退出。

五个平台归档的 SHA-256、manifest 版本与仓库、资产大小、许可证和 executable 格式通过。CodeGraph 增量同步与 affected 检查完成；`LystarTUI` 调用入口仍只有 `InteractiveMode`，影响面覆盖流式消息、Tool、状态、Extension UI、overlay、resize 和退出生命周期。临时 PTY 文件与本轮 tmux socket 已清理；macOS 和 Windows 只完成归档格式、架构和自动测试核验，没有对应系统实机运行证据。

### `0.83.0-lystar.4` 发布前核验

本版为 Provider 流阶段失败补充结构化 `provider_stream_failure` 诊断，覆盖 Responses `response.failed`、流内 `error`、提前 EOF 和迭代读取异常。自动重试先排除鉴权、配额、参数、上下文、模型和策略等永久错误，再按结构化诊断处理未来未知流错误；默认最多重试 5 次，间隔为 1s、2s、4s、8s、16s。文本兼容分类中的 `ended without` 收紧为 `stream ended without`，避免确定性的 Provider 协议错误耗尽 31 秒重试预算。

Release workflow 会等待同一 commit 的 main push CI 完成，成功后继续发布，失败则阻止；Node 固定为 `22.19.0`，npm 参数与 main CI 对齐，Checkout、Node、Bun 和 attestation Action 固定到明确 commit。Tag 与源码版本在安装依赖前校验，产物版本在打包后再次校验。真实成功 CI run `30688818708` 可通过门禁，真实失败 run `30688294491` 被阻止。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.4`，Pi 包版本保持 `0.83.0`。`npm run check`、`npm run build:offline`、TUI 全量、AI 95 个 test files 共 765 项、Coding Agent 192 个 test files 共 1738 项、Agent Core 18 个 test files 共 241 项和 Unix 安装器通过；AI 跳过 25 个 files、784 项，Coding Agent 跳过 6 个 files、48 项，Agent Core 跳过 1 项。

五个平台归档的 SHA-256、manifest 版本与仓库、资产大小、许可证和 executable 格式通过。Linux x64 候选包的 `la --version`、`la --help`、`PI_OFFLINE=1 la --list-models` 以及 80x24、80x8、120x36 真实 PTY 通过，本轮 tmux socket 与临时依赖目录已清理；macOS 和 Windows 只完成归档格式、架构和自动测试核验，没有对应系统实机运行证据。

### `0.83.0-lystar.3` 发布前核验

本版包含 `0.83.0-lystar.2` 的 TUI 信息层级与 Windows 一键安装修复，并修正 Release 五平台打包的依赖物化方式。旧脚本在根 monorepo 已执行 `npm ci` 后再次运行 `npm install --force`，GitHub runner 自带的 npm `10.9.8` 连续触发 Arborist `edgesOut` 内部异常。当前脚本把六个平台的 clipboard 原生包安装到独立临时目录，归档直接从该目录取对应平台文件，不再改写根 `node_modules`；成功、失败和退出都会清理临时目录。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.3`，Pi 包版本保持 `0.83.0`。npm `10.9.8` 与 Bun `1.3.9` 已完成 Windows x64 单平台打包回归，zip、manifest 和临时目录清理通过。使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新完成 `npm ci --ignore-scripts`、`npm run check`、`npm run build:offline`、TUI/AI/Coding Agent/Agent Core 全量测试、Unix 安装器和五平台离线打包。

结果：TUI 全量通过；AI 95 个 test files、755 项通过，25 个 files、784 项跳过；Coding Agent 192 个 test files、1736 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。五个平台归档的 SHA-256、manifest 版本与仓库、资产大小、许可证和可执行格式全部通过；Windows zip 包含 `clipboard-win32-x64-msvc` 平台包及正确的 `.node` 文件。Linux x64 归档的版本、帮助、离线模型列表和 80x24、80x8、120x36 真实 PTY 通过，本轮 tmux socket 与临时目录已清理。

### `0.83.0-lystar.2` 发布前核验（未创建 Release）

本版调整 TUI 信息层级：顶栏按宽度保留产品、项目、分支、会话和上下文，用单行摘要替代启动资源墙，用户消息增加任务轨道，Composer 集中展示模型、思考强度和项目可信状态，快捷操作与累计用量合并为单行。主题文件、Pi 公共 TUI renderer、Session、Tool 和 Extension API 均未修改。

Windows 一键安装入口增加 60 秒超时、三次重试和 MB 大小提示；PowerShell 安装器改从 `release-manifest.json` 获取版本、Windows 资产与预期大小，下载后同时校验大小和 SHA-256。托管 MinGit 下载也按 MB 显示。Windows CI 已改为物化当前安装器后真实执行安装、`la --version` 和卸载，并在结束时恢复用户 PATH。

发布事实源为 `piConfig.productVersion = 0.83.0-lystar.2`，Pi 包版本保持 `0.83.0`。使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量通过；AI 95 个 test files、755 项通过，25 个 files、784 项跳过；Coding Agent 192 个 test files、1736 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。静态检查、离线构建和 `git diff --check` 通过。

五个平台归档的 SHA-256 全部通过，manifest 的版本、Pi 版本、仓库、文件大小和五个平台资产一致；归档均包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。产物格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。Linux x64 归档的 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过；发行包真实 PTY 覆盖 80x24、80x8、120x36 resize 和 `/quit` 退出恢复，本轮 tmux socket 与临时目录已清理。Windows PowerShell 5.1 的真实安装、启动和卸载由 main push CI run `30688225986` 执行并通过。

Tag `v0.83.0-lystar.2` 已推送且保持不可变；Release workflow run `30688294491` 在五平台打包阶段连续两次触发 npm `10.9.8` Arborist `Cannot read properties of null (reading 'edgesOut')`，版本校验、attestation 和资产发布均未执行，GitHub Release 未创建。修复进入新的 `0.83.0-lystar.3`，不移动或复用 `.2` tag。

### `0.83.0-lystar.1` 发布前核验

上游基线已升级到 Pi `v0.83.0`（`845d6ff1f6643aba440341cce877ce1c43ebbc39`），上游 merge commit `87fe99f9` 的第二个 parent 为该 commit。LYStar 保留 `la` 命令、中文产品配置、全屏 TUI、Session/Extension/Tool 契约和 `octyean/lystar-agent` 发行源，并合入凭据导出、OpenRouter 远程登录、请求级 `fetch`、`rawStopReason`、`ctx.scopedModels`、Session 重绑保护、并发 Bash 取消和 Resource Loader 修复。发布事实源为 `piConfig.productVersion = 0.83.0-lystar.1`，Pi 包版本为 `0.83.0`。

使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量退出码 0；AI 95 个 test files、755 项通过，25 个 files、784 项跳过；Coding Agent 192 个 test files、1733 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。`main` CI run `30498563387` 全部通过，覆盖源码、构建、TUI、AI、Agent Core、Coding Agent 双分片，以及 Windows MinGit Bash 和 PowerShell 5.1 安装器。

五个平台归档的 SHA-256 全部通过，manifest 的版本、Pi 版本、仓库、文件大小和五个平台资产一致；全部归档包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。从 Linux x64 归档运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过；真实 PTY 覆盖 80x24 启动、80x8 和 120x36 resize、无模型提示和 `/quit` 退出恢复。本轮独立 tmux socket 与临时文件已关闭并清理。Windows 与 macOS 以 CI、归档格式、架构和 SHA 为证据，未做对应系统的二进制实机运行。

### `0.82.1-lystar.11` 发布前核验

本版将全屏历史区改为有界双向滑动窗口，只保留视口前后缓冲区；离开窗口的渲染块会释放，主题等全局失效在历史块再次进入窗口时执行。顶栏上下文用量改为按 Session、消息数量、模型和完成事件刷新，不再随每个 TUI 帧扫描完整会话。Pi 的 TUI renderer、Session、Tool、Extension API 和存储格式未修改。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.11`。以下 gate 通过：

```bash
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1696 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。五个平台归档的 SHA-256 全部通过，manifest 的版本、Pi 版本、仓库和五个平台资产一致；macOS ARM64/x64、Linux ARM64/x64、Windows x64 格式正确，全部归档包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 包通过 `--version`、`--help` 和离线模型列表 smoke。

确定性回归使用 5000 个历史组件验证：跳到首屏和深度滚动后的单帧只读取少于 200 个组件；可从首屏连续翻到 `message-4999` 并恢复 following；全局失效只刷新可见窗口；离开窗口的块缓存会释放。顶栏上下文用量在状态未变化的连续帧只计算一次。

最终 Linux x64 二进制使用 16 MB、3346 条记录的真实 Session 在 PTY 验证：100x30 同机对照中，`.10` 跳到历史开头为 167ms，当前实现为 46ms；最终 `.11` 包在 80x24 下跳顶为 40ms，连续 120 次翻页与输入在 703ms 内完成，120x36 resize 后输入框、Footer 和快捷栏完整，tmux `history_size=0`。本轮独立 socket 和临时 Session 已关闭并清理。

CodeGraph 增量同步和 affected 检查完成，影响面收敛到 `LystarWorkspace`、Interactive 顶栏组合逻辑及两个对应测试文件。上游 Pi 公共包和协议没有变化。

### `0.82.1-lystar.10` 发布前核验

本版将同轮 Bash 命令组改为执行期间展开、全部结束后自动折叠，并为折叠摘要补齐块间距；上下文压缩触发续跑时恢复“正在执行...”状态和终端 progress。Session 格式、Agent 行为、Tool 协议与 Extension API 保持原样。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.10`。以下 gate 通过：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1692 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器通过。五个平台归档的 SHA-256 全部通过，manifest 版本、Pi 版本、仓库和五个平台资产一致；格式覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。

Linux x64 发行包使用真实历史 Session 在 100x30 PTY 验证：4 条已完成 Bash 命令默认折叠为 `4 条命令执行完成`，摘要前后保留空行，点击摘要后 4 条命令全部展开。本轮 tmux socket 和临时 Session 已关闭并清理。

五平台打包会物化发行依赖，不能与读取根 `node_modules` 的 Vitest 并行。一次并发尝试导致 Vitest worker 短暂缺少 `vite/module-runner` 等文件，并使 Agent Core 50ms 超时用例在资源竞争下失败；重新执行 `npm ci --ignore-scripts` 后，Coding Agent 和 Agent Core 单独全量复跑均通过。后续可并行各测试 workspace，但发行打包必须放在测试之后。

### `0.82.1-lystar.9` 发布前核验

本版修复 `/resume` 选择器获得焦点后不可见、长 Session 首帧同步物化全部历史、Session 切换继承旧滚动状态、普通 Tool 消息紧贴和图片剪贴板在 SSH/tmux 中失效的问题。Session 格式、Agent 行为、Tool 协议、Extension API 与 `PI_*` 契约保持原样。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.9`。使用 Node.js 22.22.2、npm 11.11.0、Bun 1.3.9 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

结果：静态检查、离线构建和 Unix 安装器通过；TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1691 项通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过。

真实 PTY 使用 16 MB、3327 条消息的 Session 验证：`/resume` 列表 251ms 内出现，选择后 368ms 内显示历史尾部和继续提示；首帧只物化当前视口尾部，向上翻页可渐进加载旧历史。100x30 下普通 `read/edit/write/bash` Tool 之间保留一行间距，alternate screen 的 `history_size` 保持 0。

图片粘贴保留 native、Wayland、X11 和 WSL 后端，并新增 Kitty OSC 5522 MIME 查询、分片合并、50 MB 上限与 tmux passthrough。协议单测覆盖 MIME 列表、图片优先级、分片、无匹配类型、tmux 包装和输入隔离；真实 SSH/tmux PTY 注入 OSC 5522 响应后，输入框出现临时 PNG 路径且文件字节正确。无可用后端时显示可操作的中文提示，不再静默吞掉失败。

五平台包使用 Bun 1.3.9 构建，五个归档的 `SHA256SUMS` 全部通过；manifest 的版本、Pi 版本、仓库、文件、大小和 SHA-256 一致；归档均包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。格式核验覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。

从 Linux x64 归档运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过。发行包真实 PTY 覆盖 80x24 启动、80x8 和 120x36 resize、OSC 5522 图片粘贴、固定输入区、退出恢复和 `history_size = 0`；本轮独立 tmux socket 与临时文件已关闭并清理。Windows 与 macOS 仍以自动测试、归档格式、架构和 SHA 为证据，不宣称本地实机运行。

CodeGraph 在修改后完成增量同步；`queryTerminalClipboard` 影响面收敛到 TUI 协议处理、`handleClipboardPaste` 和对应测试，Tool 间距影响实时事件与历史重建两条渲染路径。

### `0.82.1-lystar.8` 发布前核验

本版完成 CI 并行拆分、长会话块缓存、Footer 用量缓存、自适应滚动、结构化 Composer、上下文快捷栏、Windows 内置安全字符、同轮 Bash 命令组和 TPS 中文化。Session、Tool、Extension、Provider 与 `PI_*` 契约保持原样。

发布版本事实源为 `packages/coding-agent/package.json` 中的 `piConfig.productVersion = 0.82.1-lystar.8`。以下 gate 在该版本号下通过：

```bash
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
```

结果：TUI 全量退出码 0；AI 670 项通过、783 项跳过；Coding Agent 187 个 test files、1688 项测试通过，6 个 files、48 项跳过；Agent Core 241 项通过、1 项跳过；Unix 安装器完整链路通过。

五平台产物使用 Bun 1.3.9 和 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新构建。五个归档的 `SHA256SUMS` 全部通过；manifest 版本、Pi 版本、仓库、平台文件、大小和 SHA-256 一致；归档均包含 `LICENSE` 与 `THIRD_PARTY_LICENSES.md`。格式核验覆盖 macOS ARM64/x64 Mach-O、Linux ARM64/x64 ELF 和 Windows x64 PE32+。

从 Linux x64 归档解压后，`la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models` 通过。真实 PTY 覆盖 80x24 输入、80x8 Bash 运行状态与动态 `Esc 取消`、120x36 resize 和退出恢复；本轮独立 tmux socket 已关闭。Windows 安全字符分支通过自动测试，Windows 与 macOS 仍以 GitHub runner、归档格式和架构为证据，不宣称本地实机运行。

静态检查与离线构建：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
```

Coding Agent 全量测试：

```bash
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
```

结果：184 个 test files 通过、6 个跳过；1672 项测试通过、48 项跳过。Token 请求前保护、连续 Tool Result 压缩切点、托管 Bash Shell 解析和既有 Session/Extension 链路均已覆盖。

README 与中文文档：

- 根 README 已改为普通用户入口，明确独立发行包无需 Node.js，Unix 安装命令使用 Bash。
- `docs/` 已拆分安装、快速开始、Provider、中国大陆网络、TUI、Session、配置、更新、生态、排障和开发文档。
- 一次性 Node 链接检查覆盖 README 与 `docs/` 共 24 个 Markdown 文件，本地链接目标全部存在。
- 最终用户文档未发现残留 `pi install`、`pi update` 或 `install.sh | sh` 命令。
- README 使用当前源码、隔离配置和本地假 Provider 在 120x30 真实 PTY 中生成的 1280x680 PNG；Playwright 截图后已关闭本轮浏览器和 tmux 会话。

TUI 全量测试：

```bash
npm --workspace @earendil-works/pi-tui test
```

结果：退出码 0。包含 alternate screen、SGR mouse 和 reduceMotion 新增回归。

AI 全量测试：

```bash
npm --workspace @earendil-works/pi-ai test
```

结果：89 个 test files 通过、25 个跳过；670 项测试通过、783 项跳过。

Agent Core 全量回归：

```bash
npm --workspace @earendil-works/pi-agent-core test
```

结果：18 个 test files、240 项测试通过，1 项跳过。`preserves truncated output when a command times out` 改为使用 Bash 内建 `printf` 一次生成 3000 行，再保留真实 50ms 超时和完整输出首尾断言；该用例连续复跑 10 次通过，Agent Core 全量回归通过。

Unix 安装器安装、PATH、校验失败、回退、卸载和用户数据保留：

```bash
bash scripts/test-install-sh.sh
```

结果：本地假 Release 分别通过 curl 和仅 wget 下载，latest manifest 版本解析、SHA-256、executable smoke、PATH 幂等写入、`--no-path-update`、坏 SHA 拒绝、回退、卸载和 release materialization 全部通过。该测试不访问网络，已加入 CI 与 Release workflow。

Windows 安装器源码继续保持 UTF-8 BOM 和 CRLF；`0.82.1-lystar.7` 修复托管 MinGit staging 自检遗漏自身 PATH 的问题。自检现在显式加入 `cmd`、`mingw64/bin` 和 `usr/bin`，并先确认 `where.exe git.exe` 的首个结果位于托管目录。Windows 集成 gate 会移除 runner 预装 Git 后并发准备 MinGit，避免系统 Git 再次遮住缺陷。

Release workflow 在 tag 触发后通过 GitHub Actions API 核对同一 commit 已有成功的 `main` CI，且该 run 必须来自 `main` push；核验后只执行依赖安装、离线构建、五平台打包、版本校验、attestation 和发布，不再重复全量测试与 Windows 集成 gate。API 查询已用 `0d684429` 的成功 CI 验证返回 1 条。

五平台独立发行包：

```bash
bash scripts/build-binaries.sh --offline-model-data
cd packages/coding-agent/binaries
sha256sum -c SHA256SUMS
```

结果：`0.82.1-lystar.6` 的 macOS ARM64/x64、Linux ARM64/x64、Windows x64 五个压缩包全部校验通过。`release-manifest.json` 的版本、Pi 版本、仓库、五个平台文件、大小和 SHA-256 与产物一致；归档包含 `LICENSE` 和 `THIRD_PARTY_LICENSES.md`。Linux x64 包已实机运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models`；Windows x64 executable 已核对为 PE32+ x86-64。

真实 PTY 使用独立 tmux socket 和临时工作目录验证：

- 120x36 首次启动显示中文主题选择。
- 120x36 主界面显示固定顶栏、独立对话区、输入区和快捷栏。
- 顶栏持续显示工作目录、Git 分支、会话名和上下文占用；Footer 删除重复的工作目录与会话名。
- Footer 只占一行，使用中文标签和大写 `K/M/B`，不再显示 `↑/↓/R/W/CH`；完整输入量与 `/session` 口径一致，缓存读取和缓存写入作为输入细分项按宽度显示。
- 使用包含 8 次压缩的真实 Session 快照验证 58x20 Footer 显示 `输入 276M · 输出 595K · 缓存读取 271M · 本次命中 99.5%`，顶部上下文显示 `242K/272K`。
- 80x8 同时保留单行 Footer、单行 Extension 状态、三行输入框和单行快捷栏；58x20 快捷栏显示 `Shift+Tab 思考强度 │ Esc 取消 │ Ctrl+O 展开 │ /`，不再换行。
- 多 Provider 时 provider、模型、双语思考强度和信任状态统一显示在 composer 边框，分隔符使用紧凑的 ` · `；`/session` 标题为 `Token 用量（会话累计）`。
- Shell 执行图标改为 `$`；折叠状态点击摘要任意位置可展开，展开后点击输出中间行可收起。Shift+点击输出行保持展开并交给终端文字选择。
- 三行输入时 `❯` 位于中间行；单行和多行输入都保持稳定边框。
- `high` 显示为 `高(high)`；默认展开模型返回的思考过程正文，用户仍可主动折叠。
- 80x24 下连续执行 Bash、创建、编辑和读取操作，成功结果各占一行；点击摘要可展开，点击已展开内容的任意行可收起。
- 58x20 移动端宽度下，20 行 Shell 输出默认保持一行摘要，输入区、Footer 和 `Esc 取消` 快捷提示保持可见。
- Markdown 代码围栏默认隐藏，长代码行换行后每行保留左侧 `│`；`/settings` 可搜索并切换“Markdown 代码围栏”。
- 80x8 下叠加 10 行 Extension Widget，输入框与快捷栏仍保留最后 4 行，附加状态只使用剩余空间。
- `/settings` 显示中文设置名、中文枚举值、Markdown 围栏开关和明确的搜索提示。
- `/session`、`/hotkeys`、分支、压缩、登录、Shell 状态和常见错误使用中文界面文案。
- resize 后布局保持终端总行数，无控件重叠或进程退出。
- 从 `0.82.1-lystar.5` Linux x64 发行包启动 80x24 真实 PTY，输入框、项目信任、快捷栏和退出恢复正常。
- README 截图使用本地 OpenAI 兼容假 Provider 完成一轮中文问答，不读取真实认证、不消耗真实模型额度；图片中文字、上下文、输入框、累计用量和快捷栏无裁切。
- 生态资源在独立 `PI_CODING_AGENT_DIR` 中核验：`@tintinweb/pi-tasks@0.7.2` 安装、`/tasks`、更新和卸载通过，上游 191 项测试通过；`badlogic/pi-skills` commit `90bb51c` 的 8 个 Skill 均被发现并进入 `/skill:` 补全。
- `pi-sandbox@0.6.1` 安装和加载成功，但真实启动因当前环境缺少上游 README 未列出的 `socat` 而未启用，已明确放入未通过清单，没有作为已适配资源推荐。
- Windows 安装器源码和物化资产都以 UTF-8 BOM `EF BB BF` 开头；CI 与 Release 保留 Windows PowerShell 5.1 `Parser.ParseFile` gate。
- Skill 引用局部测试 6 项通过：`$` / `@`、部分名称、显式方括号、文件候选共存、多 Skill 顺序去重、普通环境变量和失效引用均已覆盖。
- 上下文上限回归已用 `215K Provider usage + 大段中文新增内容` 和连续大 Tool Result 形态覆盖。Provider usage 作为历史锚点，新增内容按 UTF-8 bytes/3 轻量估算并触发请求前压缩；估算不再作为 Provider tokenizer 的绝对事实，只有不可拆增量本身达到窗口才本地停止，其余真实 overflow 保留压缩和单次重试。连续 Tool Result 超预算时回到最后一个合法 Assistant Tool Call 切点，手动 `/compact` 才能继续的故障已进入自动回归。
- subagent 已作为隐藏内建 Extension 编入 Coding Agent，三个内建 Agent、项目覆盖和外部同名 Extension 后备优先级测试通过；Coding Agent 全量 1670 项通过。
- Linux x64 独立二进制成功编入 3168 个模块，`--version`、`PI_OFFLINE=1 --list-models`、归档 SHA-256 和真实 PTY 通过。80x8 保留输入框、Skill 候选和快捷栏，120x36 下 `$` Skill 与 `@README` 文件补全均正常。
- Windows Release 保留 `install.cmd` 和 PowerShell 5.1 parser gate，并新增托管 MinGit `2.55.0.3`：npmmirror 优先、Git for Windows 官方 Release 回退、固定 SHA-256、staging 自检、原子替换、跨进程锁和 `PI_OFFLINE=1` 禁止隐式下载。Windows CI 会并发启动两个准备进程，再验证 Bash 专属语法、Git、grep/sed/awk/find、中文空格路径和重复检查。

## 发行产物

目录：`packages/coding-agent/binaries/`

```text
lystar-agent-v<version>-darwin-arm64.tar.gz
lystar-agent-v<version>-darwin-x64.tar.gz
lystar-agent-v<version>-linux-arm64.tar.gz
lystar-agent-v<version>-linux-x64.tar.gz
lystar-agent-v<version>-windows-x64.zip
```

同时生成 `SHA256SUMS`、`release-manifest.json`、`install.sh`、`install.ps1`、`install.cmd` 和 `VERSION`。

## 已知限制

Pi `v0.82.1` 发布基线的完整 `npm test` 已通过。本轮 AI 670 项、Agent Core 241 项和 Coding Agent 1672 项通过；Agent Core 的 50ms 命令超时用例已移除逐行 shell 循环的负载依赖，连续 10 次局部回归和最终全量回归均通过。

本轮 `0.82.1-lystar.8` 发布仍以 GitHub Windows x64 runner 在移除预装 Git 的 PATH 后通过真实 npmmirror 下载、固定 SHA、自检、并发锁和命令集 gate 作为打 tag 前置条件。尚未覆盖 Windows ARM64；macOS 归档继续只有构建、格式、架构和 SHA 证据，没有 macOS 实机安装证据。

当前环境的 `/tmp` 是 tmpfs，Bun 1.3.9 把 `--compile` 输出直接写入该目录时会产生同尺寸全零文件；改用项目所在 ext4 临时目录后生成正常 ELF。正式构建默认输出到仓库 `packages/coding-agent/binaries/`，不受这个本地 tmpfs 限制。

`npm audit --audit-level=high` 仍报告 3 个上游 high severity 告警：`brace-expansion`、`postcss` 和 `shell-quote`。`@earendil-works/gondolin@0.12.0` 仍要求 Node.js `>=23.6.0`，当前验证环境为 Node.js 22；本轮没有脱离 Pi `v0.82.1` 依赖基线单独执行 `npm audit fix`。
