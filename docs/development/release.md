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
5. 本地构建五平台包并校验 SHA。

```bash
bash scripts/build-binaries.sh --offline-model-data
cd packages/coding-agent/binaries
sha256sum -c SHA256SUMS
```

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

核对 manifest 的版本、Pi 版本、仓库、五平台文件、大小和 SHA-256。Linux x64 解压后执行版本、帮助、离线模型列表和真实 PTY smoke。

## Tag

使用 annotated tag，tag 必须精确等于 `v${piConfig.productVersion}`：

```bash
git tag -a vX.Y.Z-lystar.N \
  -m "LYStar Agent vX.Y.Z-lystar.N" \
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
- 从旧版执行 `la update` 后 current/previous 正确。
- 再次更新显示已是最新版本。

## 失败处理

已推送 tag 不移动、不强推、不覆盖历史资产。可复现的源码、测试或构建问题修复后发布新的 LYStar 修订号。网络和偶发资源超时只有在确认没有断言与行为失败后才重跑 job。
