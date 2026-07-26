# 同步 Pi 上游

[返回文档首页](../README.md)

LYStar 通过 Git merge 持续跟随 Pi，上游固定为 `https://github.com/earendil-works/pi.git`。已有 ancestry bridge，不再使用 `--allow-unrelated-histories`。

## 获取上游

```bash
git remote get-url origin
git remote get-url upstream
git fetch upstream --tags --prune
git show --no-patch --decorate <pi-tag>
```

`origin` 应为 `octyean/lystar-agent`，`upstream` 只跟踪 Pi。

## 升级前检查

比较：

- Extension API 和事件。
- Session entry、JSONL 与 Tool result。
- CLI 参数、退出码和环境变量。
- Package、Skill、Theme、Prompt Template。
- Provider 和模型目录。
- TUI renderer、组件、keybinding、终端清理。
- `packages/coding-agent/examples/extensions/subagent/` 的上游变化。内建版位于 `packages/coding-agent/src/extensions/subagent/`，每次升级都要同步比较。

```bash
git log --oneline <old-pi-commit>..<new-pi-commit>
git diff --stat <old-pi-commit>..<new-pi-commit>
git diff <old-pi-commit>..<new-pi-commit> -- packages/tui packages/coding-agent
```

## 合并

```bash
git switch -c merge/pi-vX.Y.Z
git merge --no-commit --no-ff <new-pi-commit>
```

冲突处理：

- Provider、Session、Tool、Extension、Skill、Package 和基础 TUI 逻辑采用上游新实现。
- 产品常量、中文 locale、LYStar workspace、更新器、安装器和 Release workflow保留 LYStar 契约。
- 上游已有等价能力时删除 LYStar 重复实现。
- subagent 采用上游示例的新行为，同时保留内建 Agent 覆盖顺序、子进程禁用递归 subagent、跨平台进程树终止和输出上限。
- 逐块判断冲突，不整文件选择 ours/theirs。

## 版本与文档

- workspace package 版本跟随 Pi tag。
- `piConfig.productVersion` 设为 `<新 Pi 版本>-lystar.1`。
- `releaseRepository` 保持 `octyean/lystar-agent`。
- 更新 README、建设方案和兼容矩阵。
- Session 或 Extension API 变化时增加兼容 fixture 和迁移说明。
- 检查依赖许可证和发行资产。

## 验证

运行全部包测试、安装器测试、离线构建、五平台打包和真实 PTY。还要确认旧 `~/.pi/agent/settings.json`、Session 和项目 `.pi` 可读取，`la -c`、`la -r`、Package、Skill、Extension 和 MCP adapter 行为未变。

上游合并提交与 LYStar 适配提交分开：

```text
chore(upstream): 合并 Pi vX.Y.Z
fix(tui): 适配 Pi vX.Y.Z 全屏布局
fix(agent): 补齐 Pi vX.Y.Z 中文与兼容
```

完整长期边界见[LYStar Agent 建设方案](../lystar-agent-plan.md)。
