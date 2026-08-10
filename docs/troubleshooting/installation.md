# 安装问题

[返回文档首页](../README.md)

先运行：

```bash
lc --version
```

根据结果选择下面的排查路径。

## 找不到 `lc`

macOS/Linux：

```bash
ls -l ~/.local/bin/lc
printf '%s\n' "$PATH"
```

文件存在但 PATH 没有 `~/.local/bin`：

```bash
export PATH="$HOME/.local/bin:$PATH"
lc --version
```

确认后把同一行写入当前 Shell 的 `~/.zprofile`、`~/.bashrc`、`~/.bash_profile` 或 `~/.profile`，重新打开终端。

Windows：重新打开 PowerShell，再检查：

```powershell
Get-Command lc
[Environment]::GetEnvironmentVariable("Path", "User")
```

## `curl` 或 `wget` 缺失

安装器至少需要一个下载工具。Linux 使用系统包管理器安装 `curl` 或 `wget`；macOS 通常自带 `curl`。也可以在浏览器中从 [GitHub Releases](https://github.com/lystar-team/lystar-code/releases/latest) 手动下载。

## SHA-256 校验失败

不要继续解压或运行归档。删除本次下载后重试：

- 确认归档和 `SHA256SUMS` 来自同一个 Release。
- 关闭会替换下载内容的第三方脚本转发站。
- 检查代理是否返回了 HTML 错误页。
- 多次失败时记录版本、资产文件名和实际 SHA-256。

## `发行包缺少 lc` 或版本 smoke 失败

安装器会在切换 `current` 前停止，原版本仍可用。检查临时目录清理后重新运行；稳定复现时提交版本、系统、架构和完整错误。

## 无法回退

```bash
lc update --rollback
```

只有通过官方安装器升级且存在 previous 版本时才能回退。手动解压安装没有 previous 指针。

## 终端退出后显示异常

先执行：

```bash
reset
```

再次启动时使用 inline：

```bash
lc --no-alt-screen --no-mouse
```

提交问题时附终端名称、`TERM`、是否在 tmux/Zellij 中、终端尺寸和退出方式。

网络超时见[网络问题](network.md)，Windows Bash 见[Windows 问题](windows.md)。
