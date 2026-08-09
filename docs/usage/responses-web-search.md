# Responses 原生网页搜索

[返回文档首页](../README.md)

LYStar 的网页搜索由当前选中的 `openai-responses` 模型直接调用 Provider 托管的 `web_search`。一次搜索只发送当前模型的 Responses 请求，不会切换到隐藏模型，也不会调用旧的 `openai_web_search` 函数工具。

启用条件：

- 模型使用 `api: "openai-responses"`。
- 模型配置明确设置 `compat.supportsWebSearch: true`。
- Provider 端点真实支持 Responses Web Search 协议。

未声明能力的模型不会自动获得替代搜索。Provider 拒绝搜索工具时，当前请求直接返回能力错误。

搜索过程在 TUI 中显示“正在搜索网页”“已搜索网页”或“网页搜索失败”。最终答案后的“引用”只列出答案实际引用的 URL；“来源”保留 Provider 返回的完整搜索来源，两者不会混为一谈。

Session 会保存搜索调用状态、查询、来源、引用标题、URL 和字符范围。同 Provider、API 和模型继续对话时会重放这些结构化内容；切换模型时会保留答案正文，但删除 Provider 私有搜索调用 ID。

Print、JSON/RPC 和 HTML 导出都读取同一结构化数据。HTML 中的 Provider URL 仍经过协议白名单和转义处理。