# 更新、回退与卸载

[返回文档首页](../README.md)

官方安装器把每个版本放在独立目录，通过 `current` 和 `previous` 切换。更新失败不会覆盖当前版本。

## 更新 LYStar

```bash
lc update
```

只更新应用本体：

```bash
lc update --self
```

只更新已安装 Package：

```bash
lc update --extensions
```

更新本体和 Package：

```bash
lc update --all
```

`PI_OFFLINE=1` 或 `--offline` 下不会执行网络更新。

## 回退

```bash
lc update --rollback
```

回退会交换 `current` 和 `previous`，不修改 `~/.pi/agent`。没有 previous 版本时命令会停止并说明原因。

## 卸载 macOS / Linux

```bash
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh -o install.sh
bash install.sh --uninstall
rm install.sh
```

安装器可能为 PATH 写入以下一行，卸载默认不删除它，避免影响用户原有配置：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

确认不再需要 `~/.local/bin` 后，可从 `~/.zprofile`、`~/.bashrc`、`~/.bash_profile` 或 `~/.profile` 人工删除。

## 卸载 Windows

```powershell
irm https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1 -OutFile install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
Remove-Item .\install.ps1
```

Windows 安装器会移除 `%LOCALAPPDATA%\LYStarAgent` 并从用户 PATH 删除 launcher 目录。

## 数据保留

更新、回退和卸载都保留：

```text
~/.pi/agent/
项目 .pi/
```

要彻底删除设置、凭据、Session、Skill 和 Extension，先备份需要保留的内容，再人工删除 `~/.pi/agent`。该目录也可能被 Pi 使用，Pi 与 LYStar 共存时不要删除。

## 安装目录

macOS/Linux：

```text
~/.local/share/lystar-agent/versions/<version>/
~/.local/share/lystar-agent/current
~/.local/share/lystar-agent/previous
~/.local/bin/lc
```

Windows：

```text
%LOCALAPPDATA%\LYStarAgent\versions\<version>\
%LOCALAPPDATA%\LYStarAgent\current
%LOCALAPPDATA%\LYStarAgent\previous
%LOCALAPPDATA%\LYStarAgent\bin\lc.cmd
```

网络失败见[网络问题](../troubleshooting/network.md)，版本切换异常见[安装问题](../troubleshooting/installation.md)。
