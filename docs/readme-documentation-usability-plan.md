# README、安装与文档易用性改造方案

> 状态：已实施。阶段 A、B、C 已完成；阶段 D 需项目方第一方域名和对象存储。
>
> 适用基线：LYStar Agent `0.82.1-lystar.3`，Pi `v0.82.1`
>
> 本文保留为 README、安装器和中文文档体系的实施与验收依据。

## 1. 改造前问题

### 1.1 README 面向错了人

当前根目录 `README.md` 同时承载普通用户、源码贡献者和发行维护者的信息：

- 开头先写 Node.js 22、npm、Bun 和 Bash，普通用户容易误以为安装 LYStar 必须准备 Node 环境。
- TUI 参数、发行产物、构建命令和安装命令混在同一层级，首次使用路径不清楚。
- 安装后缺少“启动、登录、选择模型、发送第一条任务”的最短路径。
- Skill、Extension、Pi Package、MCP 只出现在兼容性列表中，没有安装和使用入口。
- 没有中国大陆网络环境下的下载、npm registry 和 Git 访问说明。
- 没有截图，读者无法在第一屏确认这是一个中文全屏终端 Agent。

### 1.2 Unix 安装命令存在明确错误

README 当前命令为：

```bash
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh | sh
```

`install.sh` 使用 `[[ ... ]]`、数组式参数处理和 `set -o pipefail` 等 Bash 语法。Ubuntu 等系统的 `/bin/sh` 通常是 `dash`，这条命令不能作为可靠安装入口。README 和所有文档必须统一改为 `| bash`。

### 1.3 “独立二进制”没有转化成用户承诺

当前发行包已经包含 executable、WASM、native module、主题和运行资源。普通用户安装 LYStar 本体无需 Node.js、npm 或 Bun，但 README 没有把这件事说清楚。

运行前置条件应按平台写明：

| 平台 | 安装 LYStar 本体 | 运行前置 | 扩展生态的额外要求 |
|---|---|---|---|
| macOS | 无需 Node.js | Bash、`curl` 或 `wget`、`tar` | `npm:` Package 需要 Node.js/npm；`git:` Package 需要 Git |
| Linux | 无需 Node.js | Bash、`curl` 或 `wget`、`tar` | `npm:` Package 需要 Node.js/npm；`git:` Package 需要 Git |
| Windows x64 | 无需 Node.js | PowerShell 5.1+、Git for Windows 提供 Bash | `npm:` Package 需要 Node.js/npm；`git:` Package 使用 Git for Windows |

Windows 安装器只负责安装 LYStar 二进制，不把 `bash` Tool 的可选 Shell 依赖提升为产品安装前置条件。没有 Bash 时仍可启动和使用文件工具，实际调用 `bash` Tool 时再显示明确错误。

### 1.4 文档事实源分散

当前用户可见文档主要有三处：

- 根目录 `README.md`：LYStar 中文说明。
- 根目录 `docs/lystar-agent-plan.md`：项目建设与维护基线。
- `packages/coding-agent/docs/`：上游 Pi 英文完整文档，命令和产品名仍以 `pi` 为主。

根目录还没有面向 LYStar 用户的中文文档入口。若继续把内容追加到 README，文件会越来越难维护；若直接修改全部上游英文文档，后续合并 Pi 会产生大量无价值冲突。

### 1.5 生态安装不能笼统承诺“一键”

现有 `la install` 已经是 Pi Package 的统一入口：

```bash
la install npm:<package>
la install git:github.com/<owner>/<repo>@<ref>
la remove <source>
la list
la update --extensions
```

真实限制如下：

- `npm:` 来源一定会调用 npm，因此需要 Node.js/npm 或用户配置的 `npmCommand`。
- `git:` 来源一定会调用 Git。
- Git 仓库根目录只要存在 `package.json`，安装器还会执行 npm 依赖安装。
- 单纯兼容 Agent Skills 规范的仓库，不一定符合 Pi Package 的目录或 manifest 约定，不能直接假设 `la install git:...` 后可被发现。
- Extension 拥有当前用户权限，可以执行任意代码；Skill 也可能引导 Agent 执行命令。文档必须把源码审查和权限风险放在安装命令前。

因此，“一键安装”只用于已经过 LYStar 实测、来源固定、安装命令可重复执行的资源。其余资源提供完整教程，不为追求一句命令绕过现有 Package 体系。

