# LYStar Agent 建设方案

> 状态：开发基线。按本文连续实施，不设阶段审批。
>
> 当前上游基线：2026-07-25；Pi `v0.82.1`，commit `b4f293684bba718d59cc1157679bcf6157b3a7f5`；Grok Build commit `6e386420825bd44ae648c63e7c8cba12fcec9401`。

## 1. 产品定义

LYStar Agent 是 Pi 的中文增强发行版，启动命令为 `la`。它沿用 Pi 的 Agent Runtime、Provider、Session、Tool、Skill、Extension、Pi Package、配置格式和数据目录，集中改进安装、中文界面和 Interactive TUI。

首版必须完整交付：

1. 用户通过 `la` 使用 Pi CLI 的完整能力，现有 `pi` 可以继续安装和运行。
2. LYStar 与 Pi 共用 `~/.pi/agent` 和项目 `.pi`，认证、模型、会话、Skill、Extension 与 Pi Package 无需迁移。
3. LYStar 自有界面使用简体中文，中文输入、宽字符和终端显示稳定。
4. Interactive TUI 提供全屏工作区、固定输入区、独立滚动、折叠、鼠标和稳定的流式渲染。
5. macOS、Linux 和 Windows 提供可独立运行的发行包，支持安装、更新、校验、回退和卸载。
6. 后续可以持续合并 Pi 上游版本，不分叉 Agent 协议和扩展生态。

Todo、后台任务、子 Agent 和 MCP 等能力继续由 Pi Extension 提供。LYStar 不复制 Agent Runtime，也不增加第二套 Skill、Package 或 MCP 体系。

### 固定决策

| 项目 | 决策 |
|---|---|
| 技术路线 | Pi 兼容增强发行版 |
| 上游 | `earendil-works/pi` |
| 首个基线 | Pi `v0.82.0` |
| 命令 | `la` |
| 展示名 | `LYStar Agent` |
| 数据目录 | `~/.pi/agent`、项目 `.pi` |
| 环境变量 | 保持上游 `PI_*` 语义，不增加同义 `LA_*` 变量 |
| 发行形式 | 包含 executable 与运行资源的独立发行包 |
| 版本格式 | `<Pi版本>-lystar.<修订号>`，例如 `0.82.0-lystar.1` |
| 界面语言 | 首版只提供 `zh-CN`，无语言切换 |
| TUI | 复用 Pi renderer，增加全屏 viewport 和交互层 |
| MCP | 继续通过 Pi Extension 接入 |

## 2. 已确认的上游能力

### Pi

Pi `v0.82.1` 已具备以下基础，LYStar 直接复用：

- Bun executable 构建入口和 macOS、Linux、Windows 多架构 CI。
- Agent Runtime、Provider、Session、Tool、Extension、Skill 和 Package 管理。
- TUI 组件、焦点模型、自定义 editor、widget、footer、overlay 和消息 renderer。
- 内存行缓冲、前后帧比较、变化区域重绘、synchronized output、单次批量写入、16ms 合帧、内容收缩擦除和 resize 重绘。
- `visibleWidth`、`truncateToWidth`、ANSI 安全换行、`Focusable` 和 `CURSOR_MARKER`。
- 用户目录、项目目录和 Pi Package 内的 Skill、Extension、Prompt 与 Theme 发现。

LYStar 不重写现有差量 renderer。TUI 新增范围只包括 alternate screen 生命周期、固定区域布局、viewport、scrollback、焦点与鼠标路由，以及这些能力需要的测试。

Pi 当前不内置 MCP。这个边界保持不变。

### Grok Build

LYStar 参考 `xai-org/grok-build` 可观察到的信息结构和交互：

- 顶部项目和上下文状态。
- 中央对话滚动区。
- 固定在底部的输入区和状态栏。
- 用户轮次的清楚起点。
- 思考、Tool、Diff 和长输出的摘要与展开。
- 键盘焦点、鼠标滚轮和点击。
- 普通终端、tmux、Zellij 等环境下的 alternate screen 自动选择。

LYStar 不复制 Grok Build 的品牌、图标、文案或实现代码。Grok Build 使用 Apache-2.0；Pi 使用 MIT，发行物必须携带自身许可证和第三方许可证清单。

## 3. 代码架构与维护边界

### 仓库

实施仓库以 Pi `v0.82.0` 为初始代码基线：

```text
origin    LYStar Agent 仓库
upstream  https://github.com/earendil-works/pi.git
main      LYStar 可发布主分支
```

