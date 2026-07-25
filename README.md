# LYStar Agent

LYStar Agent 是基于 Pi `v0.82.1` 的中文编码 Agent。命令固定为 `la`，保留 Pi Runtime、Session、Skill、Extension、Package、MCP 与 `.pi` 数据兼容。

## 本地开发

要求 Node.js 22、npm、Bun 和 Bash。Windows 推荐安装 Git for Windows 提供 Bash。

```bash
npm ci --ignore-scripts
npm run build:offline
node packages/coding-agent/dist/cli.js --help
```

交互模式：

```bash
node packages/coding-agent/dist/cli.js
```

源码构建仍使用 monorepo 内部包名，最终用户命令和独立发行包使用 `la`。

## TUI

交互模式默认在常规 TTY 中进入 alternate screen，固定显示顶栏、独立滚动的对话区、输入区、快捷栏和状态栏。

- `Shift+PageUp` / `Shift+PageDown`：滚动对话
- `Ctrl+Home` / `Ctrl+End`：跳到首行或末行
- 鼠标滚轮：滚动对话
- 点击新内容提示：回到底部并继续跟随输出
- `--alt-screen auto|always|never`：控制全屏策略
- `--no-alt-screen`：强制 inline fallback
- `--mouse` / `--no-mouse`：覆盖鼠标设置

`auto` 会在 Zellij、tmux control mode、非 TTY 和 `TERM=dumb` 环境回退到 inline，普通终端和常规 tmux 使用全屏模式。UI 偏好保存在 `~/.pi/agent/lystar.json`：

```json
{
  "altScreen": "auto",
  "mouse": true,
  "reduceMotion": false
}
```

## 兼容性

LYStar Agent 继续读取：

- `~/.pi/agent/settings.json`
- `~/.pi/agent/sessions/`
- 用户与项目级 `.pi/`
- `PI_*` 环境变量
- Pi Skill、Extension、Package、Theme、Prompt Template 与 MCP Extension

不要让 Pi 和 LYStar 同时写同一个 Session 文件。需要并行运行时分别创建会话。

## 独立发行包

生成 Linux x64/ARM64、macOS x64/ARM64、Windows x64 完整发行包。仓库固定为 `octyean/lystar-agent`，构建时会把该地址写入发行包：

```bash
bash scripts/build-binaries.sh --offline-model-data
```

macOS/Linux 安装：

```bash
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh | sh
```

Windows PowerShell 安装：

```powershell
irm https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1 | iex
```

产物位于 `packages/coding-agent/binaries/`，包括五个平台压缩包、`SHA256SUMS`、`release-manifest.json`、`install.sh` 和 `install.ps1`。每个平台包都带 executable、WASM、native module、主题、HTML 导出资源、文档和许可证。

首版允许发布未签名测试包。macOS 会显示 Gatekeeper 警告，Windows 可能触发 SmartScreen；正式面向普通用户推广前再配置 Developer ID/notarization 和 Authenticode。所有发行包都必须发布 SHA-256，CI 可附加 GitHub artifact attestation。

## 更新与回退

正式发行包支持：

```bash
la update
la update --rollback
```

安装器把版本放入独立目录，通过 `current` 和 `previous` 指针切换。更新失败不会覆盖当前版本；卸载或回退不会删除 `~/.pi/agent`。

## 来源与许可证

LYStar Agent 当前基于 `earendil-works/pi` `v0.82.1`，上游 commit：

```text
b4f293684bba718d59cc1157679bcf6157b3a7f5
```

项目按 [MIT License](LICENSE) 发行。第三方依赖说明见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。Grok Build 仅作为全屏 TUI 交互参考，没有复制其源码或资产。
