# 中国大陆网络配置

[返回文档首页](../README.md)

LYStar 本体、Pi Package 和模型 Provider 使用不同网络链路。先确认卡在哪一步，再配置对应入口。

| 场景 | 访问目标 | 处理方式 |
|---|---|---|
| 安装或更新 LYStar | GitHub Releases | `HTTP_PROXY` / `HTTPS_PROXY` |
| Windows 首次准备 MinGit Bash | npmmirror，失败时回退 Git for Windows Release | 自动处理并校验固定 SHA-256 |
| 安装 `npm:` Package | npm registry | npmmirror 或 npm 官方源 |
| 安装 `git:` Package | Git 仓库 | Git 可访问网络或 Git 代理 |
| 调用模型 | Provider API | Provider 官方国内端点或代理 |

## GitHub Release 下载

macOS/Linux：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
curl -fsSL https://github.com/lystar-team/lystar-code/releases/latest/download/install.sh | bash
unset HTTPS_PROXY HTTP_PROXY
```

Windows PowerShell：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$cmd="$env:TEMP\lystar-install.cmd"
iwr -UseBasicParsing https://github.com/lystar-team/lystar-code/releases/latest/download/install.cmd -OutFile $cmd
& $cmd
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
```

`127.0.0.1:7890` 只是示例，替换成自己已经在使用的代理地址和端口。LYStar 不附带代理服务。

长期给 LYStar Provider 请求使用代理，可写入 `~/.pi/agent/settings.json`：

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

该设置会补充 `HTTP_PROXY` 和 `HTTPS_PROXY`，已有环境变量优先。

## Windows MinGit Bash

Windows 安装器和首次启动会自动准备 LYStar 托管的 MinGit Bash。固定资产优先从 npmmirror 下载，失败时回退 Git for Windows 官方 Release；两条链路都必须通过代码内固定 SHA-256 校验。该镜像只用于这个固定二进制资产，不改变 npm registry 或 Git Package 下载地址。

手动重试：

```powershell
lc --ensure-windows-bash
```

## npm 国内源

[npmmirror](https://npmmirror.com/)提供 npm 只读镜像。只对当前安装命令生效：

```bash
npm_config_registry=https://registry.npmmirror.com lc install npm:<package>
```

Windows PowerShell：

```powershell
$env:npm_config_registry = "https://registry.npmmirror.com"
lc install npm:<package>
Remove-Item Env:npm_config_registry
```

全局设置：

```bash
npm config set registry https://registry.npmmirror.com
npm config get registry
```

恢复 npm 官方源：

```bash
npm config delete registry
```

npm 镜像只处理 npm 包及 git Package 的 npm 依赖，不加速 GitHub Release 或 `git clone`。

## Git Package

单次代理：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
  lc install git:github.com/<owner>/<repo>@<tag-or-commit>
```

全局 Git 代理：

```bash
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
```

恢复：

```bash
git config --global --unset http.proxy
git config --global --unset https.proxy
```

全局配置会影响其他 Git 仓库，优先使用单次环境变量。

## 国内 Provider

LYStar 已包含多个中国区 Provider 配置，例如 ZAI Coding Plan、MiniMax、Qwen Token Plan 和 Xiaomi MiMo Token Plan。使用 `/login` 查看当前版本支持的 Provider，环境变量见 [Provider 与 API Key](providers.md)。

Provider API 是否需要代理取决于服务端点。官方提供中国区端点时优先使用对应 Provider，避免自行替换未知 base URL。

## 安全边界

- LYStar Release 以 `lystar-team/lystar-code` GitHub Release 为发行事实源。
- 文档不推荐来源不明的 GitHub 脚本转发或下载加速站。
- 下载归档后仍需通过官方 `SHA256SUMS` 校验。
- npm 镜像、Git 代理和模型 Provider 分别配置，不混用一个“镜像源”概念。

仍无法下载时见[网络问题](../troubleshooting/network.md)或使用[手动安装](installation.md#手动安装)。
