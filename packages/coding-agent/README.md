# LYStar Code

LYStar Code 是基于 Pi `v0.84.1` 的中文编码 Agent。最终用户命令为 `lc` 和 `lystar`，两者完全等价；继续保留 Pi Runtime、Session、Skill、Extension、Package、MCP、`.pi` 数据和 `PI_*` 环境变量兼容。

## 使用

```bash
lc
lc --help
lc auth --help
lc update
lc update --rollback
lystar --version
```

常规终端默认进入全屏 TUI。使用 `Shift+PageUp/PageDown` 或鼠标滚轮滚动对话，`Ctrl+Home/End` 跳到首尾。Zellij、tmux control mode、非 TTY 和 `TERM=dumb` 默认回退 inline；可用 `--alt-screen auto|always|never` 覆盖。

LYStar UI 偏好保存在 `~/.pi/agent/lystar.json`。Pi 的设置、会话、Skill、Extension、Package、Theme 和 Prompt Template 继续保存在原位置。不要让 Pi 和 LYStar 同时写同一个 Session 文件。

## 构建

在 monorepo 根目录执行：

```bash
npm ci --ignore-scripts
npm run build:offline
bash scripts/build-binaries.sh --offline-model-data
```

发行仓库固定为 `octyean/lystar-agent`。构建脚本会把该地址写入安装器、manifest 和发行包，供安装与更新使用。

LYStar Code 当前基于 `earendil-works/pi` `v0.84.1`，上游 commit 为 `53fa77ccd8a279eb87e92294ef3687b03ff80112`，按 MIT License 发行。Grok Build 仅作为全屏 TUI 交互参考，没有复制其源码或资产。
