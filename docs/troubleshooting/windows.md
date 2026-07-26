# Windows 问题

[返回文档首页](../README.md)

LYStar 当前提供 Windows x64 发行包，需要 Windows PowerShell 5.1+。安装、启动、登录、会话管理和文件读写不依赖 Git 或 Bash，官方安装器也不会下载 Git。

## Bash Tool

只有实际执行内建 `bash` Tool 时才需要兼容 Bash。LYStar 会寻找 Git Bash 和 PATH 中的 `bash.exe`，也可以在 `settings.json` 中指定 WSL、Cygwin、MSYS2 或其他 Bash：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

没有 Bash 时，其他功能仍可正常使用；调用 `bash` Tool 会显示缺少 Shell 的错误。需要该 Tool 时再安装 Git for Windows，或配置机器上已有的兼容 Bash。

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
