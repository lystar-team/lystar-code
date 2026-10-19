# 发行

[返回文档首页](../README.md)

LYStar tag 格式：

```text
v<Pi版本>-lystar.<修订号>
```

同一 Pi 基线递增 LYStar 修订号；合并新 Pi 版本后从 `lystar.1` 开始。发行版本事实源是 `packages/coding-agent/package.json` 的 `piConfig.productVersion`。

## 一键发布 LYStar Code

在 Linux 或 macOS 的 `main` 分支执行：

```bash
npm run release:lystar
```

先提交本次要发布的代码，并在各包的 `CHANGELOG.md` 的 `[Unreleased]` 中写入变更说明。脚本要求工作区干净，允许本地 `main` 有尚未推送的提交；远端 `main` 必须是本地提交的祖先。运行环境需要 Node.js、npm、Bash、Git，以及已登录、支持 `gh attestation verify` 的 GitHub CLI。`origin` 必须指向 `lystar-team/lystar-code`。

默认从 `piConfig.productVersion` 读取版本，将当前 Pi 基线的 `lystar.N` 递增为 `lystar.N+1`。合并其他 Pi Tag 后通过下方的 `--upstream-tag` 选择基线。脚本自动完成：

1. 同步包版本、内部依赖、根锁文件、install-lock、shrinkwrap 和嵌套示例锁文件；将各包非空的 `[Unreleased]` 归入本版，保留空的 `[Unreleased]`。coding-agent 没有待发布条目时写入版本递增说明。
2. 更新 README 中的当前版本、建设方案的产品版本与兼容矩阵。矩阵新行引用本版 Changelog，不自动推断兼容性。
3. 增量安装依赖（`npm install --ignore-scripts --no-audit --no-fund`），复用已有依赖目录；同步锁文件后运行 `npm run check:release`、Unix 安装器检查和已有版本、更新器、发行元数据测试。
4. 只提交发行生成的文件，提交钩子复用已通过的发行检查，继续检查锁文件提交授权和暂存差异；随后推送 `main` 和 annotated Tag。
5. 等待本版的 Release workflow，确认全部 job 成功和十个公开资产齐全。
6. 下载当前平台归档、manifest、SHA 清单和三个安装器，核对十个公开资产的名称、五平台清单及公开归档大小，校验当前平台归档 SHA、安装器内容和来源证明。
7. 提交并推送 `AGENT_VERIFICATION.md` 中的实际验证结果。

开发代码提交执行完整 `npm run check`，包括类型、Web 和浏览器打包检查。发行入口执行 `npm run check:release`，检查产品版本、workspace 内部依赖、依赖固定和发行锁文件；五平台原生构建与包检查由 Release workflow 执行。纯 Markdown 提交由提交钩子执行暂存差异检查。脚本不会自动发起真实模型请求或执行手工终端检查；功能改动按[验证范围](verification.md)完成对应检查。

预览不修改文件，也不提交或发布：

```bash
npm run release:lystar -- --dry-run
```

### 合并上游 Tag 后发布

先按[同步 Pi 上游](upstream-sync.md)完成合并、冲突处理与对应验证，提交合并结果并回到 `main`。发布入口不会自行合并上游。下面的 `v2.0.0` 是用法示例，请替换成已经合入的实际 Tag：

```bash
npm run release:lystar -- --upstream-tag v2.0.0 --dry-run
```

确认预览后执行：

```bash
npm run release:lystar -- --upstream-tag v2.0.0
```

脚本读取该 Tag 的 Pi 包版本和 commit，验证 Tag 已合入当前 `HEAD`，再读取 LYStar GitHub latest 来选择发行版本。它不按上游最新版本自动合并，也不把未合入的 Tag 当成发行基线。

| 情况 | 版本结果示例 |
|---|---|
| 同一 Pi 基线的常规发布 | `1.1.0-lystar.11 → 1.1.0-lystar.12` |
| 更换 Pi patch 基线 | `1.1.0-lystar.11 → 1.1.1-lystar.1` |
| 更换 Pi minor 基线 | `1.1.0-lystar.11 → 1.2.0-lystar.1` |
| 更换 Pi major 基线 | `1.1.0-lystar.11 → 2.0.0-lystar.1` |
| 指定的 Pi 基线已经发布过 | 若最新正式版为 `2.0.0-lystar.3`，继续发布 `2.0.0-lystar.4`；当前已准备的修订号更高时，以较高修订号继续加一 |
| 新基线的 `.1` 已打 Tag，但 CI 失败 | 修复后从已占用的修订号继续加一，例如发布 `2.0.0-lystar.2`，不复用 `.1` |

上表的新基线首版示例假设该基线尚未占用 LYStar 产品 Tag。脚本同时查询本地和 `origin` 的已有产品 Tag，跳过已经占用的修订号，即使对应 Release 尚未公开或 CI 失败也不复用。

上游合并时保留 LYStar 的 `piConfig`，包版本可以暂时是上游裸版本。产品版本可保留上一正式版，也可已准备成新基线的 `.1`；没有已占用 Tag 时，脚本不会因提前准备而把首版跳成 `.2`。它统一 workspace 与示例锁文件的版本，同步 README 的 Pi 基线和 commit、建设方案与验证记录，并保留已经写好的兼容矩阵新行。新 Tag 早于当前产品或最新正式版基线时停止。