## 2. 本次改造的固定决策

1. 根目录 `README.md` 只保留项目定位、核心能力、支持平台、安装、三步快速开始、文档入口、兼容边界和许可证。
2. 用户文档统一放在现有 `docs/`。不新增拼写错误的 `documention/`，也不再创建第二个文档根目录。
3. `packages/coding-agent/docs/` 继续作为上游 Pi 技术文档和发行包内参考资料，尽量原样跟随上游。
4. LYStar 中文用户文档通过链接引用上游深入资料，不复制几千行 Extension API、RPC、SDK 和 Session 格式。
5. LYStar 本体安装不依赖 Node.js。源码开发和部分 Package 安装需要 Node.js，两个场景分开写。
6. 应用安装继续使用现有独立发行包和 `install.sh` / `install.ps1`，不新增安装器框架或图形安装器。
7. Skill、Extension、Prompt、Theme 继续由 Pi Package 和已有资源目录管理，不新增 LYStar 专属插件协议、商店或配置文件。
8. 已适配资源的一键入口优先使用 `la install <source>`。只有无法进入 Pi Package 体系的纯 Skill 仓库才提供 `git clone` 教程。
9. 中国大陆用户首期使用 GitHub 官方 Release、标准代理环境变量和 npmmirror。README 不推荐来源不明的 GitHub 加速站。
10. 国内对象存储镜像只接受项目方自有域名、自有账号和 CI 同步。存储与域名准备完成前，不把第三方镜像写入默认安装器。

## 3. 目标文档结构

```text
README.md

docs/
├── README.md
├── getting-started/
│   ├── installation.md
│   ├── quick-start.md
│   ├── providers.md
│   └── mainland-china.md
├── usage/
│   ├── interactive-tui.md
│   ├── sessions-and-project-instructions.md
│   ├── configuration.md
│   └── update-rollback-uninstall.md
├── ecosystem/
│   ├── overview.md
│   ├── packages.md
│   ├── skills.md
│   ├── extensions.md
│   └── verified-resources.md
├── troubleshooting/
│   ├── installation.md
│   ├── network.md
│   └── windows.md
├── development/
│   ├── setup.md
│   ├── verification.md
│   ├── release.md
│   └── upstream-sync.md
├── assets/
│   └── lystar-tui.png
├── readme-documentation-usability-plan.md
└── lystar-agent-plan.md
```

### 3.1 目录职责

| 目录 | 读者 | 内容边界 |
|---|---|---|
| `getting-started/` | 第一次安装的用户 | 从零安装、首次登录、首条任务、国内网络 |
| `usage/` | 已能运行 LYStar 的用户 | TUI、会话、配置、更新和卸载 |
| `ecosystem/` | 需要扩展能力的用户和作者 | Package、Skill、Extension、已验证资源 |
| `troubleshooting/` | 遇到安装或网络问题的用户 | 按报错和平台排查，不重复主教程 |
| `development/` | 贡献者和维护者 | Node 环境、构建、测试、发布、上游同步 |
| `assets/` | README 和文档 | 实际 TUI 截图等静态资源 |

### 3.2 文档导航

`docs/README.md` 是唯一中文文档索引，按用户任务组织：

1. 第一次使用：安装、快速开始、Provider 配置、中国大陆网络。
2. 日常使用：TUI、会话、项目规则、配置、更新与卸载。
3. 增加能力：Package、Skill、Extension、已验证资源。
4. 遇到问题：安装、网络、Windows。
5. 参与开发：环境、验证、发布、同步上游。

每篇文档顶部只保留一条返回索引的链接，底部提供 1 至 3 个直接相关的下一步链接，不建立多层面包屑组件。

## 4. README 目标结构

根 README 控制在约 150 至 220 行，第一屏完成定位、平台说明和安装入口。

### 4.1 第一屏

````markdown
# LYStar Agent

LYStar Agent 是基于 Pi 的中文终端编码 Agent，提供中文全屏 TUI，并兼容 Pi 的 Session、Skill、Extension、Package、MCP 和 `.pi` 数据。

支持 macOS、Linux 和 Windows x64。安装独立发行包无需 Node.js。

[真实 TUI 截图]

## 安装

### macOS / Linux

```bash
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh | bash
```

### Windows PowerShell

```powershell
irm https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1 | iex
```
````

