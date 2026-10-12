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

`origin` 应为 `lystar-team/lystar-code`，`upstream` 只跟踪 Pi。

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

- 合并时保留 LYStar `piConfig` 与 `releaseRepository=lystar-team/lystar-code`。workspace 包可暂时采用新 Pi Tag 的裸版本；不用手工将所有包改成 LYStar 版本。
- 在各包 `[Unreleased]` 记录上游变化与 LYStar 适配结果，更新 Session、Extension API 等实际兼容说明。需要新测试或改写测试时先遵循项目的测试编写授权。
- 提交合并与适配结果，回到干净的 `main` 后，使用一键发布入口指定实际已合入的 Tag。下方 `v2.0.0` 是示例：

```bash
npm run release:lystar -- --upstream-tag v2.0.0 --dry-run
npm run release:lystar -- --upstream-tag v2.0.0
```

脚本校验 Tag 对应的 Pi 包版本与 commit 已合入 `HEAD`，读取 LYStar 最新正式版及本地/远端产品 Tag 后选择修订号：更换 Pi 基线且尚无产品 Tag 时从 `<新 Pi 版本>-lystar.1` 开始；同一基线已有产品 Tag 则继续递增，CI 失败的修订号也不复用。patch、minor、major 的 Pi Tag 变化都按更换基线处理。`piConfig.productVersion` 若提前设为新基线 `.1` 且尚未打产品 Tag，首版仍发布 `.1`。脚本同步包版本、锁文件、README、建设方案、Pi commit 与验证记录，不覆盖已经写好的兼容矩阵新行。

发布中断后使用 `npm run release:lystar -- --resume`，去掉 `--upstream-tag`，避免再次选择版本。完整参数、GitHub CLI 要求、公开资产与升级检查见[发行](release.md)。合并与功能验证仍需按对应改动范围执行。

- 检查依赖许可证和发行资产。

## 验证

运行全部包测试、安装器测试、离线构建、五平台打包和真实 PTY。还要确认旧 `~/.pi/agent/settings.json`、Session 和项目 `.pi` 可读取，`lc -c`、`lc -r`、Package、Skill、Extension 和 MCP adapter 行为未变。

上游合并提交与 LYStar 适配提交分开：

```text
chore(upstream): 合并 Pi vX.Y.Z
fix(tui): 适配 Pi vX.Y.Z 全屏布局
fix(agent): 补齐 Pi vX.Y.Z 中文与兼容
```

完整长期边界见[LYStar Code 建设方案](../lystar-agent-plan.md)。