`upstream` 只跟踪 Pi。LYStar 在原 monorepo 结构内开发，不用 `patch-package` 修改已安装依赖，不复制 `packages/ai` 或 `packages/agent`。

### 改动归属

```text
尽量原样跟随 Pi
  packages/ai
  packages/agent
  coding-agent 的 provider、session、tool、extension、skill、package
  packages/tui 的现有组件和差量 renderer

LYStar 长期维护
  产品常量与 la 入口
  zh-CN 文案目录
  Interactive TUI viewport 与 LYStar 布局组件
  alternate screen、滚动和鼠标适配
  发行包、安装器和二进制更新器
  兼容、PTY、ANSI 与发行验证
```

必须改上游文件时，把改动放在 composition root 或共享责任位置。品牌、文案、TUI、发行和测试分别形成清楚的提交，方便后续合并上游；这些提交属于同一份连续实施，不设置中途审批点。

### 产品常量

Pi 当前把 `piConfig.name` 同时用于界面名和环境变量前缀，无法同时表达 `la`、`LYStar Agent` 和 `PI_*`。LYStar 增加一个集中式产品常量入口，所有品牌和发行逻辑从这里读取：

| 常量 | 值或来源 |
|---|---|
| `cliName` | `la` |
| `displayName` | `LYStar Agent` |
| `configDirName` | `.pi` |
| `envPrefix` | `PI` |
| `releaseRepository` | `octyean/lystar-agent`，由 `packages/coding-agent/package.json` 统一提供 |

构建过程把 `releaseRepository` 固化进产物。CI 的 `GITHUB_REPOSITORY` 或命令行传值与产品常量不一致时直接失败。产品常量不做插件化配置，也不增加运行时覆盖入口。

为了保持 Extension 与 SDK 兼容，源码包标识、公共 import specifier 和 Pi Extension API 名称继续沿用上游。用户可见品牌统一读取 `PRODUCT.displayName`，executable 和帮助示例统一读取 `PRODUCT.cliName`。

## 4. 命令、品牌与外部服务

### CLI 契约

`la` 保持 Pi CLI 的参数、退出码、非交互输出结构和资源管理语义：

```bash
la
la --version
la --help
la -c
la -r
la install <source>
la remove <source>
la list
la config
la update
la update --extensions
la update --rollback
```

用户可见的 banner、终端标题、帮助、选择器、状态和 LYStar 自有错误使用 `LYStar Agent`。脚本依赖的参数、退出码、JSON 字段、模型 ID、Tool 名和 Extension API 不翻译、不改名。

### 环境变量

以下上游变量继续生效，名称和优先级保持 Pi 原样：

```text
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
PI_OFFLINE
PI_PACKAGE_DIR
PI_TUI_WRITE_LOG
PI_CLEAR_ON_SHRINK
PI_CODING_AGENT
```

源码中其他已经公开或实际使用的 `PI_*` 变量也保持原名。`PI_TELEMETRY` 和 `settings.json` 中的 `enableInstallTelemetry` 只保留兼容识别，LYStar 固定关闭安装遥测。首版不接受 `LA_*` 别名，避免同一设置出现两个事实源。

### Pi 与 LYStar 服务边界

| 能力 | 处理方式 |
|---|---|
| LYStar 版本检查和二进制更新 | 只访问 LYStar GitHub Releases，不请求 `pi.dev/api/latest-version` |
| Pi Package 更新 | 保持 Pi Package manager 语义 |
| 安装上报 | 删除 LYStar 启动时对 `pi.dev/api/report-install` 的调用，不另建遥测服务 |
| Provider attribution | 保持 Provider 路由和 Header 覆盖顺序，默认归因使用 LYStar 产品身份，并与安装遥测开关解耦 |
| Pi 模型目录、分享查看器 | 保持上游功能；界面明确标注其外部来源 |
| `PI_OFFLINE` | 禁止版本检查、远程目录、分享和其他非必要网络请求 |

系统提示词、协议字段和模型行为指令继续沿用 Pi。只替换其中纯产品名称，不翻译会影响 Agent 行为的提示内容。

## 5. 发行、安装与更新

### 发行包

Pi 官方 Bun 构建产物运行时需要 executable 旁边的主题、图片、HTML 导出模板、WASM 和 native module。LYStar 将其称为“独立发行包”，不再承诺真正的单文件。

首批目标：

```text
macOS    arm64 / x64
Linux    x64 / arm64
Windows  x64
```

每个平台的归档至少包含：

