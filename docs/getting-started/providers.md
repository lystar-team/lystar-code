# Provider 与 API Key

[返回文档首页](../README.md)

LYStar 继承 Pi 的 Provider、模型目录和认证格式。交互模式优先使用 `/login`，它会把凭据保存到 `~/.pi/agent/auth.json`。

## 订阅登录

运行：

```text
/login
```

内置订阅登录包括：

- ChatGPT Plus/Pro（Codex）
- Claude Pro/Max
- GitHub Copilot
- xAI 订阅
- OpenRouter OAuth
- Radius

退出某个 Provider：

```text
/logout
```

第三方客户端使用 Claude Pro/Max 可能按 Anthropic extra usage 计费，登录前确认账户用量规则。

## API Key

`/login` 中选择 Provider 后可以直接保存 API Key。也可以通过环境变量提供：

| Provider | 环境变量 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| xAI | `XAI_API_KEY` |
| ZAI Coding Plan 中国区 | `ZAI_CODING_CN_API_KEY` |
| MiniMax 中国区 | `MINIMAX_CN_API_KEY` |
| Qwen Token Plan 中国区 | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Xiaomi MiMo Token Plan 中国区 | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |

macOS/Linux：

```bash
export DEEPSEEK_API_KEY="<your-api-key>"
lc --provider deepseek
```

Windows PowerShell：

```powershell
$env:DEEPSEEK_API_KEY = "<your-api-key>"
lc --provider deepseek
```

不要把真实 Key 写入项目 README、`AGENTS.md`、Git 仓库或聊天内容。需要长期保存时优先使用 `/login`；`auth.json` 应保持用户私有。

## 选择模型

交互模式：

```text
/model
```

命令行：

```bash
lc --list-models deepseek
lc --provider deepseek --model <model-id>
```

默认 Provider 和模型也可以写入 `~/.pi/agent/settings.json`：

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "<model-id>"
}
```

模型 ID 以 `lc --list-models` 当前输出为准，不在文档中复制容易过期的完整模型表。

## 自定义兼容服务

Ollama、LM Studio、vLLM 或兼容 OpenAI/Anthropic/Google API 的服务通过 `~/.pi/agent/models.json` 配置。自定义认证和协议可通过 Extension 注册 Provider。

完整 Provider、云服务、自定义模型和凭据优先级见 [Pi Providers](../../packages/coding-agent/docs/providers.md) 与 [Models](../../packages/coding-agent/docs/models.md)。

## 网络说明

安装下载、GitHub、npm 和 Provider API 是不同链路。代理配置见[中国大陆网络配置](mainland-china.md)。不推荐把 API Key 交给来源不明的模型转发服务。
