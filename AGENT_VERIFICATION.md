# AGENT_VERIFICATION

最后核验时间：2026-07-26T15:06:00+08:00

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

Windows 安装器源码继续保持 UTF-8 BOM 和 CRLF；本轮加入 LYStar 托管 MinGit Bash 准备命令，安装器在切换版本前执行下载、固定 SHA-256 校验和 Bash/Git 自检。Linux 已通过 PowerShell 脚本物化检查；PowerShell 5.1 parser、npmmirror 下载、跨进程锁、中文空格路径和真实命令集由 Windows CI job 执行后确认。

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

本轮更新后的 Windows 安装器和托管 MinGit 尚未在本机 Windows x64 执行；推送后的 Windows CI 必须通过 PowerShell 5.1 parser、真实 npmmirror 下载、固定 SHA、自检、并发锁和命令集 gate，正式 Release workflow 还会再次执行同一 Windows job。安装器的完整下载发行包、PATH 广播、回退和卸载仍缺 Windows x64 实机证据。macOS 归档继续只有构建、格式和 SHA 证据，没有新增 macOS 实机安装证据。

当前环境的 `/tmp` 是 tmpfs，Bun 1.3.9 把 `--compile` 输出直接写入该目录时会产生同尺寸全零文件；改用项目所在 ext4 临时目录后生成正常 ELF。正式构建默认输出到仓库 `packages/coding-agent/binaries/`，不受这个本地 tmpfs 限制。

`npm audit --audit-level=high` 仍报告 3 个上游 high severity 告警：`brace-expansion`、`postcss` 和 `shell-quote`。`@earendil-works/gondolin@0.12.0` 仍要求 Node.js `>=23.6.0`，当前验证环境为 Node.js 22；本轮没有脱离 Pi `v0.82.1` 依赖基线单独执行 `npm audit fix`。