指定上游 Tag 的预览需要联网读取 GitHub latest 与 `origin` 的产品 Tag；普通 `--dry-run` 仍只读取本地文件。`--upstream-tag` 只能与发布或预览使用，不能与 `--resume`、`--verify` 混用。版本准备后续跑时只传 `--resume`，继续已准备的 LYStar 版本。

若默认 `gh` 版本较旧，可指定已安装的新版 CLI：

```bash
npm run release:lystar -- --gh /path/to/gh
```

版本准备后中断时，不要再次运行默认递增命令。若发布前检查失败，修复问题并提交当前版本改动，再续跑；若 Tag 已推送，续跑直接等待工作流并核验资产，不递增版本或移动 Tag：

```bash
npm run release:lystar -- --resume
```

单独核验某个已发布版本：

```bash
npm run release:lystar -- --verify 1.1.0-lystar.11
```

`--verify` 可在有未提交改动的工作区运行；它获取 Tag 并验证当前平台公开归档与公共清单，不修改版本文件、不提交或推送。需要下载并校验五平台归档时使用：

```bash
npm run release:lystar -- --verify 1.3.0-lystar.2 --all-platforms
```

`--all-platforms` 仅与 `--verify` 配合使用。两种模式均核对十个公开资产、五平台 manifest 与 SHA 清单、公开归档大小和三个安装器；归档内容的 SHA 校验范围分别为当前平台或全部五平台。安装器内容以目标 Tag 为准，元数据校验器使用当前工作区的实现。验证目录在命令输出中保留，便于查看下载资产。CI 的断言或行为失败需要修复后递增新修订号；`--resume` 不自动重跑失败工作流。

本入口只发布 LYStar GitHub Release，不执行上游 npm 发布；`release:patch/minor/major` 继续用于上游 npm 流程。

## CI 构建与候选验证

Release workflow 同时启动一次公共 JavaScript/Web 构建和五平台原生准备。各平台安装打包依赖、构建或恢复 Go 会话索引后，下载同一 workflow attempt 的公共归档，再生成本平台独立包。共享归档不包含原生索引；最终可执行文件继续在对应原生 runner 构建。

npm 下载缓存按外部依赖生成指纹，workspace 版本递增不会使缓存失效。原生索引缓存同时区分系统、架构、Go 版本、源码和构建脚本；命中时不再准备 Go 工具链。Environments 的测试任务只安装 env、durable 及其依赖和根工具。

只构建候选、不创建 Tag 或公开 Release：

```bash
gh workflow run release.yml --repo lystar-team/lystar-code --ref main -f ref=main -f publish=false
```

没有 workflow dispatch 权限时，可将待验证提交推送到 `release-ci/` 前缀分支。该前缀的 push 仅生成候选；只有产品 Tag push 或明确的 `publish=true` 才发布。候选归档与清单保存在本次 run 的 `release-candidate-verified-<attempt>` Artifact，可通过 `gh run rerun <run-id> --repo lystar-team/lystar-code` 比较同一提交的暖缓存耗时。

## 发布前

1. 工作区干净，目标提交已推送到 `origin/main`。
2. CI 通过。
3. `productVersion`、README、兼容矩阵和验证记录一致。
4. 完成本次功能改动所需的[验证](verification.md)。
5. Darwin ARM64/x64、Linux ARM64/x64 和 Windows x64 分别在对应原生 runner 构建。

```bash
bash scripts/build-binaries.sh --offline-model-data
```

该命令只构建当前原生平台；也可显式传入与当前主机一致的 `--platform darwin-arm64|darwin-x64|linux-arm64|linux-x64`。GitHub Release workflow 使用 `macos-15`、`macos-15-intel`、`ubuntu-24.04-arm` 和 `ubuntu-24.04` 分别构建四个 Unix 归档。每个归档必须包含可执行的 `lc`、`lystar`、资源文件和 manifest。

Windows x64 必须在安装了 MSVC Build Tools 的 Windows 主机执行：

```powershell
npm ci --ignore-scripts
npm run build:offline
.\scripts\build-windows-release.ps1 -Repository lystar-team/lystar-code
.\scripts\test-windows-terminal.ps1 -BundleDir .\packages\coding-agent\binaries\windows-x64\lystar-agent
```

两个 runner 的归档合并后再运行 `generate-release-metadata.mjs` 生成 SHA、manifest 和安装器。归档 SHA 是发布资产的完整性事实源。Ubuntu 不允许交叉编译 macOS、Linux ARM64 或 `lc.exe`；Bun 的 `--windows-icon` 也只在 Windows 构建进程中生效。

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

- `lc.exe`、`lystar.cmd` 和 `lystar-terminal.exe` 都存在，启动器与 CLI 位于同一目录。
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
gh run list --repo lystar-team/lystar-code --workflow release.yml --limit 5
gh release view <tag> --repo lystar-team/lystar-code --json url,assets,isDraft,isPrerelease
```

确认：

- CI 和 Release workflow 成功。
- Release 公开且不是 draft/prerelease。
- 五平台包、三个安装器、`SHA256SUMS` 和 manifest 共 10 个公开资产。
- 下载的 manifest 与 SHA 正确。
- 当前平台资产存在 provenance attestation。

## 失败处理

已推送 tag 不移动、不强推、不覆盖历史资产。可复现的源码、测试或构建问题修复后发布新的 LYStar 修订号。网络和偶发资源超时只有在确认没有断言与行为失败后才重跑 job。
