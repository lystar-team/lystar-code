# DeepSeek Harness 适配器

`@lystar/deepseek-harness` 在 LYStar 进程内运行原版 Cordis/DSH 服务、插件和 Agent。当前固定版本为 `0.2.1-rc.2`，源码依据为 commit `687f282e8625c6b8d11ff58211a90524be2e4317`。

## 插件中枢

CLI 和 Web Runtime 共用 `/plugins` 入口。中枢负责来源注册、状态汇总和操作分发；DSH 适配器负责自己的包格式、配置、服务、资源、工具和会话生命周期。

```mermaid
flowchart TD
  CLI[LYStar CLI] --> Hub[插件中枢]
  Web[LYStar Web Runtime] --> Hub
  Hub --> DSH[DSH 适配器]
  Hub -. 后续接入 .-> Other[其他 Harness 适配器]
  DSH --> Runtime[进程内 Cordis / DSH 运行时]
```

新增来源实现 `PluginAdapter`，再加入 `createPluginHubExtension()` 的适配器数组。当前已实现 DSH；其他 Harness 根据各自协议和运行机制接入。

## 使用原版 Profile

在 LYStar 会话中执行：

```text
/plugins
/plugins dsh profile headless
/plugins dsh list
/plugins dsh run 阅读当前目录并说明主要文件
/plugins dsh cache
```

`headless` 加载原版 Base 与 Headless Bundle，主循环由 LYStar 调用。使用原版 Web 界面时执行：

```text
/plugins dsh profile web
/plugins dsh web
```

`/dsh <操作>` 与 `/plugins dsh <操作>` 共用同一处理器。`list` 展示条目状态、缺失服务和加载错误。原版 Web Profile 的部分工具由 Agent Preset 在会话作用域挂载，根 Loader 中的同名条目可以处于 disabled 状态。

安装使用 LYStar 的 `npmCommand` 设置。Profile 位于 `getAgentDir()/deepseek-harness/profiles/<名称>`，通过固定版本的 pnpm 安装原版 Bundle，并使用 hoisted 目录布局和 peer 依赖安装，以满足原版 YAML 对资源包的解析。初次安装跳过生命周期脚本；后续 Bundle 管理沿用原版管理器。

Profile 中的 Bundle 安装、更新和启停由原版 `PluginManager` 处理。安装目标使用明确版本，例如：

```text
/plugins dsh install @deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.2
/plugins dsh disable @deepseek-ai/dsh-subagent-claude-code
/plugins dsh update @deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.2
/plugins dsh reload
```

更新沿用原版界面的移除、安装顺序，并保留原来的启停选择。普通插件条目的启停使用其 entry id；原版管理器根据目标区分 Bundle 与条目。

## 按包加载插件

逐个选择 Cordis 包时，在 `deepseek-harness/plugins.json` 中使用 `plugins` 配置：

```json
{
  "plugins": [
    { "name": "@deepseek-ai/dsh-tool-fs", "config": { "readLimit": 500 } },
    { "name": "@deepseek-ai/dsh-tool-call-timeout-policy", "disabled": false }
  ]
}
```

该配置通过以下命令管理：

```text
/plugins dsh install @deepseek-ai/dsh-tool-fs@0.2.1-rc.2
/plugins dsh disable @deepseek-ai/dsh-tool-fs
/plugins dsh enable @deepseek-ai/dsh-tool-fs
/plugins dsh reload
```

包安装也接受本地目录，使用配置的 `npmCommand`，保存精确版本并跳过生命周期脚本。运行时沿用原版 `engines.dsh` 判断、Cordis Loader、Group、Include 和 `dsh.bundle.patch` 组合逻辑。包内相对路径以所属文件为基准，`deepseek-harness/cordis.patch.yml` 最后应用。

## 工具、资源与会话

插件工具以 `dsh__<原工具名>` 注册为延迟工具，存在工具时启用 `tool_search`。已启用 Codemode 的会话可以直接调用：

