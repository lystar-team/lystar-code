# AGENT_VERIFICATION

最后核验时间：2026-07-26T08:06:51+08:00

环境：

```text
Node.js v22.21.1
npm 11.11.0
Bun 1.3.9
Linux x64
```

当前交互 Shell 继承了不安全的 `NODE_TLS_REJECT_UNAUTHORIZED=0`。最终依赖安装、静态检查、离线构建和五平台打包均显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新执行，日志不再出现关闭 TLS 校验警告；正式发布环境不得设置为 `0`。

## 已通过

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

结果：182 个 test files 通过、6 个跳过；1653 项测试通过、48 项跳过。CodeGraph 标记的 Footer 与工具交互受影响测试均已覆盖。

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

结果：89 个 test files 通过、25 个跳过；667 项测试通过、783 项跳过。

Agent Core 全量回归：

```bash
npm --workspace @earendil-works/pi-agent-core test
```

结果：18 个 test files、240 项测试通过，1 项跳过。首次全量运行时，`preserves truncated output when a command times out` 的 50ms 超时用例因环境时序没有收完 3000 行输出；该用例单独复跑通过，随后 Agent Core 全量复跑通过。

Unix 安装器安装、PATH、校验失败、回退、卸载和用户数据保留：

```bash
bash scripts/test-install-sh.sh
```

结果：本地假 Release 分别通过 curl 和仅 wget 下载，latest manifest 版本解析、SHA-256、executable smoke、PATH 幂等写入、`--no-path-update`、坏 SHA 拒绝、回退、卸载和 release materialization 全部通过。该测试不访问网络，已加入 CI 与 Release workflow。

Windows 安装器源码继续保持 UTF-8 BOM 和 CRLF；本轮增加 PowerShell 5.1 版本检查、Git for Windows/Bash 下载前检查和网络重试。当前 Linux 环境没有 `powershell.exe`、`pwsh`、Docker 或 Windows 实机，更新后的 PowerShell 5.1 parser gate 需由 Windows CI job 执行后才能确认。

五平台独立发行包：

```bash
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
cd packages/coding-agent/binaries
sha256sum -c SHA256SUMS
```

结果：`0.82.1-lystar.3` 的 macOS ARM64/x64、Linux ARM64/x64、Windows x64 五个压缩包全部校验通过。`release-manifest.json`、两个安装器和五个平台包内的 `piConfig.releaseRepository` 均固定为 `octyean/lystar-agent`。Linux x64 包已实机运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models`；Windows x64 executable 已核对为 PE32+ x86-64，并确认 native console mode 与 clipboard sidecar 入包。

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
- 从 `0.82.1-lystar.3` Linux x64 发行包启动 80x24 真实 PTY，输入框、项目信任、快捷栏和退出恢复正常。
- README 截图使用本地 OpenAI 兼容假 Provider 完成一轮中文问答，不读取真实认证、不消耗真实模型额度；图片中文字、上下文、输入框、累计用量和快捷栏无裁切。
- 生态资源在独立 `PI_CODING_AGENT_DIR` 中核验：`@tintinweb/pi-tasks@0.7.2` 安装、`/tasks`、更新和卸载通过，上游 191 项测试通过；`badlogic/pi-skills` commit `90bb51c` 的 8 个 Skill 均被发现并进入 `/skill:` 补全。
- `pi-sandbox@0.6.1` 安装和加载成功，但真实启动因当前环境缺少上游 README 未列出的 `socat` 而未启用，已明确放入未通过清单，没有作为已适配资源推荐。
- Windows 安装器源码和物化资产都以 UTF-8 BOM `EF BB BF` 开头；CI 与 Release 保留 Windows PowerShell 5.1 `Parser.ParseFile` gate。

## 发行产物

目录：`packages/coding-agent/binaries/`

```text
lystar-agent-v<version>-darwin-arm64.tar.gz
lystar-agent-v<version>-darwin-x64.tar.gz
lystar-agent-v<version>-linux-arm64.tar.gz
lystar-agent-v<version>-linux-x64.tar.gz
lystar-agent-v<version>-windows-x64.zip
```

同时生成 `SHA256SUMS`、`release-manifest.json`、`install.sh`、`install.ps1` 和 `VERSION`。

## 已知限制

Pi `v0.82.1` 发布基线的完整 `npm test` 已通过。本轮 Coding Agent 全量 1653 项、Agent Core 全量 240 项通过。Agent Core 的 50ms 命令超时用例首次全量运行时没有收完长输出，单项和最终全量复跑均通过。

本轮更新后的 Windows 安装器尚未在本机 PowerShell 5.1 或 Windows x64 实机执行；只有 Windows CI parser job 通过后，才能确认 PowerShell 5.1 语法 gate。macOS 归档继续只有构建、格式和 SHA 证据，没有新增 macOS 实机安装证据。

`npm audit --audit-level=high` 仍报告 3 个上游 high severity 告警：`brace-expansion`、`postcss` 和 `shell-quote`。`@earendil-works/gondolin@0.12.0` 仍要求 Node.js `>=23.6.0`，当前验证环境为 Node.js 22；本轮没有脱离 Pi `v0.82.1` 依赖基线单独执行 `npm audit fix`。