Windows 安装块下直接写明“需要 Git for Windows 提供 Bash”，并链接到 Windows 安装文档。macOS/Linux 安装块下写明“无需 Node.js”。

### 4.2 三步快速开始

README 只保留下面三步：

1. 进入准备处理的项目目录并运行 `la`。
2. 执行 `/login`，选择 Provider 并完成登录或填写 API Key。
3. 输入一条真实任务，例如“阅读这个项目，告诉我如何启动和运行测试”。

Provider 差异、环境变量和国内模型接入全部链接到 `docs/getting-started/providers.md`。

### 4.3 核心能力

保留 5 至 7 条可验证能力：

- 中文全屏终端工作区，输入区固定，支持键盘和鼠标滚动。
- 读取、编辑、创建文件并执行 Shell 命令。
- 自动保存、继续、浏览和分支 Session。
- 支持多 Provider、多模型和思考强度切换。
- 兼容 Pi Skill、Extension、Package、Theme、Prompt Template 和 MCP Extension。
- 支持独立更新、回退和卸载，用户数据保留在 `~/.pi/agent`。

README 不放全量快捷键、TUI fallback 规则、JSON 配置示例、构建产物清单和发行维护说明。

### 4.4 README 文档入口

只保留高频入口：

- [完整安装说明](getting-started/installation.md)
- [5 分钟快速开始](getting-started/quick-start.md)
- [中国大陆网络配置](getting-started/mainland-china.md)
- [安装 Skill 与 Extension](ecosystem/overview.md)
- [故障排查](troubleshooting/installation.md)
- [参与开发](development/setup.md)

### 4.5 README 底部

保留以下事实：

- 当前 Pi 基线和兼容说明。
- Pi 与 LYStar 不同时写同一个 Session 的提醒。
- macOS、Windows 尚未签名的真实限制，直到签名链完成。
- MIT License、第三方许可证和上游致谢。

源码构建命令、五平台打包命令和上游 commit 移入开发文档。README 只显示当前版本或 release 链接，不手工维护多处 commit 文本。

## 5. 安装易用性设计

### 5.1 用户路径

普通用户安装过程固定为：

```text
运行一条命令
  -> 安装器检查平台和必需命令
  -> 获取 latest 版本
  -> 下载当前平台归档和 SHA256SUMS
  -> 校验 SHA-256
  -> 解压到版本目录
  -> 运行 la --version 冒烟检查
  -> 原子切换 current
  -> 配置 PATH 或给出唯一可执行动作
  -> 输出 la /login
```

安装器不询问模型、Provider、主题或插件。首次运行继续由 TUI 处理主题和登录。

### 5.2 `install.sh` 改造

在保留现有 `--version`、`--rollback`、`--uninstall` 的基础上完成：

1. 文档入口统一用 `bash` 执行。
2. 下载函数支持 `curl`，没有 `curl` 时尝试 `wget`；两者都没有才失败。
3. 下载 latest、归档和校验文件时统一设置重试、连接超时和失败提示。
4. 安装前检查 `bash`、`tar`、`sha256sum` 或 `shasum`。
5. 检测 `$HOME/.local/bin` 是否在 PATH。
6. PATH 缺失时，按平台和 `$SHELL` 幂等写入一个明确的 PATH 行：zsh 使用 `~/.zprofile`，Linux bash 使用 `~/.bashrc`，macOS bash 使用 `~/.bash_profile`，其他 Shell 使用 `~/.profile`。
7. 增加 `--no-path-update`，供受管环境禁止修改 shell profile。
8. 安装结束输出两行：安装版本与位置；“重新打开终端后运行 `la`，首次使用执行 `/login`”。
9. 错误信息包含失败动作和下一步，不只输出“下载失败”。

PATH 修改只增加 `export PATH="$HOME/.local/bin:$PATH"`，不重排、不覆盖用户原文件。卸载默认不删除这行，避免误删用户原本就需要的 PATH；卸载文档说明可人工移除。

### 5.3 `install.ps1` 改造

