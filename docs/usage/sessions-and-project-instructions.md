# Session 与项目规则

[返回文档首页](../README.md)

LYStar 自动保存 Session，并继续使用 Pi 的 JSONL 格式和目录。

## Session 命令

```bash
la -c
la -r
la --name "任务名称"
la --session <path-or-id>
la --no-session
```

| 命令 | 用途 |
|---|---|
| `la -c` | 继续当前目录最近的 Session |
| `la -r` | 浏览历史 Session |
| `/resume` | 在交互界面选择 Session |
| `/new` | 新建 Session |
| `/session` | 查看当前文件、ID 和用量 |
| `/tree` | 在 Session 树中跳转 |
| `/fork` | 从历史用户消息创建分支 Session |
| `/clone` | 复制当前分支到新 Session 文件 |
| `/compact` | 压缩较早上下文 |
| `/export <file>` | 导出 HTML 或 JSONL |

默认数据位于 `~/.pi/agent/sessions/`，按工作目录组织。自定义目录可使用 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR` 或 `settings.json` 的 `sessionDir`。

Pi 与 LYStar 可以读取同一目录，但不要让两个进程同时写同一个 Session。需要并行处理任务时分别创建 Session。

## 项目规则

LYStar 启动时从当前目录向上读取 `AGENTS.md` 或 `CLAUDE.md`，并读取全局 `~/.pi/agent/AGENTS.md`。

项目根目录示例：

```markdown
# 项目规则

- 修改代码前先读调用者和测试。
- 修改后运行 npm test。
- 不执行生产迁移。
- 不提交 .env、token 和用户数据。
```

更新规则后执行 `/reload`。使用 `--no-context-files` 或 `-nc` 可临时禁用上下文文件。

## 项目信任

项目包含 `.pi/settings.json`、项目 Extension、Package 或 `.agents/skills` 时，交互模式会询问是否信任。信任意味着允许加载项目配置、安装缺失 Package 并执行项目 Extension。

- 只信任来源明确且已经阅读的项目。
- `/trust` 保存当前项目或父目录的决定。
- `--approve` 仅覆盖本次运行。
- `--no-approve` 忽略本次运行的项目资源。
- 非交互模式不会弹出询问，默认按全局 `defaultProjectTrust` 处理。

信任记录位于 `~/.pi/agent/trust.json`。修改后重新启动当前 Session 才会完整重载项目资源。

## 数据备份

升级和卸载不会删除 `~/.pi/agent`。需要完整迁移时备份：

```text
~/.pi/agent/auth.json
~/.pi/agent/settings.json
~/.pi/agent/sessions/
~/.pi/agent/extensions/
~/.pi/agent/skills/
```

`auth.json` 包含凭据，不要上传到公共网盘或 Git 仓库。

完整 Session 格式见 [Pi Session Format](../../packages/coding-agent/docs/session-format.md)。
