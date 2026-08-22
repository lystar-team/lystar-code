# 测试与验证

[返回文档首页](../README.md)

先读根目录 [AGENT_VERIFICATION.md](../../AGENT_VERIFICATION.md)，里面记录当前环境已经实际跑通的命令和已知限制。

## 基础 gate

代码修改完成后：

```bash
npm run check
npm run build:offline
```

`npm run check` 包含格式、依赖固定、TypeScript import、锁文件、类型和浏览器 smoke 检查。

## 安装器

```bash
bash scripts/test-install-sh.sh
```

Unix 测试使用本地假 Release 覆盖 curl、wget、PATH、校验失败、回退、卸载和用户数据保留，不访问网络。

Windows PowerShell 5.1：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-install-ps1.ps1
```

Windows 测试检查 UTF-8 BOM、PowerShell 5.1 parser、Bash 前置和下载重试入口。最终安装行为仍需 Windows 实机。

## 包测试

```bash
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
```

局部修改先跑目标测试文件，例如：

```bash
cd packages/coding-agent
npx vitest --run test/package-command-paths.test.ts
```

## PTY

可见 TUI 修改必须在真实 PTY 验证。每次使用独立 tmux socket，结束后只关闭本轮会话：

```bash
SOCKET=lystar-task-name
tmux -L "$SOCKET" new-session -d -s tui -x 80 -y 24 \
  'PI_OFFLINE=1 node packages/coding-agent/dist/cli.js --approve'
tmux -L "$SOCKET" capture-pane -p -t tui -S -24
tmux -L "$SOCKET" send-keys -t tui '/quit' Enter
tmux -L "$SOCKET" kill-server
```

按风险覆盖 80x24、80x8、120x36、流式回复、Tool 展开、`/settings`、resize 和退出恢复。

## 发行包

```bash
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
cd packages/coding-agent/binaries
sha256sum -c SHA256SUMS
```

Unix 脚本只构建当前原生平台，传入其他平台会直接失败，跨平台发行由 Release workflow 的原生 runner 矩阵完成。

Linux x64 包至少运行：

```bash
tar -xzf lystar-agent-v<version>-linux-x64.tar.gz
./lystar-agent/lc --version
./lystar-agent/lc --help
PI_OFFLINE=1 ./lystar-agent/lc --list-models
```

## 证据边界

- 构建通过只能证明构建入口成功。
- 单元测试只覆盖对应逻辑。
- 脚本解析不能替代 Windows/macOS 实机。
- 归档格式和 executable 架构不能替代真实启动。
- 发布前必须记录实际命令、结果、平台和未验证范围。

当前 Pi 基线的依赖告警和 Node engine 差异见 `AGENT_VERIFICATION.md`，不要通过跳过 gate 或随意升级依赖隐藏。
