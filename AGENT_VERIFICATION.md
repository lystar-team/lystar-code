# AGENT_VERIFICATION

最后核验时间：2026-07-25T15:09:54+08:00

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

结果：179 个 test files 通过、6 个跳过；1621 项测试通过、48 项跳过。

TUI 全量测试：

```bash
npm --workspace @earendil-works/pi-tui test
```

结果：退出码 0。包含 alternate screen、SGR mouse 和 reduceMotion 新增回归。

Agent Core 排除已知上游长输出基线后的回归：

```bash
npm --workspace @earendil-works/pi-agent-core test -- --exclude test/harness/tools.test.ts
```

结果：17 个 test files、217 项测试通过，1 项跳过。

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

结果：macOS ARM64/x64、Linux ARM64/x64、Windows x64 五个压缩包全部校验通过。`release-manifest.json`、两个安装器和五个平台包内的 `piConfig.releaseRepository` 均固定为 `octyean/lystar-agent`。Linux x64 包已实机运行 `la --version`、`la --help` 和 `PI_OFFLINE=1 la --list-models`。

真实 PTY 使用独立 tmux socket 和临时 HOME 验证：

- 120x36 首次启动显示中文主题选择。
- 120x36 主界面显示固定顶栏、独立对话区、输入区、快捷栏和 footer。
- `/settings` 显示中文设置项。
- resize 到 80x24 后布局仍保持 24 行，无控件重叠或进程退出。
- `/quit` 正常退出；本轮 tmux socket 已关闭并删除。

## 发行产物

目录：`packages/coding-agent/binaries/`

```text
lystar-agent-v0.82.0-lystar.1-darwin-arm64.tar.gz   29M
lystar-agent-v0.82.0-lystar.1-darwin-x64.tar.gz     31M
lystar-agent-v0.82.0-lystar.1-linux-arm64.tar.gz    44M
lystar-agent-v0.82.0-lystar.1-linux-x64.tar.gz      45M
lystar-agent-v0.82.0-lystar.1-windows-x64.zip       47M
```

同时生成 `SHA256SUMS`、`release-manifest.json`、`install.sh`、`install.ps1` 和 `VERSION`。

## 已知上游基线

```bash
npm test
```

除 `packages/agent/test/harness/tools.test.ts` 的长输出测试外，其余工作区通过。该上游测试在当前机器写出的完整输出止于 `line-2236`，断言要求包含 `line-2999\nline-3000`；这是导入 Pi `v0.82.0` 时已确认的本机基线问题，LYStar Coding Agent 与 TUI 测试不受影响。未修改测试或生产逻辑规避它。

依赖安装仍报告 3 个上游 high severity audit 告警，以及 `@earendil-works/gondolin@0.12.0` 要求 Node.js `>=23.6.0` 的 engine 警告。本轮没有越过 Pi `v0.82.0` 基线擅自升级依赖。