```text
la / la.exe
package.json
LICENSE
THIRD_PARTY_LICENSES.md
theme/
assets/
export-html/
docs/
examples/
*.wasm
运行所需的 native modules
```

归档名称固定为：

```text
lystar-agent-v<version>-darwin-arm64.tar.gz
lystar-agent-v<version>-darwin-x64.tar.gz
lystar-agent-v<version>-linux-x64.tar.gz
lystar-agent-v<version>-linux-arm64.tar.gz
lystar-agent-v<version>-windows-x64.zip
```

发布同时生成 `release-manifest.json`、`SHA256SUMS`、GitHub artifact attestation 和版本说明。首版允许发布未签名测试 release，但发布说明和安装器必须明确 macOS Gatekeeper 与 Windows SmartScreen 可能出现的系统警告。Developer ID/notarization 与 Authenticode 不阻塞开发、CI、内部测试和首版小范围发行；面向普通用户公开推广前必须补齐。

### 安装目录

macOS 和 Linux：

```text
~/.local/share/lystar-agent/versions/<version>/
~/.local/share/lystar-agent/current -> versions/<version>/
~/.local/bin/la -> ../share/lystar-agent/current/la
```

Windows：

```text
%LOCALAPPDATA%\LYStarAgent\versions\<version>\
%LOCALAPPDATA%\LYStarAgent\current
%LOCALAPPDATA%\LYStarAgent\previous
%LOCALAPPDATA%\LYStarAgent\bin\la.cmd
```

`current` 和 `previous` 是只包含版本号的文本文件。Windows 的 `la.cmd` 读取 `current`，校验版本号格式后转发到 `versions\<version>\la.exe`。安装器把稳定的 `bin` 目录加入用户 PATH，不要求管理员权限，不改系统 PATH。

release workflow 把安装脚本附加到 GitHub latest release，并根据固化后的 `releaseRepository` 生成 README 安装命令：

```bash
# macOS / Linux
curl -fsSL "https://github.com/${releaseRepository}/releases/latest/download/install.sh" | bash

# Windows PowerShell 5.1+
$cmd="$env:TEMP\lystar-install.cmd"; iwr -UseBasicParsing "https://github.com/${releaseRepository}/releases/latest/download/install.cmd" -OutFile $cmd; & $cmd
```

`${releaseRepository}` 是文档生成变量，发布后的 README 必须写成实际 `owner/repo`，不能保留变量。

安装器负责识别 OS/arch、下载 manifest 和归档、核对版本、大小和 SHA-256、解压到 staging、验证 executable、移动到版本目录并切换 `current`。下载或验证失败时保留当前版本。

二进制运行不依赖 Node.js、Git 或 Bash。安装 `npm:` 来源的 Pi Package 仍需要 npm；安装 `git:` 来源仍需要 Git。只有执行内建 `bash` Tool 时才需要兼容 Bash，用户可以按需使用 Git Bash、WSL、MSYS2、Cygwin 或通过 `shellPath` 指定其他实现。

### 更新清单

`release-manifest.json` 使用固定结构。下面的 `sha256` 和 `size` 只展示字段格式，发布时由 CI 写入真实值：

```json
{
  "version": "0.82.0-lystar.1",
  "piVersion": "0.82.0",
  "channel": "stable",
  "publishedAt": "2026-07-25T00:00:00Z",
  "assets": {
    "darwin-arm64": {
      "file": "lystar-agent-v0.82.0-lystar.1-darwin-arm64.tar.gz",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "size": 123456789
    }
  }
}
```

`assets` 必须覆盖全部发布目标；每项必须有 `file`、64 位十六进制 `sha256` 和大于零的 `size`。CI 校验 manifest、归档文件和 `SHA256SUMS` 一致。

### `la update`

`la update` 只更新 LYStar 发行包：

1. 遵守 `PI_OFFLINE`、`HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。
2. 从 `https://github.com/${PRODUCT.releaseRepository}/releases/latest/download/release-manifest.json` 读取 stable release manifest。
3. 使用 semver 比较当前版本和目标版本。
4. 下载到 staging，校验大小和 SHA-256。
5. 解压并运行 `la --version` 冒烟检查。
6. 安装完整版本目录，把原 `current` 记录到 `previous`。
7. Unix 原子切换 `current` 链接；Windows 原子替换 `current` 版本文件。
8. 切换失败时继续使用原版本并删除 staging。

首版只有 stable 通道。版本排序先比较 Pi 基线，再比较 `lystar.N`；同一 Pi 基线递增修订号，升级 Pi 基线后从 `lystar.1` 开始。

