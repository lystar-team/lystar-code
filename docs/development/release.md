# 发行

[返回文档首页](../README.md)

LYStar tag 格式：

```text
v<Pi版本>-lystar.<修订号>
```

同一 Pi 基线递增 LYStar 修订号；合并新 Pi 版本后从 `lystar.1` 开始。发行版本事实源是 `packages/coding-agent/package.json` 的 `piConfig.productVersion`。

## 发布前

1. 工作区干净，目标提交已推送到 `origin/main`。
2. CI 通过。
3. `productVersion`、README、兼容矩阵和验证记录一致。
4. 完成[全部 gate](verification.md)。
5. Unix runner 构建 macOS/Linux，Windows runner 原生构建 Windows 包。

```bash
bash scripts/build-binaries.sh --offline-model-data
```

Windows x64 必须在安装了 MSVC Build Tools 的 Windows 主机执行：

```powershell
npm ci --ignore-scripts
npm run build:offline
.\scripts\build-windows-release.ps1 -Repository lystar-team/lystar-code
.\scripts\test-windows-terminal.ps1 -BundleDir .\packages\coding-agent\binaries\windows-x64\lystar-agent
```

两个 runner 的归档合并后再运行 `generate-release-metadata.mjs` 生成 SHA、manifest 和安装器。Ubuntu 不允许交叉编译 `lc.exe`，因为 Bun 的 `--windows-icon` 只在 Windows 构建进程中生效。

产物必须包含：

```text
lystar-agent-v<version>-darwin-arm64.tar.gz
lystar-agent-v<version>-darwin-x64.tar.gz
lystar-agent-v<version>-linux-arm64.tar.gz
lystar-agent-v<version>-linux-x64.tar.gz
lystar-agent-v<version>-windows-x64.zip
SHA256SUMS
release-manifest.json
install.sh
install.ps1
install.cmd
VERSION
```

核对 manifest 的版本、Pi 版本、仓库、五平台文件、大小和 SHA-256。Linux x64 解压后执行版本、帮助、离线模型列表和真实 PTY smoke。Windows 还必须检查：

- `lc.exe` 和 `lystar-terminal.exe` 均带 LYStar ICO。
- WebView2 SDK 版本和 nupkg SHA-256 固定。
- `terminal/` 包含 xterm.js、fit addon、Noto Sans CJK 和对应许可证。
- `lystar-terminal.exe --smoke-test`、ConPTY 窗口、Unicode 截图、resize、键盘输入和退出通过。
- 清空系统 Git/Bash PATH 后，standalone `lc.exe` 的在线、并发和离线 MinGit 初始化通过。
- 安装器使用本次构建的本地 zip 和 manifest 完成安装、启动、快捷方式和卸载。

更新 Windows Logo 时运行：

```bash
node scripts/generate-windows-icon.mjs source.png \
  packages/coding-agent/assets/lystar-windows-icon.png \
  packages/coding-agent/assets/lystar-windows-icon.ico
```

ICO 必须包含 `16、20、24、32、40、48、64、128、256` 像素图层。

## Tag

使用 annotated tag，tag 必须精确等于 `v${piConfig.productVersion}`：

```bash
git tag -a vX.Y.Z-lystar.N \
  -m "LYStar Code vX.Y.Z-lystar.N" \
  -m "本版主要变更。"
git push origin vX.Y.Z-lystar.N
```

匹配 `v*-lystar.*` 的 tag 会触发 `.github/workflows/release.yml`，完成检查、测试、五平台打包、attestation 和 GitHub Release。

## 发布后

```bash
gh run list --limit 5
gh release view <tag> --json url,assets,isDraft,isPrerelease
```

确认：

- CI 和 Release workflow 成功。
- Release 公开且不是 draft/prerelease。
- 五平台包、三个安装器、`SHA256SUMS` 和 manifest 共 10 个公开资产。
- 下载的 manifest 与 SHA 正确。
- 当前平台资产存在 provenance attestation。
- 从旧版执行 `lc update` 后 current/previous 正确。
- 再次更新显示已是最新版本。

## 失败处理

已推送 tag 不移动、不强推、不覆盖历史资产。可复现的源码、测试或构建问题修复后发布新的 LYStar 修订号。网络和偶发资源超时只有在确认没有断言与行为失败后才重跑 job。
