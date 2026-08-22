# LYStar Code 验证记录

> 更新日期：2026-08-22
>
> 本文件只记录当前 TypeScript TUI、GUI Host、GUI Protocol、GUI 和发行链路的验证。历史原生终端实验记录已移除，不作为当前实现证据。

## 当前事实

- 正式 CLI 入口是 `packages/coding-agent/src/main.ts`，使用 TypeScript Interactive TUI。
- GUI 继续使用 `packages/gui-protocol`、`packages/gui-host`、Transcript 分页、Session lease、operation journal、content reference 和标准 `ui_request`/`ui_response`。
- 发行包只构建 `lc` 与 `lystar`，不包含额外终端前端可执行文件。
- `packages/gui/src-tauri` 是 GUI 桌面壳自己的 Rust 工程，不属于终端前端清理范围。

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