`la update --rollback` 切回 previous 版本，不改用户数据。只保留 current 和 previous 两个版本。`la update --extensions` 只更新 Pi Package，不触发二进制更新。

## 6. 数据兼容与并行使用

### 共用数据

LYStar 继续识别：

```text
~/.pi/agent/
.pi/
.agents/skills/
AGENTS.md
CLAUDE.md
.mcp.json
```

认证、模型、Session、Prompt、Theme、Skill、Extension 和 Pi Package 使用上游格式。LYStar 不创建 `~/.lystar`、项目 `.lystar`、专属 Session 或专属 Package 格式。

LYStar 自己的终端偏好保存在共享数据根下的独立文件，避免给 Pi 的 `settings.json` 写入未知字段：

```text
~/.pi/agent/lystar.json
```

首版只允许三个字段：

```json
{
  "altScreen": "auto",
  "mouse": true,
  "reduceMotion": false
}
```

读取失败时报告文件和字段错误，不静默覆盖。写入使用 Pi SettingsManager 相同的原子写和文件锁方式。这个文件只保存 LYStar UI 偏好，不保存认证、模型、会话或生态资源。

### 兼容规则

- LYStar 不修改 Session entry、Tool result、Extension event 和 Package manifest 格式。
- LYStar 只执行其 Pi 基线自带的上游迁移。
- 读取由更新版 Pi 创建的未知 Session entry 时，保留原始内容；无法安全解释时停止写入并提示使用对应 Pi 版本打开。
- LYStar 内置主题继续使用 `dark` 和 `light` 名称；用户设置原生 Pi 也能识别。用户自定义主题仍从原路径加载。
- 同一 Session 不支持被 `pi` 和 `la` 两个进程同时写入。LYStar 自身要阻止两个 `la` 进程写同一 Session，并在检测到锁时提供只读打开或取消选项。
- Pi Package 的安装、删除和更新不支持多个 `pi`/`la` 进程并发执行。命令开始前给出占用检查，无法确认外部 Pi 状态时明确提示用户关闭其他包管理命令。
- 二进制更新只切换程序目录，不写 `~/.pi/agent`。

每次发布都要验证三种组合：仅安装 `pi`、仅安装 `la`、同机同时安装 `pi` 和 `la`。

## 7. Interactive TUI

### 布局

```text
┌ LYStar Agent  项目/会话                         上下文用量 ┐
│                                                            │
│  对话 viewport                                             │
│  用户任务 / Agent 回复 / 思考 / Tool / Diff / 错误         │
│                                                            │
│  当前运行状态与排队消息                                    │
├────────────────────────────────────────────────────────────┤
│  输入区                                                    │
├────────────────────────────────────────────────────────────┤
│  模型  思考强度  模式                    当前快捷键提示     │
└────────────────────────────────────────────────────────────┘
```

顶栏、输入区和状态栏占用稳定区域。中间 viewport 使用剩余高度，不允许流式内容推动输入区。低于 80 列时隐藏次要状态；80、120、160 列是固定测试宽度。

### 渲染责任

- 继续使用 Pi TUI 的行缓冲、变化检测、synchronized output、单次批量写入和 16ms 合帧。
- 不新增第二套 ANSI screen model 参与生产渲染；ANSI screen model 只用于测试回放。
- viewport 只向现有 renderer 提供当前帧可见行。
- Markdown、语法高亮和已完成消息沿用现有缓存；只为 viewport 裁切增加必要缓存键。
- 正常流式输出不得发送整屏 clear；进入、退出、resize 和终端能力变化可以触发明确的 full render。
- 不把合帧固定降到 30 FPS。动画通过 `reduceMotion` 控制；调度间隔只有在性能测试证明有收益后才调整。
- resize 使旧尺寸帧失效，在下一个 frame 使用新宽高完成布局和绘制。

### Alternate screen

支持 `auto`、`always` 和 `never`：

| 环境 | `auto` 行为 |
|---|---|
| 普通 Kitty、Ghostty、WezTerm、iTerm2、Windows Terminal、VS Code Terminal | fullscreen |
| 普通 tmux | fullscreen |
| tmux control mode | inline |
| Zellij | inline |
| Screen、Byobu、SSH 或终端能力不完整 | 能力检测通过时 fullscreen，否则 inline |
| 非 TTY、`TERM=dumb`、CI 日志 | inline |

用户可以在 `lystar.json` 设置 `altScreen`，也可以用 `--alt-screen auto|always|never` 临时覆盖。`--no-alt-screen` 等价于 `--alt-screen never`。CLI 优先于配置文件。

