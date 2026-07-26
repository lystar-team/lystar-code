# 配置

[返回文档首页](../README.md)

LYStar 继续使用 Pi 配置目录：

| 文件 | 作用 |
|---|---|
| `~/.pi/agent/settings.json` | 全局设置 |
| `.pi/settings.json` | 当前项目设置，需信任项目 |
| `~/.pi/agent/lystar.json` | LYStar 全屏、鼠标和动效偏好 |
| `~/.pi/agent/keybindings.json` | 快捷键 |
| `~/.pi/agent/auth.json` | OAuth 与 API Key |
| `~/.pi/agent/models.json` | 自定义 Provider 和模型 |

项目设置覆盖全局设置，嵌套对象按字段合并。常用选项优先在 `/settings` 中修改。

## 常用设置

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "<model-id>",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "defaultProjectTrust": "ask",
  "httpProxy": "http://127.0.0.1:7890",
  "markdown": {
    "showCodeBlockFences": false
  }
}
```

模型 ID 先通过 `la --list-models` 确认。不要照抄示例中的占位符。

## LYStar UI

```json
{
  "altScreen": "auto",
  "mouse": true,
  "reduceMotion": false
}
```

允许值：

- `altScreen`：`auto`、`always`、`never`
- `mouse`：布尔值
- `reduceMotion`：布尔值

CLI 参数只覆盖当前运行，优先于 `lystar.json`。

## 网络

`settings.json` 可设置全局 HTTP 代理：

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

已有 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量时不会被覆盖。详细场景见[中国大陆网络配置](../getting-started/mainland-china.md)。

## Package Manager

默认使用 PATH 中的 npm。需要通过 mise、pnpm 或其他 wrapper 时配置 argv：

```json
{
  "npmCommand": ["mise", "exec", "node@22", "--", "npm"]
}
```

该命令用于 npm Package 查询、安装、删除，以及含 `package.json` 的 git Package 依赖安装。

## 离线模式

```bash
PI_OFFLINE=1 la
la --offline
```

离线模式会停止版本检查、远程模型目录、分享和其他非必要网络请求。已经缓存的模型目录、认证和本地资源仍可读取。

## 环境变量优先级

公开环境变量继续使用 `PI_*`，不提供同义 `LA_*`：

```text
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
PI_OFFLINE
PI_PACKAGE_DIR
PI_TUI_WRITE_LOG
PI_SKIP_VERSION_CHECK
```

Provider 的 API Key 使用对应 Provider 环境变量。详细列表见 [Provider 与 API Key](../getting-started/providers.md)。

LYStar 固定关闭安装遥测。兼容读取的上游设置不改变这一行为。

完整字段说明见 [Pi Settings](../../packages/coding-agent/docs/settings.md)；LYStar 的产品和发行事实以当前源码及[建设方案](../lystar-agent-plan.md)为准。
