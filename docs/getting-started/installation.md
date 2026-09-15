# 安装 LYStar Code

[返回文档首页](../README.md)

LYStar Code 的独立发行包已经包含运行所需的 executable、WASM、native module、主题和导出资源。安装应用本体无需 Node.js、npm 或 Bun。

## 支持平台

| 系统 | 架构 | 必需条件 |
|---|---|---|
| macOS | Apple Silicon、Intel x64 | Bash、`curl` 或 `wget`、`tar` |
| Linux | x64、ARM64 | Bash、`curl` 或 `wget`、`tar` |
| Windows | x64 | Windows PowerShell 5.1+；在线安装需访问 GitHub Release、WebView2 和 MinGit 下载源 |

Windows ARM64 当前没有独立发行包。macOS 和 Windows 包尚未完成平台代码签名，系统可能显示 Gatekeeper 或 SmartScreen 提示。

## macOS / Linux

```bash
curl -fsSL https://github.com/lystar-team/lystar-code/releases/latest/download/install.sh | bash
```

系统没有 `curl` 时使用：

```bash
wget -qO install.sh https://github.com/lystar-team/lystar-code/releases/latest/download/install.sh
bash install.sh
rm install.sh
```

安装器会：

1. 显示当前系统、架构、下载工具和 PATH 处理方式。
2. 获取版本信息，下载当前平台归档和 `SHA256SUMS`。
3. 校验 SHA-256，解压并检查 `lc`、`lystar` 和候选版本。
4. 写入版本目录并切换 `current`，不覆盖正在使用的旧版本。
5. 创建 `~/.local/bin/lc` 和 `~/.local/bin/lystar`。
6. 检查安装结果，并提示下一步操作。

首次执行 `lc web` 并安装 macOS Web 后台服务时，终端会集中请求一次管理员授权，并继续引导完成用户钥匙串、辅助功能、自动化和屏幕录制授权。管理员密码只由系统 `sudo` 读取，LYStar Code 不保存密码。完成后，Web 后台可通过已安装的 Helper 静默转发 `sudo` 命令。

macOS Gateway 使用系统 LaunchDaemon，Runtime 使用当前登录用户的 LaunchAgent。用户离开电脑或锁屏后服务仍可运行，Runtime 可复用该用户会话中的钥匙串。授权向导会检查系统钥匙串及已登记项目的 Git HTTPS 远端；Git、SSH 或 `security` 不存在时对应项目会标记为“已跳过”，不会阻断安装或更新。

可查看或重新执行授权向导：

```bash
lc web permissions status
lc web permissions setup
```

Web 设置页的“系统授权”仅在 macOS 显示。权限缺失时，后台任务会返回明确错误，不等待无法远程处理的系统弹窗。

下载、校验、解压、版本切换和 PATH 处理都会显示中文状态。失败时会显示原因，并保留当前可用版本。

查看参数：

```bash
bash install.sh --help
```



```bash
curl -fsSL https://github.com/lystar-team/lystar-code/releases/latest/download/install.sh -o install.sh
bash install.sh --no-path-update
rm install.sh
```

随后自行把下面一行加入 Shell 配置：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Windows 10 / 11

在 Windows PowerShell 5.1 或更高版本中执行：

```powershell
$cmd="$env:TEMP\lystar-install.cmd"; iwr -UseBasicParsing https://github.com/lystar-team/lystar-code/releases/latest/download/install.cmd -OutFile $cmd; & $cmd
```

`install.cmd` 会先显示当前操作、安装目录和网络模式，再启动中文安装向导。安装向导会按六个阶段显示进度：获取版本信息、下载并校验发行包、准备桌面终端组件、准备托管 MinGit Bash、写入版本和快捷方式、检查安装结果。失败时会显示原因，并保留当前可用版本；成功后请新开 PowerShell 或 CMD 窗口，让用户 PATH 生效。

查看 `install.cmd` 的常用参数：

```cmd
install.cmd /?
```