进入 fullscreen 后启用 alternate screen、隐藏光标和可选鼠标报告。正常退出、未捕获异常、`SIGINT`、`SIGTERM`、`SIGHUP`、挂起和恢复都必须成对恢复光标、颜色、鼠标模式和主屏。初始化未完成或控制序列写入失败时退回 inline，并输出一条可操作的中文提示。

### Scrollback

- viewport 维护独立的垂直偏移，不修改消息数据。
- 用户停留在底部时，流式内容自动跟随。
- 用户向上滚动后保持当前位置，新内容只增加“有新内容”提示，不抢回底部。
- 回到底部、发送新消息或显式执行“跳到底部”后恢复自动跟随。
- Page Up、Page Down、跳到顶部、跳到底部都注册为 keybinding action；界面显示实际绑定。
- 折叠状态按消息 ID 保存在当前进程，不写入 Session 格式。
- 用户消息、Agent 回复、思考、Tool、Diff、错误和排队消息都提供稳定锚点。

### 焦点与鼠标

焦点顺序固定为 viewport、输入区、当前 overlay。没有 overlay 时，输入区保持默认焦点；滚动 viewport 不夺走输入法焦点。

鼠标报告只在 fullscreen 且 `mouse=true` 时启用：

- 滚轮滚动 viewport。
- 单击只处理有明确 hit region 的折叠、按钮和可聚焦区域。
- Shift 加拖动保留终端文本选择语义。
- inline 模式不启用全局鼠标报告。
- 退出、异常和信号中断必须关闭鼠标报告。

键盘始终覆盖全部核心操作，鼠标不是完成任务的必要条件。

### Extension UI 兼容

- `ctx.ui.custom()` 继续使用独立 overlay 层，overlay 打开时接管焦点，关闭后恢复原焦点和 scroll offset。
- custom editor 替换输入区组件，不改变 Extension factory 和生命周期。
- custom footer、header 和 widget 继续接收原数据与主题对象；布局只约束可用宽高，不改组件接口。
- Extension 组件超出 viewport 时由 overlay 容器提供裁切和滚动，不能写到终端边界外。
- inline fallback 使用 Pi 原有 Interactive Mode 排列方式。
- `ExtensionAPI`、事件名、Tool result shape 和 renderer 注册方式不变。

至少维护一个测试 Extension，覆盖 custom command、overlay、footer、widget、editor 和自定义消息 renderer。

### 中文与视觉

- 使用现有 display width 工具处理中文、组合字符、emoji 和 ANSI 控制序列。
- 保留 `CURSOR_MARKER`，IME 候选框位置必须跟随真实光标。
- 长中文、长路径和长模型名按可见宽度截断，不能拆开 ANSI 序列或宽字符。
- 深色主题使用中性黑灰、近白正文、青绿强调和清晰蓝色链接；成功、警告、错误使用绿、黄、红。
- 浅色主题保持同等对比度。Diff 除颜色外还保留 `+`、`-` 和上下文标记。
- 思考、Tool 和命令输出默认显示一到三行摘要，展开后查看完整内容。
- `reduceMotion=true` 时关闭非必要 spinner 动画，只保留文本状态。

## 8. 中文文案

### 范围

LYStar 自有内容使用简体中文：

- 启动欢迎区、菜单、设置、选择器和命令描述。
- 会话、模型、思考强度、上下文和费用状态。
- 加载、运行、等待、重试、压缩、成功、失败和取消状态。
- 项目信任、危险操作确认、登录和配置提示。
- 内置帮助、快捷键、更新、诊断和 LYStar 自有错误。
- Pi 内置 Tool、Skill、Package 和资源管理界面的固定说明。

以下内容保持原样：

- 模型 ID、Provider 名、Tool 名、命令、参数、路径、环境变量和配置 key。
- 代码、日志、HTTP 状态码和第三方服务返回原文。
- 第三方 Skill、Extension、MCP Server 提供的名称和正文。
- Session、RPC、SDK、Extension 和 Provider 协议字段。
- 会影响 Agent 行为的 system prompt、Tool schema 和模型上下文。

外部错误可以在原文前增加中文说明，原始错误必须保留，便于检索和排障。

### 文案入口

在 `packages/coding-agent/src/locales/` 建立唯一 `zh-CN` catalog 和 `t(key, params)`：