```js
text(await tools.dsh__read({ file_path: "README.md" }));
```

原版技能注册表中的本地 `SKILL.md` 和包内 `skills/` 接入 Pi 技能发现。图片和文件结果通过原版 attachments 服务读取；工具附加上下文保留来源信息。

每个 LYStar 会话拥有自己的 Context、Agent、工具和提示词服务。原版 Profile 使用 DSH V4 事件格式恢复 Pi 历史，映射工具名和元数据，并记录分支与原版会话的关联。SDK 仅提供历史消息而未提供 `systemPrompt` 时，导入空 system 首节点，后续步骤由原版 DSH 提示词服务更新。`run` 驱动原版主循环，模型请求通过 LYStar 模型目录与流接口执行。DeepSeek 原生模型适配保留原版 Messages 协议路径，并把 LYStar API Key 写入原版要求的 `x-api-key` 请求头。

## SDK 接入

把中枢工厂加入 `DefaultResourceLoader.extensionFactories`：

```ts
import {
  createCodemodeExtension,
  createPluginHubExtension,
  createToolSearchExtension,
  deepSeekPluginAdapter,
} from "@earendil-works/pi-coding-agent";

const extensionFactories = [
  { name: "plugin-hub", factory: createPluginHubExtension([deepSeekPluginAdapter]) },
  { name: "tool-search", factory: createToolSearchExtension() },
  { name: "codemode", factory: createCodemodeExtension() },
];
```

通过 `session.bindExtensions()` 绑定宿主的 `commandContextActions`，包括 `waitForIdle` 和 `reload`，使管理操作立即刷新资源与工具。SDK 的插件目录由 `getAgentDir()` 决定，隔离目录通过 `PI_CODING_AGENT_DIR` 指定。`deepSeekHarnessExtension` 提供只注册 DSH 的独立工厂入口。

## 缓存对照

缓存模块为官方 DeepSeek 地址的 `deepseek-flash`、`deepseek-v4-pro` 补充 `supportsMidConvoSystemMessages`，保留显式设置。变化的提示词 section 通过已有 system message 更新机制追加，运行上下文只在变化时记录。宿主工具声明按名称稳定排序，避免插件异步加载顺序改变请求前缀。`/plugins dsh cache` 展示当前分支的缓存 token、SDK 输入费用估算和前缀变化，包括工具声明是否变化、首个变化消息的索引和角色。

[交错对照数据](validation/cache-comparison.json)记录了 4 组、24 次官方 API 请求。每组分别预热两条路径，再交错执行相同的上下文更新和重复请求；所有响应均为 `OK`，且没有调用工具。

| 请求阶段，每项 4 次 | 未缓存输入 token | 缓存读取 token | 命中率 | SDK 输入费用估算，美元 |
| --- | ---: | ---: | ---: | ---: |
| 原行为，上下文更新后首次请求 | 6,545 | 0 | 0% | 0.00098175 |
| 优化后，上下文更新后首次请求 | 877 | 5,760 | 86.79% | 0.00014883 |
| 原行为，相同请求重复 | 785 | 5,760 | 88.01% | 0.00013503 |
| 优化后，相同请求重复 | 877 | 5,760 | 86.79% | 0.00014883 |

本样本中，上下文更新后首次请求的 SDK 输入费用估算下降约 84.84%；重复请求时两条路径均有缓存，优化路径的费用估算略高。样本量与延迟波动不足以得出平均收益或延迟提升结论。服务端 `usage.cacheRead` 用于确认命中，费用按 SDK 中的模型价格计算。

[真实 API 文件任务](validation/cache-file-tasks.json)补充了 3 组交错对照、6 个任务、25 次请求。每个任务都实际调用原版 read/write 工具，读取账单、计算总额并写入 JSON，6 个结果均正确。读取完成后追加 workflow system section，观察后续请求的缓存变化。

