# Windows 问题

[返回文档首页](../README.md)

LYStar 当前提供 Windows x64 发行包，需要 PowerShell 5.1+ 和 Bash。

## 安装 Git for Windows

```powershell
winget install --id Git.Git -e --source winget
```

或使用 [Git for Windows 官方安装页](https://git-scm.com/download/win)。安装后重新打开 PowerShell。

确认 Bash：

```powershell
Get-Command bash.exe -ErrorAction SilentlyContinue
Test-Path "C:\Program Files\Git\bin\bash.exe"
```

LYStar 按以下顺序寻找 Shell：

1. `~/.pi/agent/settings.json` 的 `shellPath`。
2. `C:\Program Files\Git\bin\bash.exe`。
3. PATH 中的 `bash.exe`。

自定义 Shell：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## PATH 没有生效

安装器修改的是用户 PATH，当前 PowerShell 不会自动刷新。关闭所有终端窗口后重新打开，再运行：

```powershell
Get-Command la
la --version
```

## PowerShell 执行策略

下载安装器文件后可显式执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

该参数只作用于本次 PowerShell 进程，不修改系统永久执行策略。

## SmartScreen

Windows 发行包尚未配置 Authenticode，SmartScreen 可能提示未知发布者。只从 `octyean/lystar-agent` GitHub Release 下载，并核对 `SHA256SUMS`。公司设备禁止未签名程序时，应交由管理员审核，不绕过组织策略。

## Windows ARM64

当前没有 Windows ARM64 独立发行包。安装器会明确停止，不会安装 x64 包冒充原生支持。

## 快捷键

Windows Terminal 默认占用部分组合键，例如 `Alt+Enter`。可以在 Windows Terminal 设置中调整，或在 `~/.pi/agent/keybindings.json` 重绑定。Windows 原生终端不支持 Unix `Ctrl+Z` 挂起。

更多 Shell 规则见 [Pi Windows Setup](../../packages/coding-agent/docs/windows.md)。