1. 下载前检查 PowerShell 版本和 Windows 架构。
2. 安装流程不检查、不下载 Git 或 Bash；这些只属于 `bash` Tool 的可选运行依赖。
3. 保留用户级 PATH 写入；写入后明确提示重新打开终端。
4. 为 `Invoke-WebRequest` 增加统一超时、重试和可读错误。
5. 保持 PowerShell 5.1 语法兼容和 UTF-8 BOM，继续执行现有解析 gate。
6. 安装结束运行发行包内 `la.exe --version`，再切换 `current`。
7. 卸载继续保留 `~/.pi/agent`，并在输出中写明数据位置。

### 5.4 手动安装

`docs/getting-started/installation.md` 提供手动路径，面向脚本被公司策略拦截的用户：

1. 在 Release 页面选择与系统、架构匹配的归档。
2. 同时下载 `SHA256SUMS`。
3. 用系统命令校验 SHA-256。
4. 解压到用户目录。
5. 将 executable 所在目录加入 PATH。
6. 运行 `la --version`。

手动安装不复制一套版本切换逻辑。需要自动更新、回退的用户仍使用官方安装器。

### 5.5 安全边界

- README 的一行安装命令保持简短，同时在安装文档给出“先下载、审阅、再执行”的保守方式。
- 安装器继续校验发行归档 SHA-256。
- Release 页面继续发布 `SHA256SUMS`、`release-manifest.json` 和 GitHub artifact attestation。
- 不使用来源不明的脚本转发站。
- Extension 和 Skill 的权限提示放在安装命令前，不藏在文档末尾。

## 6. 中国大陆用户方案

### 6.1 LYStar 本体下载

首期保留 GitHub Releases 为唯一发行事实源。提供标准代理配置，不绑定具体代理软件。

macOS/Linux：先在当前 shell 设置代理，使安装器脚本及其后续归档下载都继承同一配置。

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh | bash
unset HTTPS_PROXY HTTP_PROXY
```

Windows PowerShell：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:HTTP_PROXY = "http://127.0.0.1:7890"
irm https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1 | iex
```

文档同时给出清理当前终端环境变量的方法。所有代理地址均使用占位示例，说明端口应替换为用户自己的本地代理端口。

### 6.2 npm Package 国内源