- key 按功能域命名，例如 `session.resume.failed`。
- 参数使用命名插值，不在调用处拼接半句中文。
- catalog key 由 TypeScript 静态推导，引用不存在的 key 时类型检查失败。
- 开发模式遇到缺 key 直接报错；生产模式回退到上游原文并写 debug log，避免界面崩溃。
- 第三方内容不进入 catalog，也不经过全文替换。

文案检查只扫描 LYStar 管理的用户界面调用点，不对代码、日志、fixture 和第三方输出做全仓英文正则匹配。测试由三部分组成：catalog 引用完整性、核心 PTY 流程快照、带原因的英文 allowlist。合并上游时，新增用户界面字符串自动生成待翻译清单；存在未处理项时不能发布。

首版不增加语言选择器，不为未来语言预建复数、远程文案或运行时语言包系统。

## 9. Skill、Extension、Package 与 MCP

### Skill

保持 Pi 原有发现规则：

```text
~/.pi/agent/skills/
~/.agents/skills/
.pi/skills/
.agents/skills/
Pi Package 内的 skills/
--skill <path>
```

Skill 命令继续使用 `/skill:name`。LYStar 只汉化自己的浏览、状态和错误，不修改 Skill 的 `name`、frontmatter 和正文。

### Extension 与 Pi Package

- `la install`、`la remove`、`la list`、`la config` 和 `la update --extensions` 继续调用 Pi Package manager。
- npm、git 和本地路径来源的解析、锁文件与配置格式保持上游语义。
- 第三方 Extension 可以继续注册 Tool、Command、Shortcut、Provider、Footer、Widget、Editor 和自定义 TUI。
- LYStar 不翻译第三方注册的命令名、Tool 名和正文。
- Package 更新与二进制更新分别报告结果和退出码。

### MCP

MCP 继续由 Pi Extension 接入。已经安装在 `~/.pi/agent` 中的 MCP Extension 原样加载，也可以执行：

```bash
la install npm:pi-mcp-adapter
```

兼容基线使用 `pi-mcp-adapter 2.12.1`，覆盖：

```text
.mcp.json
~/.pi/agent/mcp.json
.pi/mcp.json
stdio
HTTP
OAuth
延迟连接
Tool 调用、取消和超时
```

LYStar 不增加 MCP 配置文件、内置管理器或代理 Tool。TUI 负责显示 Extension 给出的状态、确认、调用和错误；MCP Tool 名、参数 schema 与服务端返回保持原样。

## 10. 上游同步与版本

每个 LYStar 版本在兼容矩阵中记录：

| LYStar | Pi 基线 | Pi commit | MCP Adapter | Session | Extension API |
|---|---|---|---|---|---|
| `0.82.1-lystar.6` | `0.82.1` | `b4f29368...` | `2.12.1` | Pi 原格式 | Pi `0.82.1` |
| `0.82.1-lystar.5` | `0.82.1` | `b4f29368...` | `2.12.1` | Pi 原格式 | Pi `0.82.1` |
| `0.82.1-lystar.4` | `0.82.1` | `b4f29368...` | `2.12.1` | Pi 原格式 | Pi `0.82.1` |
| `0.82.1-lystar.3` | `0.82.1` | `b4f29368...` | `2.12.1` | Pi 原格式 | Pi `0.82.1` |
| `0.82.1-lystar.2` | `0.82.1` | `b4f29368...` | `2.12.1` | Pi 原格式 | Pi `0.82.1` |
| `0.82.1-lystar.1` | `0.82.1` | `b4f29368...` | `2.12.1` | Pi 原格式 | Pi `0.82.1` |
| `0.82.0-lystar.4` | `0.82.0` | `083e6162...` | `2.12.1` | Pi 原格式 | Pi `0.82.0` |
| `0.82.0-lystar.3` | `0.82.0` | `083e6162...` | `2.12.1` | Pi 原格式 | Pi `0.82.0` |
| `0.82.0-lystar.2` | `0.82.0` | `083e6162...` | `2.12.1` | Pi 原格式 | Pi `0.82.0` |
| `0.82.0-lystar.1` | `0.82.0` | `083e6162...` | `2.12.1` | Pi 原格式 | Pi `0.82.0` |

合并 Pi 新版本时连续完成以下动作，不拆成独立项目：

1. 更新 `upstream` tag 和基线 commit。
2. 阅读 changelog，比较 Extension API、Session、Tool result、CLI、Package、Skill 与 TUI 变化。
3. 合并上游，只在产品常量、locales、viewport、发行和验证边界解决冲突。
4. 删除上游已经提供的等价 LYStar 代码，避免保留双实现。
5. 补齐新增用户文案和兼容 fixture。
6. 运行 Pi 原测试、LYStar 测试、PTY、ANSI、生态和发行验证。
7. 用一个后续 Pi tag 做模拟合入，确认补丁边界仍可维护。
8. 更新兼容矩阵、版本说明和第三方许可证清单。