需要离线安装、指定版本、回退或卸载时，使用 PowerShell 主脚本的 `-Help`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Help
```

安装器还会：

1. 检测 Microsoft Edge WebView2 Runtime；缺失时按当前用户安装 Evergreen Runtime。
2. 准备 LYStar 自己管理的 MinGit Bash，默认先从 npmmirror 下载固定版本，失败时回退 Git for Windows 官方 Release。
3. 校验 MinGit 固定 SHA-256，并验证托管 Bash 和 Git。
4. 验证 `lystar-terminal.exe`、`lc.exe --version` 和本地终端资源。
5. 全部通过后才切换 LYStar 版本，并创建开始菜单快捷方式。

托管 MinGit 位于 `~/.pi/agent/bin/mingit/`，所有 LYStar 版本共用。`lc` 和 `lystar` 完全等价。交互式命令默认打开 LYStar 独立终端窗口；`lc --version`、`--help`、`--print`、JSON/RPC、管道和安装更新命令仍在当前终端运行。需要在当前终端运行 TUI 时使用：

```powershell
lc --attached
```

## 验证

```bash
lc --version
lc --help
lystar --version
```

`lc --version` 应输出 `<Pi版本>-lystar.<修订号>`，例如 `0.82.1-lystar.5`。

## 先审阅安装器再执行

macOS/Linux：

```bash
curl -fsSL https://github.com/lystar-team/lystar-code/releases/latest/download/install.sh -o install.sh
less install.sh
bash install.sh
rm install.sh
```

Windows：

```powershell
$cmd="$env:TEMP\lystar-install.cmd"; iwr -UseBasicParsing https://github.com/lystar-team/lystar-code/releases/latest/download/install.cmd -OutFile $cmd
notepad $cmd
& $cmd
Remove-Item $cmd
```

`install.cmd` 会下载同一 Release 中的 `install.ps1`。需要直接审阅 PowerShell 主脚本时：

```powershell
irm https://github.com/lystar-team/lystar-code/releases/latest/download/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
Remove-Item .\install.ps1
```

## 手动安装

公司策略禁止执行网络脚本时：

1. 打开 [GitHub Releases](https://github.com/lystar-team/lystar-code/releases/latest)。
2. 下载匹配系统与架构的 `.tar.gz` 或 `.zip`，同时下载 `SHA256SUMS`。
3. 校验归档 SHA-256。
4. 解压并运行归档中的 `lc --version`。
5. 将 `lc`、`lystar` 或对应 Windows launcher 所在目录加入 PATH。

Linux：

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

macOS：

```bash
shasum -a 256 <下载的归档>
```

Windows PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 .\<下载的归档>
```

手动安装没有 `current` / `previous` 版本切换。需要 `lc update` 和一键回退时使用官方安装器。

手动解压后首次启动 LYStar 时，也会自动补齐托管 MinGit Bash。`PI_OFFLINE=1` 会禁止隐式下载；可以提前准备固定版本的 MinGit zip：

```powershell
lc --ensure-windows-bash --archive .\MinGit-2.55.0.3-64-bit.zip --offline
```

完全离线安装时，把 Windows 发行包、`release-manifest.json`、MinGit zip、WebView2 Evergreen Standalone Installer 和 `install.ps1` 放在同一台机器，再执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -Offline `
  -ReleaseArchive .\lystar-agent-v<version>-windows-x64.zip `
  -ReleaseManifest .\release-manifest.json `
  -MinGitArchive .\MinGit-2.55.0.3-64-bit.zip `
  -WebView2Installer .\MicrosoftEdgeWebView2RuntimeInstallerX64.exe
```

## 固定版本

先下载安装器，再传入不带 `v` 的版本号：

```bash
bash install.sh --version 0.82.1-lystar.5
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.82.1-lystar.5
```

中国大陆下载配置见[中国大陆网络配置](mainland-china.md)，安装失败见[安装问题](../troubleshooting/installation.md)。
