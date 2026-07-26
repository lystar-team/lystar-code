# 安装 LYStar Agent

[返回文档首页](../README.md)

LYStar Agent 的独立发行包已经包含运行所需的 executable、WASM、native module、主题和导出资源。安装应用本体无需 Node.js、npm 或 Bun。

## 支持平台

| 系统 | 架构 | 必需条件 |
|---|---|---|
| macOS | Apple Silicon、Intel x64 | Bash、`curl` 或 `wget`、`tar` |
| Linux | x64、ARM64 | Bash、`curl` 或 `wget`、`tar` |
| Windows | x64 | PowerShell 5.1+、Git for Windows |

Windows ARM64 当前没有独立发行包。macOS 和 Windows 包尚未完成平台代码签名，系统可能显示 Gatekeeper 或 SmartScreen 提示。

## macOS / Linux

```bash
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh | bash
```

系统没有 `curl` 时使用：

```bash
wget -qO install.sh https://github.com/octyean/lystar-agent/releases/latest/download/install.sh
bash install.sh
rm install.sh
```

安装器会：

1. 识别系统和 CPU 架构。
2. 从 GitHub Release 读取最新版本。
3. 下载当前平台归档和 `SHA256SUMS`。
4. 校验 SHA-256，并运行归档内的 `la --version`。
5. 安装到 `~/.local/share/lystar-agent/versions/<version>/`。
6. 切换 `current`，在 `~/.local/bin/` 创建 `la`。
7. PATH 缺失时写入当前 Shell 的 profile，并提示重新打开终端。

不希望安装器修改 Shell profile：

```bash
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh -o install.sh
bash install.sh --no-path-update
rm install.sh
```

随后自行把下面一行加入 Shell 配置：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Windows PowerShell

LYStar 运行 Shell Tool 时需要 Bash。先安装 Git for Windows：

```powershell
winget install --id Git.Git -e --source winget
```

没有 `winget` 时，从 [Git for Windows 官方页面](https://git-scm.com/download/win)下载安装。重新打开 PowerShell，然后执行：

```powershell
irm https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1 | iex
```

安装器写入用户 PATH，不要求管理员权限。安装完成后重新打开终端。

## 验证

```bash
la --version
la --help
```

`la --version` 应输出 `<Pi版本>-lystar.<修订号>`，例如 `0.82.1-lystar.3`。

## 先审阅安装器再执行

macOS/Linux：

```bash
curl -fsSL https://github.com/octyean/lystar-agent/releases/latest/download/install.sh -o install.sh
less install.sh
bash install.sh
rm install.sh
```

Windows PowerShell：

```powershell
irm https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
Remove-Item .\install.ps1
```

## 手动安装

公司策略禁止执行网络脚本时：

1. 打开 [GitHub Releases](https://github.com/octyean/lystar-agent/releases/latest)。
2. 下载匹配系统与架构的 `.tar.gz` 或 `.zip`，同时下载 `SHA256SUMS`。
3. 校验归档 SHA-256。
4. 解压并运行归档中的 `la --version`。
5. 将 `la` 或 `la.exe` 所在目录加入 PATH。

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

手动安装没有 `current` / `previous` 版本切换。需要 `la update` 和一键回退时使用官方安装器。

## 固定版本

先下载安装器，再传入不带 `v` 的版本号：

```bash
bash install.sh --version 0.82.1-lystar.3
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.82.1-lystar.3
```

中国大陆下载配置见[中国大陆网络配置](mainland-china.md)，安装失败见[安装问题](../troubleshooting/installation.md)。
