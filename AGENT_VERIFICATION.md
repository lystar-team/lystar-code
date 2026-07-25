# AGENT_VERIFICATION

最后核验时间：2026-07-25T22:33:30+08:00

环境：

```text
Node.js v22.21.1
npm 11.11.0
Bun 1.3.9
Linux x64
```

## 已通过

静态检查与离线构建：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
```

Coding Agent 全量测试：

```bash
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
```

结果：182 个 test files 通过、6 个跳过；1649 项测试通过、48 项跳过。

TUI 全量测试：

```bash
npm --workspace @earendil-works/pi-tui test
```

结果：退出码 0。包含 alternate screen、SGR mouse 和 reduceMotion 新增回归。

AI 全量测试：

```bash
npm --workspace @earendil-works/pi-ai test
```

结果：89 个 test files 通过、25 个跳过；667 项测试通过、783 项跳过。

Agent Core 全量回归：

```bash
npm --workspace @earendil-works/pi-agent-core test
```

结果：18 个 test files、240 项测试通过，1 项跳过。Pi `v0.82.0` 基线中的长输出失败已由 `v0.82.1` 修复，不再排除 `test/harness/tools.test.ts`。

Unix 安装器回退、卸载和用户数据保留：

```bash
bash scripts/test-install-sh.sh
```

结果：`install.sh rollback/uninstall checks passed`。

五平台独立发行包：

```bash
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
cd packages/coding-agent/binaries
sha256sum -c SHA256SUMS
```

结果：`0.82.1-lystar.1` 的 macOS ARM64/x64、Linux ARM64/x64、Windows x64 五个压缩包全部校验通过。`release-manifest.json`、两个安装器和五个平台包内的 `piConfig.releaseRepository` 均固定为 `octyean/lystar-agent`。Linux x64 包已实机运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models`。

真实 PTY 使用独立 tmux socket 和临时工作目录验证：

- 120x36 首次启动显示中文主题选择。
- 120x36 主界面显示固定顶栏、独立对话区、输入区和快捷栏。
- 顶栏和输入框下方恢复工作目录、上下文百分比、token 用量、模型、双语思考强度和 Extension 状态。
- 使用包含 7 次压缩的真实 Session 快照验证 Footer 显示 `↑4.9M ↓516k R242M CH98.7%`；设置会话名后同步显示在工作目录行。
- Footer 回归确认普通回复与压缩 entry 的 `↑/↓/R/W` 累加，正数写缓存显示为 `W80`；值为 0 时不显示该项。
- 三行输入时 `❯` 位于中间行；单行和多行输入都保持稳定边框。
- `high` 显示为 `高(high)`；默认展开模型返回的思考过程正文，用户仍可主动折叠。
- 80x24 下连续执行 Bash、创建、编辑和读取操作，成功结果各占一行；点击目标摘要后仅展开该条完整输出。
- 58x20 移动端宽度下，20 行 Shell 输出默认保持一行摘要，输入区、Footer 和 `Esc 取消` 快捷提示保持可见。
- Markdown 代码围栏默认隐藏，长代码行换行后每行保留左侧 `│`；`/settings` 可搜索并切换“Markdown 代码围栏”。
- 80x8 下叠加 10 行 Extension Widget，输入框与快捷栏仍保留最后 4 行，附加状态只使用剩余空间。
- `/settings` 显示中文设置名、中文枚举值、Markdown 围栏开关和明确的搜索提示。
- `/session`、`/hotkeys`、分支、压缩、登录、Shell 状态和常见错误使用中文界面文案。
- resize 后布局保持终端总行数，无控件重叠或进程退出。
- `/quit` 正常退出；本轮 tmux socket 已关闭并删除。

## 发行产物

目录：`packages/coding-agent/binaries/`

```text
lystar-agent-v<version>-darwin-arm64.tar.gz
lystar-agent-v<version>-darwin-x64.tar.gz
lystar-agent-v<version>-linux-arm64.tar.gz
lystar-agent-v<version>-linux-x64.tar.gz
lystar-agent-v<version>-windows-x64.zip
```

同时生成 `SHA256SUMS`、`release-manifest.json`、`install.sh`、`install.ps1` 和 `VERSION`。

## 已知限制

完整 `npm test` 已通过，包含 scripts、Agent Core、AI、Coding Agent 和 TUI 全量测试。

`npm audit --audit-level=high` 仍报告 3 个上游 high severity 告警：`brace-expansion`、`postcss` 和 `shell-quote`。`@earendil-works/gondolin@0.12.0` 仍要求 Node.js `>=23.6.0`，当前验证环境为 Node.js 22；本轮没有脱离 Pi `v0.82.1` 依赖基线单独执行 `npm audit fix`。
