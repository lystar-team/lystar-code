# Extension

[返回文档首页](../README.md)

Extension 是 TypeScript 或 JavaScript 模块，可以注册 Tool、命令、事件、Provider 和 TUI。LYStar 直接兼容 Pi Extension API。

> Extension 以当前用户权限运行，可以执行任意代码。只安装来源明确、已经阅读并锁定版本的 Extension。

## 安装现有 Extension

优先通过 Pi Package：

```bash
la install git:github.com/<owner>/<repo>@<tag-or-commit>
la list
la config
```

npm Package 需要 Node.js/npm；Git Package 需要 Git，仓库带 `package.json` 时还会安装 npm 依赖。

## 内置 subagent

LYStar 二进制自带 `subagent` Tool，并提供三个不固定模型的后备 Agent：

- `research-specialist`：只读调查代码和文档。
- `review-specialist`：只读检查缺陷、回归和验证缺口。
- `worker`：完成一个范围明确的实现单元。

默认读取内建 Agent 和 `~/.pi/agent/agents/`；调用时把 `agentScope` 设为 `both` 或 `project` 才会加载项目 `.pi/agents/`。用户或项目中的同名 Agent 会覆盖内建定义，不需要另装 subagent Extension。

## 创建最小 Extension

创建 `~/.pi/agent/extensions/hello.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "显示一条测试消息",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Extension 已加载", "info");
    },
  });
}
```

启动 LYStar，执行：

```text
/hello
```

修改文件后执行 `/reload`。

## 临时验证

开发中的文件可直接加载：

```bash
la -e ./hello.ts
```

只加载指定 Extension、忽略自动发现资源：

```bash
la --no-extensions -e ./hello.ts
```

## 发现位置

```text
~/.pi/agent/extensions/*.ts
~/.pi/agent/extensions/*/index.ts
.pi/extensions/*.ts
.pi/extensions/*/index.ts
```

项目 Extension 只在项目受信任后加载。Extension 有第三方依赖时，在同目录维护 `package.json` 和锁文件；分发为 Pi Package 时，运行时依赖放在 `dependencies`。

## 禁用和删除

Package 内 Extension：

```bash
la config
la remove <source>
```

本地 Extension：移走对应文件，然后执行 `/reload`。Extension 自己创建的数据、外部程序和凭据不会由 LYStar 自动判断，按 Extension 文档清理。

## 排查

1. 执行 `/reload`，查看具体加载错误。
2. 确认默认导出是接收 `ExtensionAPI` 的函数。
3. 确认 import 来自 LYStar 内置可用包或本地 `node_modules`。
4. 检查项目是否已信任。
5. 临时使用 `la --no-extensions -e ./file.ts` 隔离其他 Extension。

完整事件、Tool、TUI、Session、Provider 和生命周期 API 见 [Pi Extensions](../../packages/coding-agent/docs/extensions.md)，可运行示例见 `packages/coding-agent/examples/extensions/`。