[npmmirror 官方页面](https://npmmirror.com/)给出的 registry 为 `https://registry.npmmirror.com`。文档提供两种方式。

只对当前命令生效：

```bash
npm_config_registry=https://registry.npmmirror.com la install npm:<package>
```

Windows PowerShell：

```powershell
$env:npm_config_registry = "https://registry.npmmirror.com"
la install npm:<package>
```

全局配置：

```bash
npm config set registry https://registry.npmmirror.com
npm config get registry
```

恢复 npm 官方源：

```bash
npm config delete registry
```

文档必须说明：npm 镜像只解决 `npm:` Package 和 git Package 的 npm 依赖下载，不加速 GitHub Release 和 `git clone`。

### 6.3 Git Package 网络

优先使用单次代理环境变量，避免无提示修改用户全局 Git 配置：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
  la install git:github.com/<owner>/<repo>@<tag-or-commit>
```

需要全局 Git 代理的用户，再提供 `git config --global http.proxy`、`https.proxy` 及对应 `--unset` 命令。文档明确全局配置会影响其他仓库。

### 6.4 Provider 网络

Provider API、模型服务和安装下载分开说明。`HTTPS_PROXY` 是否对某个 Provider 生效，以该 Provider 和 LYStar 当前 HTTP dispatcher 的实际验证为准。国内 Provider 的 API Key、模型 ID 和 base URL 放在 `providers.md`，不在网络文档里维护重复表格。

### 6.5 第一方国内镜像的后续入口

项目方具备自有对象存储和域名后，可增加显式的国内源：

```text
https://download.<project-domain>/lystar-agent/<version>/...
```

实现前必须同时满足：

- Release workflow 从同一批构建产物同步五平台归档、安装器、manifest 和 SHA 文件。
- 同步后按 SHA-256 回查，任一文件不一致则不发布国内源。
- 国内源不重新打包，不生成第二套 manifest。
- 安装器通过显式 `--source cn` 或文档中的国内源命令选择，首版不静默自动切换下载域名。
- `la update` 和安装器使用同一下载源选择规则。
- 域名、对象存储、TLS、访问日志和凭据轮换均由项目方控制。

这部分需要调整当前“更新只访问 GitHub Release”的项目契约，应单独实施和评审。未准备第一方基础设施前，代理环境变量和 npmmirror 已覆盖首期可实施范围。

## 7. Skill、Extension 与 Package 文档方案

### 7.1 先把概念讲清楚

`docs/ecosystem/overview.md` 用一张表说明：

| 类型 | 用途 | 是否执行代码 | 推荐安装方式 |
|---|---|---|---|
| Skill | 给 Agent 增加特定工作方法、脚本和参考资料 | 可能通过 Agent 间接执行脚本 | Pi Package 或放入 `~/.pi/agent/skills/` |
| Extension | 注册 Tool、命令、事件和 TUI 能力 | 是，拥有当前用户权限 | `la install` 安装经过审查的 Package |
| Pi Package | 打包 Skill、Extension、Prompt 和 Theme | 取决于包内容 | `la install npm:...` 或 `la install git:...` |
| MCP | 连接外部工具和服务 | 由对应 Extension/进程决定 | 按已验证的 MCP Extension 文档安装 |

### 7.2 Package 教程

`docs/ecosystem/packages.md` 必须覆盖：

- 用户级与项目级安装：`la install`、`la install -l`。
- `npm:`、`git:`、本地路径三类来源。
- 锁定 tag 或 commit，避免安装命令随主分支漂移。
- `la list`、`la config`、`la update --extensions`、`la remove`。
- npm/git 依赖条件和国内网络配置链接。
- Package 运行权限和源码审查提醒。
- 安装失败时如何确认缺少 npm、Git、网络或 package manifest。

### 7.3 Skill 教程

`docs/ecosystem/skills.md` 分成三个场景：

1. 安装已打包 Skill：使用 `la install <source>`。
2. 安装纯 Skill 仓库：克隆到 `~/.pi/agent/skills/<name>` 或项目 `.pi/skills/<name>`。
3. 自己创建 Skill：目录结构、`SKILL.md` frontmatter、`name`、`description`、相对路径、`/reload` 和 `/skill:<name>` 验证。

以 [`badlogic/pi-skills`](https://github.com/badlogic/pi-skills) 作为“兼容 Skill 集合”的教程候选。正式落文档前必须验证仓库当前结构、依赖和许可证；需要 Node.js 的单个 Skill 要逐项标注，不能写成整个集合零依赖。

### 7.4 Extension 教程

`docs/ecosystem/extensions.md` 只提供用户和初级作者能完成的路径：

- 从经过验证的 Package 安装 Extension。
- 创建最小单文件 Extension，放入 `~/.pi/agent/extensions/hello.ts`。
- 使用 `la -e ./hello.ts` 临时验证。
- 使用 `/reload` 加载修改。
- 注册一个命令或通知的最小例子。
- 如何禁用、删除和排查加载错误。
- Extension 的完整 API 链接到 `packages/coding-agent/docs/extensions.md`，不在中文入门文档复制整份 API。

### 7.5 已验证资源清单

`docs/ecosystem/verified-resources.md` 只收录完成实测的资源。每项使用固定模板：

```markdown
## 资源名

- 类型：Skill / Extension / Package / MCP Extension
- 来源：仓库或 npm 页面
- 锁定版本：tag 或 commit
- 许可证：已核对的许可证
- LYStar 验证版本：例如 0.82.1-lystar.3
- 系统：macOS / Linux / Windows
- 前置条件：Git、Node.js、浏览器、API Key 等
- 权限与风险：文件、Shell、网络、凭据
- 安装：可直接执行的命令
- 配置：首次使用必须完成的步骤
- 验证：能证明安装成功的命令或界面动作
- 更新：固定命令
- 卸载：固定命令和残留数据位置
- 已知限制：当前真实限制
```

“一键安装”定义为一条可重复执行的 `la install` 命令，且安装后只需完成资源本身必需的凭据配置。资源存在多个手工复制、修改 JSON 或安装依赖步骤时，归类为“教程安装”。

### 7.6 首批适配候选

首批只评估少量高价值资源，完成安全和兼容核验后再进入已验证清单：

- [`badlogic/pi-skills`](https://github.com/badlogic/pi-skills)：Skill 集合，重点验证不同 Skill 的独立依赖。
- [`tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks)：任务管理 Extension，验证 TUI Widget、Session 和中文界面兼容。
- [`carderne/pi-sandbox`](https://github.com/carderne/pi-sandbox)：安全敏感 Extension，验证平台支持、权限模型和失败恢复。

候选名单来自 GitHub `pi-package` 主题及 Pi 文档引用，只代表待验证范围。未经源码、许可证和运行测试核验，不在 README 推荐，也不使用“官方适配”措辞。

### 7.7 适配验收

每个资源至少完成：

1. 阅读 manifest、安装脚本、依赖和许可证。
2. 使用锁定 tag 或 commit 安装。
3. 在临时 HOME 或独立 `PI_CODING_AGENT_DIR` 中验证，避免污染维护者真实配置。
4. 运行 `la list`，确认资源来源和状态。
5. 启动真实 TTY，验证加载、核心操作、`/reload` 和退出恢复。
6. 验证更新、禁用、卸载和残留数据说明。
7. 分别记录无需 Node、需要 Node、仅支持部分平台等限制。
8. 将验证版本和日期写入资源条目。

## 8. 各文档交付口径

| 文件 | 必须回答的问题 | 不放什么 |
|---|---|---|
| `README.md` | 这是什么、支持什么系统、怎么安装、怎么开始、去哪里看文档 | 全量配置、开发构建、长篇快捷键 |
| `docs/README.md` | 我应该看哪篇文档 | 重复教程正文 |
| `getting-started/installation.md` | 我的平台怎么装、需要什么、怎么验 | Provider 细节、插件教程 |
| `getting-started/quick-start.md` | 安装后五分钟内怎么完成第一次会话 | 全量 CLI 参数 |
| `getting-started/providers.md` | 怎么登录或配置 API Key | 未验证的第三方转发服务 |
| `getting-started/mainland-china.md` | GitHub、npm、Git 和 Provider 各自怎么处理网络 | 来源不明的加速站列表 |
| `ecosystem/overview.md` | Skill、Extension、Package、MCP 有什么区别 | 完整 API |
| `ecosystem/verified-resources.md` | 哪些资源在什么版本和平台实测过 | 只看 star 数的推荐榜 |
| `development/setup.md` | 贡献者如何准备 Node、npm、Bun 和 Bash | 普通用户安装路径 |
| `development/verification.md` | 改动后跑什么检查，证据能说明什么 | 历史流水账 |

## 9. 开发实施顺序

### 阶段 A：修正安装主路径

涉及文件：

```text
README.md
scripts/install.sh
scripts/install.ps1
scripts/test-install-sh.sh
scripts/test-install-ps1.ps1
.github/workflows/ci.yml
.github/workflows/release.yml
```

任务：

1. 把 Unix 安装入口改为 `| bash`。
2. 安装脚本补下载工具 fallback、PATH、前置检查和可操作错误。
3. Windows 在下载前处理 Bash/Git for Windows 缺失。
4. 扩充安装器测试和 PowerShell 5.1 解析 gate。
5. 用物化后的 Release 安装器做临时 HOME 验证。

完成标准：没有 Node 环境的用户可安装并运行 `la --version`；缺少必需系统工具时，安装器在修改 `current` 前停止并给出唯一下一步。

### 阶段 B：重写 README 和中文文档骨架

涉及文件：

```text
README.md
docs/README.md
docs/getting-started/*.md
docs/usage/*.md
docs/troubleshooting/*.md
docs/development/*.md
docs/assets/lystar-tui.png
```

任务：

1. 按第 4 节重写 README。
2. 从现有 README、`lystar-agent-plan.md`、AGENT_VERIFICATION.md 和上游 docs 提取内容。
3. 同一事实只保留一个详细说明位置，其他页面使用相对链接。
4. 在真实 PTY 生成中文 TUI 截图，检查 120x36 和 README 缩放效果。
5. 检查所有命令统一使用 `la`；引用上游兼容契约时保留 `PI_*`、`.pi` 和公共包名。

完成标准：新用户只读 README 和 quick start 可完成安装、登录和首条任务；贡献者能从开发文档找到真实构建与测试入口。

### 阶段 C：生态教程与首批资源适配

涉及文件：

```text
docs/ecosystem/*.md
```

必要时为候选资源增加独立适配包；只有出现真实兼容差异时才改源码。

任务：

1. 完成 Package、Skill、Extension 三篇教程。
2. 按第 7.7 节核验首批候选。
3. 只有通过的资源进入 `verified-resources.md`。
4. 每条安装命令锁定 tag 或 commit，并提供验证、更新和卸载命令。

完成标准：文档中每条“一键安装”命令都在干净环境实测；需要 Node、Git、API Key 或特定平台的条目明确标注。

### 阶段 D：第一方国内镜像（具备基础设施后）

涉及文件预计包括：

```text
scripts/generate-release-metadata.mjs
scripts/install.sh
scripts/install.ps1
packages/coding-agent/src/utils/lystar-updater.ts
packages/coding-agent/src/utils/version-check.ts
.github/workflows/release.yml
对应测试与文档
```

任务：同步同一批 Release 产物、显式选择下载源、校验一致性、统一安装和更新行为。该阶段不阻塞 A 至 C。

## 10. 验证矩阵

### 10.1 文档静态检查

- 所有相对链接和锚点可解析。
- README 中不存在 `| sh`。
- 普通用户安装章节不把 Node.js 列为 LYStar 本体前置。
- 所有最终用户命令使用 `la`；上游包名、`PI_*` 和 `.pi` 保持原样。
- README、安装文档、更新文档中的安装命令一致。
- 文档没有真实 API Key、token、cookie 或用户路径。
- `documention/` 不存在，用户文档只有 `docs/` 一个根目录。

### 10.2 Unix 安装器

至少覆盖：

- Linux x64：有 curl、只有 wget、PATH 已存在、PATH 缺失。
- macOS 脚本静态和归档格式验证；有实机时补 arm64 安装。
- 固定版本安装、重复安装、升级、回退、卸载。
- 下载失败、SHA 不匹配、归档缺 executable、`la --version` 失败。
- 临时 HOME 中 shell profile 不被覆盖，PATH 行不重复。
- `--no-path-update` 不修改 profile。
- 用户数据目录 `~/.pi/agent` 始终保留。

### 10.3 Windows 安装器

至少覆盖：

- PowerShell 5.1 parser gate。
- Windows x64 安装、重复安装、升级、回退、卸载。
- Bash 存在和缺失两种路径。
- 用户 PATH 不重复。
- SHA 不匹配和 executable smoke 失败时不切换 `current`。
- UTF-8 BOM 保持。

没有 Windows 实机证据时，只能写“PowerShell 解析、归档、PE 架构和脚本测试通过”，不能写“Windows 安装已实机通过”。

### 10.4 README 用户验收

找一台没有 Node.js 的干净环境，按 README 原文执行：

1. 只看第一屏判断系统支持和前置条件。
2. 执行安装命令。
3. 重新打开终端，运行 `la --version`。
4. 运行 `la` 和 `/login`。
5. 完成一条只读任务。
6. 找到更新、卸载、中国大陆网络和 Skill 安装文档。

验收过程中不允许维护者补充 README 外的口头步骤。

### 10.5 项目 gate

代码改动完成后执行：

```bash
npm run check
npm run build:offline
bash scripts/test-install-sh.sh
```

修改 package manager、更新器或 release metadata 时，补跑对应 Vitest 文件、发行元数据生成和五平台归档校验。可见 TUI 截图使用真实 PTY，结束后关闭本轮 tmux 会话。

## 11. 完成定义

本方案实施完成需同时满足：

- README 第一屏说明产品、平台、无需 Node 和两类安装命令。
- macOS/Linux 安装命令使用 Bash；Windows 安装不依赖 Git 或 Bash，`bash` Tool 的兼容 Shell 在实际调用时检查。
- 普通用户、国内网络用户、生态用户和贡献者各有独立入口。
- README 不再承载开发构建、完整 TUI 参数、发行产物和插件长教程。
- Skill、Extension、Package 文档能够完成安装、配置、验证、更新和卸载。
- 已验证资源清单的每条命令都有版本、平台和风险证据。
- 国内 npm 源和代理操作可直接执行，并提供恢复方法。
- 未使用来源不明的 GitHub 镜像或脚本转发服务。
- 安装器、README 和发行资产使用同一个版本与仓库事实源。
- 所有测试结论严格区分脚本测试、构建验证和操作系统实机验证。

## 12. 实施结论

阶段 A、B、C 已按本文实施：安装主路径已经修正，中文文档结构已经建立，首批生态资源完成隔离核验。阶段 D 保持待实施，启动条件是项目方具备第一方国内存储、域名和 CI 凭据。

后续维护继续遵守本文确定的目录、README 边界、安装器责任、国内网络策略和生态条目格式。