| 更新后请求，分别来自 3 个任务 | 请求数 | 未缓存输入 token 合计 | 缓存读取 token 合计 | 命中率 | SDK 输入费用合计，美元 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原行为 | 7 | 4,464 | 13,056 | 74.52% | 0.000708768 |
| 兼容更新路径 | 6 | 1,293 | 13,440 | 91.22% | 0.000234270 |

该阶段的输入费用合计下降约 66.95%；包含预热和所有任务请求时下降约 26.81%。两组模型调用次数不同，不能据此推断每次请求或生产任务的平均收益。样本包含约 7000 字符固定参考资料；本轮额外增加的工具排序尚未单独测量收益。

## 兼容清单与验证

当前尚未完成整套插件的功能验收和四个平台的原生验收，不能据此判断已达到完整兼容的上线条件。以下记录本轮已完成的检查。

[完整清单](validation/plugin-inventory.json)记录指定源码下的 343 个公开发布包，包括 20 个 Bundle、79 个含客户端资源的包，列出入口、资源声明、peer 依赖、服务注入声明位置、加载状态和已执行检查。清单覆盖发布包，包含库、CLI 和客户端模块；功能结论按各项实际检查范围判断。

| 验证对象 | 结果 |
| --- | --- |
| 中枢分发 | 正式测试 13 项通过：多来源分发、参数保留、校验、错误隔离、等待空闲和 reload 上下文 |
| 原版 Web Profile | 根 Loader 共 193 项，166 active、27 disabled，pending/failed 均为 0；Agent 作用域可见 31 个工具 |
| 原版 Headless Profile | 根 Loader 共 99 项，90 active、9 disabled，pending/failed 均为 0；可见 25 个工具 |
| 文件与 Bash | 原版 read/write/edit、Bash 执行和取消通过；Node 取消样本为 125 毫秒 |
| 原版主循环 | 模拟模型工具流程通过；[原版 Messages 真实 API](validation/native-messages.json)完成两轮 write/read 文件任务，未调用 Pi 模型流桥接 |
| 原版 Bundle 管理 | 可选 Claude Code Bundle 安装、更新、移除及禁用状态保留通过；外部 Claude Code 执行未覆盖 |
| 原版 Skill | 四份原版 Skill 经文件系统插件加载到 Pi，诊断为空 |
| 历史与生命周期 | V4 历史恢复、工具名和元数据映射、会话隔离、停用重启和释放通过 |
| Node 打包 SDK | 中枢命令、Codemode 调用和绑定 reload 后启停通过；CLI 无顶层 await，保留同步加载前启用 Node 编译缓存的启动方式 |
| Linux x64 独立程序 | Bun 1.4.2 编译；Web Profile 加载、切换 Headless、中枢命令、Codemode 调用原版 read/Bash 通过 |
| Linux ARM64、macOS x64/ARM64 | 交叉构建成功，产物架构已核对；原生安装、启动、插件执行与更新尚未验证 |
| 现有相关测试 | 最近一批 6 个文件、147 项通过 |
| 项目检查 | `npm run check` 通过 |

[运行与构建记录](validation/runtime-checks.json)包含四个平台产物的 SHA-256、实际执行范围和未完成项。Node 包和 Bun 二进制共用 `bundle-plugin.mjs` 保留 DSH 包身份。独立程序为 DSH 私有 Runner 复用内置 Bun，并保留其参数协议。Linux ARM64、macOS x64/ARM64 的原生运行结果需要相应 runner 验证。插件 active 表示依赖与初始化完成，完整功能兼容以实际执行记录为准。

`scripts/verify-dsh-release.mjs` 已接入 Release workflow 的四平台验收，包含隔离目录安装、Headless/Web 工具执行、原版主循环、Web 登录重定向和 Bundle 禁用后更新。Linux x64 的 Node 包和独立程序已通过本机执行；其他平台等待 CI 结果。模型循环使用本地模拟服务，验收进程配置 pnpm 跳过依赖脚本。
