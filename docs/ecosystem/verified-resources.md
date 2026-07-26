# 已验证资源

[返回文档首页](../README.md)

这里仅记录在隔离配置目录中完成源码检查、安装、真实 TTY 加载和卸载验证的第三方资源。第三方资源不由 LYStar 项目维护，验证结论只覆盖表中版本、平台和测试日期。

## `@tintinweb/pi-tasks@0.7.2`

- 类型：Pi Package / Extension
- 来源：[`tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks)
- 锁定版本：npm `0.7.2`；对应仓库 tag `v0.7.2`、commit `03a13011eb7bfb63d6d348959fe738ab7365ea75`
- 许可证：MIT
- LYStar 验证版本：`0.82.1-lystar.3`
- 验证平台：Linux x64
- 测试日期：2026-07-26
- 前置条件：Node.js/npm 用于安装 Package

安装：

```bash
la install npm:@tintinweb/pi-tasks@0.7.2
```

该 Extension 注册任务创建、查询、更新、输出、停止和执行 Tool，并显示任务 Widget。默认把任务写入项目 `.pi/tasks/`，设置写入 `.pi/tasks-config.json`；可选的 subagent 执行依赖另一个 Extension。

配置与验证：

```text
/tasks
```

应看到 `View all tasks`、`Create task` 和 `Settings`。也可以运行：

```bash
la list
```

应显示 `npm:@tintinweb/pi-tasks@0.7.2`。本次还执行了上游 8 个测试文件、191 项测试，全部通过。

更新：当前命令锁定 `0.7.2`，`la update --extensions` 不会移动到新版本。确认上游新版本后重新安装明确版本：

```bash
la install npm:@tintinweb/pi-tasks@<new-version>
```

卸载：

```bash
la remove npm:@tintinweb/pi-tasks
```

卸载不会自动删除项目 `.pi/tasks/`、`.pi/tasks-config.json` 或全局 `~/.pi/agent/tasks-config.json`。

已知限制：

- 上游标记为 early release。
- Extension 的 Tool 名、菜单和提示目前主要为英文。
- macOS、Windows 尚未做 LYStar 实机核验。
- 任务执行 subagent 的路径没有纳入本次验证。

## `badlogic/pi-skills` commit `90bb51c`

- 类型：Skill 集合
- 来源：[`badlogic/pi-skills`](https://github.com/badlogic/pi-skills)
- 锁定 commit：`90bb51cae36515a648515b633a81c0c6efc8c74d`
- 许可证：MIT
- LYStar 验证版本：`0.82.1-lystar.3`
- 验证平台：Linux x64，Skill 发现与补全
- 测试日期：2026-07-26
- 前置条件：Git；各 Skill 有独立依赖

安装到用户目录：

```bash
mkdir -p ~/.pi/agent/skills
git clone https://github.com/badlogic/pi-skills ~/.pi/agent/skills/pi-skills
git -C ~/.pi/agent/skills/pi-skills checkout 90bb51cae36515a648515b633a81c0c6efc8c74d
```

安装后执行 `/reload`，输入：

```text
/skill:
```

本次确认 LYStar 发现 8 个 Skill：`brave-search`、`browser-tools`、`gccli`、`gdcli`、`gmcli`、`transcribe`、`vscode`、`youtube-transcript`。

依赖边界：

- `brave-search`、`browser-tools`、`youtube-transcript` 需要 Node.js 和各目录 npm 依赖。
- `gccli`、`gdcli`、`gmcli` 需要对应全局 CLI 和 Google OAuth 配置。
- `browser-tools` 还需要 Chrome。
- `transcribe` 当前面向 Apple Silicon macOS，并需要对应音频工具。
- `vscode` 需要 VS Code 的 `code` 命令。

集合被发现不代表上述外部服务和 CLI 都已完成端到端验证。使用某个 Skill 前阅读其 `SKILL.md`。

更新到经过审查的新 commit：

```bash
git -C ~/.pi/agent/skills/pi-skills fetch origin
git -C ~/.pi/agent/skills/pi-skills checkout <new-commit>
```

卸载：

```bash
rm -rf ~/.pi/agent/skills/pi-skills
```

执行删除命令前确认路径。

## 未通过：`pi-sandbox@0.6.1`

- 来源：[`carderne/pi-sandbox`](https://github.com/carderne/pi-sandbox)
- 许可证：MIT
- 测试平台：Linux x64
- 结果：Package 安装和 Extension 加载成功，Sandbox 初始化失败。
- 错误：`Sandbox dependencies not available: socat not installed`

上游 README 当前把 `rg` 列为前置条件，但本次运行还要求 `socat`。Sandbox 没有实际启用，因此本版本暂不进入推荐安装清单。重新验证至少需要：

1. 在隔离 Linux 环境安装 `rg`、`socat` 和 `bubblewrap`。
2. 验证文件读写、网络域名、Bash 限制和交互授权。
3. 验证 Extension 退出后清理 sandbox runtime。
4. 在 macOS 单独验证 `sandbox-exec` 路径。

未经这些验证，不使用“已适配 LYStar”描述。
