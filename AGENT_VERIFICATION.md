# LYStar Code 验证记录

> 更新日期：2026-09-01
>
> 本文件只记录当前 TypeScript TUI、GUI Host、GUI Protocol、GUI 和发行链路的验证。历史原生终端实验记录已移除，不作为当前实现证据。

## 当前事实

- 正式 CLI 入口是 `packages/coding-agent/src/main.ts`，使用 TypeScript Interactive TUI。
- GUI 继续使用 `packages/gui-protocol`、`packages/gui-host`、Transcript 分页、Session lease、operation journal、content reference 和标准 `ui_request`/`ui_response`。
- 发行包只构建 `lc` 与 `lystar`，不包含额外终端前端可执行文件。
- 上游 Pi 基线已同步到 `v0.84.4`，commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`；LYStar 产品版本为 `0.84.4-lystar.1`。

## 本轮发版前定向验证（2026-09-01）

本轮修复工作区的类型、格式、Agent Tool 冲突、GUI companion、全屏工作台、Markdown 和鼠标 Overlay 相关回归，实际运行：

```bash
npx tsgo --noEmit --pretty false
npx biome check --error-on-warnings --files-ignore-unknown=true .
npm run test:scripts
npm --workspace @earendil-works/pi-agent-core exec vitest -- --run test/agent-loop.test.ts test/harness/tools.test.ts --maxWorkers=2 --pool=forks
npm --workspace @earendil-works/pi-coding-agent exec vitest -- --run test/gui-companion.test.ts test/interactive-gui-companion.test.ts test/apply-patch-extension.test.ts test/assistant-message.test.ts test/edit-tool-no-full-redraw.test.ts test/file-mutation-queue.test.ts test/interactive-tui.test.ts test/lystar-tui.test.ts test/lystar-workspace.test.ts test/subagent-session-view.test.ts test/system-prompt.test.ts test/task-workbench-components.test.ts test/tool-execution-component.test.ts test/tool-recovery.test.ts test/tool-system-prompt-contributions.test.ts --maxWorkers=2 --pool=forks
npm --workspace @earendil-works/pi-coding-agent run build:unbundled
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=2 --reporter=json --outputFile=/tmp/coding-local.json
cd packages/tui && node --test test/markdown.test.ts test/tui-alt-screen.test.ts
node scripts/lcd.mjs --version
```

结果：TypeScript 检查、Biome 检查、脚本测试（33 项）、Agent 定向测试（2 个文件、71 项）、Coding Agent 定向测试（15 个文件、234 项）、Coding Agent unbundled build、Coding Agent 完整测试（263 个文件、2323 项，其中 2322 项通过、1 项按平台跳过）、TUI 定向测试（138 项）和源码快捷入口版本检查均通过，返回 `0.84.4-lystar.1`。本节未替代完整 CI、离线构建、PTY、多平台实机和发行包安装验证。

## Pi v0.84.4 合并验证（2026-08-31）

本轮在当前工作区完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm exec -- vitest --run --maxWorkers=1 \
  packages/agent/test/harness/nodejs-env.test.ts \
  packages/coding-agent/test/config.test.ts \
  packages/coding-agent/test/model-resolver.test.ts \
  packages/coding-agent/test/suite/agent-session-model-extension.test.ts \
  packages/coding-agent/test/interactive-tui.test.ts \
  packages/coding-agent/test/session-id-readonly.test.ts \
  packages/ai/test/model-catalog-types.test.ts \
  packages/ai/test/xai-responses.test.ts \
  packages/ai/test/zai-coding-plan-models.test.ts
cd packages/tui && node --test test/tui-render.test.ts
```

结果：静态检查、离线构建、定向 Vitest（9 个文件、149 项）和 TUI 渲染测试（29 项）通过。未在本轮验证真实 Provider、PTY、多平台实机、Tauri 和发行包安装运行。


## Tool Recovery 验证

当前恢复经验链路包含 candidate 自动验证、显式 active 批准、Session ledger 重放、账本游标幂等、history checkpoint 归档，以及代码侧注册的 `safe_refresh` handler。当前实际运行的定向验证为：

```bash
cd packages/coding-agent
npx vitest --run test/tool-recovery.test.ts test/lessons-store.test.ts \
  test/file-mutation-queue.test.ts test/apply-patch-extension.test.ts \
  --maxWorkers=2 --pool=forks
# 4 个测试文件，78 项通过

cd ../agent
npx vitest --run test/agent-loop.test.ts --maxWorkers=2 --pool=forks
# 1 个测试文件，41 项通过
```

本轮只增加三个有明确契约价值的运行链路 E2E：`custom safe_refresh` handler、真实 `apply_patch` 重建，以及由独立 Node 进程执行两次的 Session ledger reconcile 幂等。它们分别覆盖自定义 handler 的 active 门槛、补丁失败到重建成功的关联、以及进程重启后的补偿重放；未扩展为全 Tool、全 Provider 或全 Session 的 E2E 矩阵。

已通过 `npx tsgo -p packages/coding-agent/tsconfig.build.json --pretty false`、根目录 `tsgo --noEmit`、`npm run check --silent` 和 `git diff --check --no-ext-diff`。跨进程真实进程重启、真实 Provider、Windows、macOS、Tauri 和发行包实机运行仍未在本轮验证。

## 验证入口

依赖安装：

```bash
npm ci --ignore-scripts
```

局部测试：

```bash
npm --workspace @lystar/code-gui-protocol test
npm --workspace @lystar/code-gui-host run test:required
npm --workspace @lystar/code-gui test
npm --workspace @earendil-works/pi-coding-agent test -- test/doctor-command.test.ts
```

静态检查与构建：

```bash
npm run check:schema
npm run check
npm run build:offline
npm run test:scripts
```

发行链路：

```bash
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

## 终端验证

可见 TypeScript TUI 修改需要使用独立 tmux socket 覆盖至少以下尺寸：

- `80x24`
- 极小高度，例如 `80x8`
- `120x36`
- 流式回复、完成后状态、`/settings`、overlay、Tool/Diff 展开、resize 和退出恢复

验证结束后只关闭本轮创建的 tmux session，并检查 `git diff --check`。没有真实 Provider、Windows、macOS、Tauri 或远端 Host 实机证据时，不把本地构建结果写成跨平台运行通过。

## GUI 验证

GUI 修改需要覆盖：

- 浏览器 smoke、Transcript 首屏和分页搜索。
- Session 创建、切换、释放、恢复、abort 和断线重连。
- operation journal 的重复请求、响应丢失和 payload 冲突。
- 标准 Extension `ui_request`/`ui_response`。
- Tauri 窗口关闭、Host 清理、桌面状态恢复和当前平台安装包启动。

## 结果记录规则

只记录本轮实际运行的命令、测试数量和平台。历史文档、旧 release artifact、未运行的 CI job 和其他机器结果必须明确标为未验证，不能代替当前证据。
