# Windows 问题

[返回文档首页](../README.md)

LYStar 当前提供 Windows x64 发行包，需要 Windows PowerShell 5.1+。官方安装器会自动准备 LYStar 自己管理的 MinGit Bash，用户无需预装 Git、Bash、Node.js 或 npm。文件位于 `~/.pi/agent/bin/mingit/`，不会修改系统 Git 安装。

## 托管 MinGit Bash

安装和首次启动会检查托管环境。缺失或自检失败时，LYStar 先从 npmmirror 下载固定的 MinGit `2.55.0.3`，失败时回退 Git for Windows 官方 Release；SHA-256 不匹配、解压失败或 Bash/Git 自检失败都会停止安装，不会切换到半成品版本。

手动触发检查：

```powershell
la --ensure-windows-bash
```

`PI_OFFLINE=1` 时 LYStar 不会隐式联网。托管环境尚未准备好时，应先关闭离线模式执行上面的命令。

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
Get-Command la
la --version
```

## PowerShell 执行策略

优先使用 `install.cmd`，它会给下载后的主脚本启动一个进程级 `ExecutionPolicy Bypass`：

```powershell
$cmd="$env:TEMP\lystar-install.cmd"; iwr -UseBasicParsing https://github.com/octyean/lystar-agent/releases/latest/download/install.cmd -OutFile $cmd; & $cmd
```

该参数不会修改系统或用户执行策略。若 AppLocker、WDAC 或组织策略禁止启动 PowerShell、CMD 或未签名的 `la.exe`，安装器会停止；这类策略需要管理员放行。

## SmartScreen

Windows 发行包尚未配置 Authenticode，SmartScreen 可能提示未知发布者。只从 `octyean/lystar-agent` GitHub Release 下载，并核对 `SHA256SUMS`。公司设备禁止未签名程序时，应交由管理员审核，不绕过组织策略。

## Windows ARM64

当前没有 Windows ARM64 独立发行包。安装器会明确停止，不会安装 x64 包冒充原生支持。

## 快捷键

Windows Terminal 默认占用部分组合键，例如 `Alt+Enter`。可以在 Windows Terminal 设置中调整，或在 `~/.pi/agent/keybindings.json` 重绑定。Windows 原生终端不支持 Unix `Ctrl+Z` 挂起。

更多 Shell 规则见 [Pi Windows Setup](../../packages/coding-agent/docs/windows.md)。
