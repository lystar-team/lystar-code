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

macOS 已安装 Web 后台服务时，`lc update` 会复用首次安装的管理员授权更新 Helper、Gateway LaunchDaemon 和 Runtime LaunchAgent，不重复询问管理员密码。从 Web 设置页启动更新前会检查管理员静默通道；未初始化时更新不会启动，并提示在本机终端执行：

```bash
lc web service install
lc web permissions setup
```

授权状态可通过 `lc web permissions status` 或 Web 设置页的“系统授权”查看。钥匙串初始化会探测当前系统实际存在的 Git、SSH 和 `security`，缺失工具直接跳过。Web Git 通过带超时的 Keychain helper 读取 HTTPS 凭据，SSH 使用非交互模式；未授权或凭据不可用时直接返回错误，不弹出远程无法处理的输入窗口。

Web 后台中的 `osascript ... with administrator privileges` 会直接报错，管理员命令应使用 `sudo`；普通 `osascript` 和 `security` 等待系统授权超过 30 秒时会终止并提示重新授权。

## 回退

```bash
lc update --rollback
```

回退会交换 `current` 和 `previous`，不修改 `~/.pi/agent`。没有 previous 版本时命令会停止并说明原因。

## 卸载 macOS / Linux

```bash
curl -fsSL https://github.com/lystar-team/lystar-code/releases/latest/download/install.sh -o install.sh
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
irm https://github.com/lystar-team/lystar-code/releases/latest/download/install.ps1 -OutFile install.ps1
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
