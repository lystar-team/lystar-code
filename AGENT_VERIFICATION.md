# AGENT_VERIFICATION

最后核验时间：2026-07-28T16:31:50+08:00

环境：

```text
Node.js v22.22.2
npm 11.11.0
Bun 1.3.9
Linux x64
```

当前交互 Shell 继承了不安全的 `NODE_TLS_REJECT_UNAUTHORIZED=0`。最终依赖安装、静态检查、离线构建和五平台打包均显式使用 `NODE_TLS_REJECT_UNAUTHORIZED=1` 重新执行，日志不再出现关闭 TLS 校验警告；正式发布环境不得设置为 `0`。

## 已通过

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