发布 tag 使用 `v<Pi版本>-lystar.<修订号>`。版本检查只比较 LYStar stable release，不把 Pi 官方版本直接提示为可安装更新。

## 11. 统一开发清单

以下内容作为一个开发任务连续完成。顺序只表示依赖关系，不设置阶段验收，也不交付缺功能的中间发行版。

| 工作项 | 完成标准 |
|---|---|
| 仓库基线 | 建立 `origin/upstream`，可重复构建当前 Pi `v0.82.1` 基线 |
| 产品常量 | `la`、`LYStar Agent`、`.pi`、`PI_*` 和 release repository 各自只有一个事实源 |
| CLI 品牌 | banner、标题、帮助、版本、错误和示例统一；参数与退出码兼容 |
| 发行包 | 五个平台归档包含 executable、运行资源、许可证和 manifest |
| 安装器 | 检测平台、下载、校验、staging 安装、PATH、卸载和失败保留旧版 |
| 二进制更新 | LYStar release 源、semver、完整包安装、平台版本指针和回退可用 |
| 数据兼容 | 共用 Pi 数据；`lystar.json` 只存 UI 偏好；未来 Session 不被旧版本误写 |
| 中文 catalog | 核心 UI、CLI、设置、会话、信任、更新和错误全部接入 `t()` |
| 全屏 shell | alternate screen、固定区域、viewport、退出与 signal cleanup 完整 |
| 滚动与焦点 | 自动跟随、离底提示、跳转、overlay、editor 和 keybinding 正常 |
| 鼠标 | fullscreen 下滚轮与点击可用，文本选择和退出恢复正常 |
| 消息展示 | 用户、Agent、思考、Tool、Diff、错误和排队状态可区分、可折叠 |
| 终端适配 | 80/120/160 列、中文 IME、宽字符、256 色和 inline fallback 可用 |
| Extension 兼容 | 测试 Extension 的 overlay、footer、widget、editor 和 renderer 全部通过 |
| Skill/Package/MCP | 标准路径、Pi Package 和 MCP stdio/HTTP fixture 通过 |
| 上游演练 | 模拟合入后续 Pi tag，完成冲突、测试和兼容矩阵 |
| 发布 | 全部自动与手工 release gate 通过，生成首个带 SHA-256 和 artifact attestation 的测试 release；签名凭据不阻塞首版 |

仓库根目录建立 `AGENT_VERIFICATION.md`，只记录本仓库真实可执行的构建、测试、PTY、打包和冒烟命令。命令没有跑通前不能写入该文件。

## 12. 一次性交付验收

全部 gate 通过后才发布首版。

### 基础命令

```bash
la --version
la --help
la -c
la -r
la list
la config
la update
la update --extensions
```

验收内容：命令成功、退出码与 Pi 兼容、帮助和 LYStar 错误为中文、非交互结构未改变、`pi` 与 `la` 可以同机运行。

### 静态与单元验证

- Pi 原有 `test.sh` 和受影响 package 测试通过。
- TypeScript 构建、类型检查和格式检查通过。
- 产品常量、版本比较、manifest 校验、更新源和回退测试通过。
- catalog key 完整性、核心界面 raw string 扫描和英文 allowlist 通过。
- alt-screen 策略、scroll offset、宽字符裁切和 Extension 焦点使用最小单元测试覆盖。

### TUI 自动验证

使用本地 deterministic fake provider 和 Tool fixture，不依赖真实模型网络：

- PTY 覆盖启动、输入、流式输出、Tool、Diff、确认、取消、排队、恢复和退出。
- 80、120、160 列保存 ANSI 归一化快照。
- ANSI screen model 逐帧回放，检查空白帧、非预期整屏 clear、脏行、越界和光标位置。
- 连续 60 秒高频流式输出，底部区域坐标稳定，未变化行不重复写入。
- 连续 100 次 resize，无残影、错行、重复行、越界和光标丢失。
- signal fixture 验证光标、颜色、鼠标模式和 alternate screen 全部恢复。
- 长对话滚动后收到新 token 时保持用户位置，回到底部后恢复跟随。

### 终端手工验证

至少覆盖：

```text
Kitty
Ghostty 或 WezTerm
iTerm2
Windows Terminal
VS Code Terminal
tmux
Zellij
SSH
```

