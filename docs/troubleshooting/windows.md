# Windows 问题

[返回文档首页](../README.md)

LYStar 当前提供 Windows x64 发行包，需要 Windows PowerShell 5.1+。官方安装器会自动准备 LYStar 自己管理的 MinGit Bash，用户无需预装 Git、Bash、Node.js 或 npm。文件位于 `~/.pi/agent/bin/mingit/`，不会修改系统 Git 安装。

交互式 `lc` 默认使用 LYStar 独立终端窗口。一次性 CLI、管道、`--print`、JSON/RPC、安装和更新命令继续使用当前 PowerShell、CMD 或 IDE 终端。

## 独立窗口无法启动

先在当前终端运行：

```powershell
lc --attached
```

若 attached 模式可用，通常是 WebView2 Runtime 或 `lystar-terminal.exe` 资源不完整。重新运行官方安装器会在切换版本前检查 WebView2、终端宿主、xterm.js、本地字体和图标。离线环境可显式提供 WebView2 安装包：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -WebView2Installer .\MicrosoftEdgeWebView2RuntimeInstallerX64.exe
```

不要单独移动 `lc.exe`。Windows 发行目录中的 `lystar-terminal.exe`、`terminal/`、`assets/`、native module 和 WASM 必须一起保留。

## 托管 MinGit Bash

安装和首次启动会检查托管环境。缺失或自检失败时，LYStar 先从 npmmirror 下载固定的 MinGit `2.55.0.3`，失败时回退 Git for Windows 官方 Release；SHA-256 不匹配、解压失败或 Bash/Git 自检失败都会停止安装，不会切换到半成品版本。

手动触发检查：

```powershell
lc --ensure-windows-bash
```

`PI_OFFLINE=1` 时 LYStar 不会隐式联网。托管环境尚未准备好时，应先关闭离线模式执行上面的命令。

已有 MinGit zip 时可以离线初始化：

```powershell
lc --ensure-windows-bash --archive .\MinGit-2.55.0.3-64-bit.zip --offline
```

该 zip 仍会按代码内固定 SHA-256 校验。文件不存在、checksum 不一致、解压失败、Bash 启动失败或 Git 解析到托管目录之外时，命令会失败并保留旧环境。

显式配置 `shellPath` 仍会覆盖默认 Shell，用于确实需要 WSL、Cygwin 或其他 Bash 的场景：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

配置项不存在时，内建 `bash` Tool、Git 分支检测和 `git:` Package 都优先使用托管 MinGit。系统 Git Bash 和 PATH 中的 `bash.exe` 只作为手动解压或离线场景的兼容回退。

## PATH 没有生效

安装器修改用户 PATH 后会广播环境变化。已经打开的 PowerShell、CMD 或 Windows Terminal 进程仍可能保留旧环境；新开一个终端窗口后运行：

```powershell
Get-Command lc
lc --version
```

## PowerShell 执行策略

优先使用 `install.cmd`，它会给下载后的主脚本启动一个进程级 `ExecutionPolicy Bypass`：

```powershell
$cmd="$env:TEMP\lystar-install.cmd"; iwr -UseBasicParsing https://github.com/lystar-team/lystar-code/releases/latest/download/install.cmd -OutFile $cmd; & $cmd
```

该参数不会修改系统或用户执行策略。若 AppLocker、WDAC 或组织策略禁止启动 PowerShell、CMD 或未签名的 `lc.exe`，安装器会停止；这类策略需要管理员放行。

## SmartScreen

Windows 发行包尚未配置 Authenticode，SmartScreen 可能提示未知发布者。只从 `lystar-team/lystar-code` GitHub Release 下载，并核对 `SHA256SUMS`。公司设备禁止未签名程序时，应交由管理员审核，不绕过组织策略。

## Windows ARM64

当前没有 Windows ARM64 独立发行包。安装器会明确停止，不会安装 x64 包冒充原生支持。

## 字体、中文输入和快捷键

独立窗口自带 Noto Sans Mono CJK 字体面，不读取 PowerShell 或 Windows Terminal 的字体设置。中文候选框异常时，先确认系统输入法能在普通 WebView2 应用中输入，再使用 `lc --attached` 对比；只有独立窗口异常时重新安装 WebView2 Runtime。

`Ctrl+Shift+C` 复制选择内容，`Ctrl+Shift+V` 粘贴。Agent 快捷键仍由 `~/.pi/agent/keybindings.json` 控制。Windows 原生终端不支持 Unix `Ctrl+Z` 挂起。

更多 Shell 规则见 [Pi Windows Setup](../../packages/coding-agent/docs/windows.md)。