手工检查中文 IME、粘贴、多行输入、组合字符、鼠标滚轮、点击、Shift 文本选择、overlay、自定义 editor、深色、浅色和 256 色降级。tmux control mode、Zellij 和 `--no-alt-screen` 必须进入 inline fallback。

### 数据与生态验证

- 用旧 Pi Session 执行继续、恢复、树导航和压缩。
- `pi` 创建的设置、认证、模型、Skill、Extension 和 Package 可被 `la` 读取。
- `la` 产生的 Pi 标准数据仍可被同基线 `pi` 读取。
- 未知未来 Session entry 不被 LYStar 重写。
- 从用户级、项目级和 Package 路径发现 Skill。
- 安装、禁用、启用和更新一个 Pi Package。
- 测试 Extension 的 command、overlay、footer、widget、editor 和 renderer 全部运行。
- MCP stdio 和 HTTP 各完成发现、调用、取消和超时。

### 发行验证

- macOS arm64/x64、Linux x64/arm64、Windows x64 在 CI 构建并冒烟。
- 每个归档从全新目录运行，确认所有 sidecar 资源可用。
- 无 Node.js 环境可以完成基础 Agent 流程。
- Windows 安装器在没有 Git、Bash 和 Node.js 的干净环境完成安装、启动、更新、回退和卸载；实际调用 `bash` Tool 时再检查兼容 Bash。
- 安装、同版本重装、升级、下载中断、校验失败、切换失败、回退和卸载全部验证。
- `PI_OFFLINE=1` 时不做版本检查和非必要网络请求。
- SHA-256、artifact attestation 和许可证检查通过；未签名测试 release 的 macOS/Windows 系统警告已在发布说明与安装文档中明确。
- 面向普通用户公开推广前，额外验证 macOS Developer ID/notarization 和 Windows Authenticode。

## 13. 风险控制

| 风险 | 控制 |
|---|---|
| 上游合并冲突扩大 | 改动集中在产品常量、locales、viewport、发行和测试；模拟合入后续 tag |
| 重复实现 Pi renderer | 生产渲染只复用 Pi TUI；ANSI screen model 仅用于测试 |
| 全屏在复用器中异常 | `auto/always/never`、环境矩阵、`--no-alt-screen` 和 inline fallback |
| 异常退出污染终端 | signal/exception cleanup 使用同一幂等恢复入口并做 PTY 测试 |
| Pi 与 LYStar 共用数据损坏 | 不改格式；未来 entry 禁止误写；同一 Session 并发写明确禁止 |
| 汉化漏词或误翻技术内容 | 类型化 catalog、限定扫描范围、PTY 快照和带原因 allowlist |
| 第三方 Extension UI 失效 | 保持 API 和生命周期；真实测试 Extension 覆盖全部自定义 UI 入口 |
| 更新中断导致程序不可用 | staging、完整校验、版本目录、原子指针和 previous 回退 |
| Windows executable 无法原地替换 | executable 只安装到新版本目录，`la.cmd` 通过原子版本指针选择目标 |
| 下载来源被篡改 | 首版使用 SHA-256、GitHub artifact attestation 和受保护 release workflow；公开推广前增加 OS 签名 |
| Windows 用户误以为安装依赖 Git 或 Bash | 安装器只安装 LYStar 二进制；`bash` Tool 的可选 Shell 依赖在调用时提示 |

## 14. 调研与许可证来源

- Pi 官方仓库：https://github.com/earendil-works/pi
- Pi 当前基线：`v0.82.1`，commit `b4f293684bba718d59cc1157679bcf6157b3a7f5`
- Pi 本机文档：`extensions.md`、`tui.md`、`themes.md`、`keybindings.md`、`packages.md`、`skills.md`、`sdk.md`、`rpc.md`、`development.md`、`settings.md`、`session-format.md`、`windows.md`、`tmux.md`
- Grok Build：https://github.com/xai-org/grok-build
- Grok Build 调研 commit：`6e386420825bd44ae648c63e7c8cba12fcec9401`
- Grok Build 官方截图：https://media.x.ai/v1/website/universe-tui-screenshot-6f7a0837.png
- Pi MCP Adapter：https://github.com/nicobailon/pi-mcp-adapter，兼容基线 `2.12.1`
- Pi 许可证：MIT
- Grok Build 许可证：Apache-2.0

本文已经固定首版范围、技术边界、安装更新协议、兼容规则和验收条件。开发从仓库基线开始连续推进，全部 gate 通过后一次性交付首个 LYStar Agent release。
