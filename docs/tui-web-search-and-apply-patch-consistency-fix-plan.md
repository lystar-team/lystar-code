# TUI 卡片视觉、Web Search 交互与 Subagent 汉化集中修复方案

> 状态：已于 2026 年 8 月 10 日完成实施和验证。

## 1. 目标

修复当前 TUI 中六类直接影响阅读、操作判断和界面完成度的问题：

1. 同一条 Assistant 消息包含多个 Web Search 调用时，点击其中一个搜索摘要会让全部搜索来源一起展开或收起。
2. Web Search 摘要的展开状态、图标和来源列表层级不清，放大镜前还有多余的展开符号。
3. `apply_patch` 执行期间，活动条和 Tool 卡片分别显示原始 Tool 名、中文执行状态等不同文案，造成状态来回跳变。
4. 几乎所有 Tool 卡片都显示“展开符 + 功能图标”双前缀，例如 `▸ ✎`、`▸ $`、`▸ ⌕`，视觉噪声来自共享组件，不是单个 Tool 的局部问题。
5. Turn Summary、Skill、分支摘要和上下文压缩把 `Ctrl+O 展开` 重复塞进内容卡片，宽度不足时会单独折行；固定底部快捷栏已经提供相同提示。
6. Subagent 卡片直接显示 `parallel`、`chain`、`single`、`user`、`project` 等内部枚举，内置确认和错误也存在英文文案，未达到中文内置界面的要求。

本文用于统一集中修复这组 TUI 共性问题。Session JSONL、Provider Web Search 数据、Tool 名、Extension API、Subagent 参数值和补丁执行逻辑保持不变。本轮不更换主题、配色或整体布局，只处理截图和源码已经确认的卡片结构、响应式、交互状态与内置文案。

## 2. 已验证现状

### 2.1 Web Search 共用一个展开状态

`packages/coding-agent/src/modes/interactive/components/assistant-message.ts` 当前只有一个：

```ts
private contentExpanded = false;
```

这个状态同时控制：

- 长代码块。
- 长 Markdown。
- 当前 Assistant 消息中的全部 `webSearchCall` 来源列表。

`updateContent()` 遍历每个 `webSearchCall` 时，都使用同一个 `this.contentExpanded`：

```ts
if (this.contentExpanded && sources.length > 0) {
  // 渲染来源
}
```

因此，同一 Assistant 消息只要包含两个或更多搜索调用，点击任意一个搜索摘要都会改变整个消息级状态，所有来源列表必然联动。

### 2.2 点击命中范围也是消息级

`AssistantMessageComponent.getCardClickActionAtRow()` 当前没有判断点击的是哪一条搜索摘要：

```ts
getCardClickActionAtRow(row: number): InteractiveCardAction | undefined {
  if (row < 0 || (!this.hasLongCodeBlock && !this.hasLongMarkdown && !this.hasWebSearchSources)) return undefined;
  return { type: "toggle", component: this };
}
```

只要消息内存在可展开内容，搜索摘要、普通回答、引用和来源非链接区域都会指向同一个 Assistant 卡片 toggle。现有单测虽然名为“只从搜索摘要行展开”，实际断言允许引用行和来源行触发同一个 toggle，没有锁定独立卡片行为。

### 2.3 Web Search 摘要包含两个前导符号

当前摘要格式为：

```text
▸ ⌕ 已搜索网页 · 2 个来源
▾ ⌕ 已搜索网页 · 2 个来源
```

`▸/▾` 与 `⌕` 连续占用两个图形位置。搜索类型已经由放大镜表达，额外前导展开符让摘要显得零碎，也把组件内部展开状态放到了搜索类型图标之前。

### 2.4 apply_patch 存在两套展示来源

`packages/coding-agent/src/extensions/apply-patch/index.ts` 的 Tool 卡片使用：

```text
正在应用补丁
已应用补丁
应用补丁失败
```

`packages/coding-agent/src/modes/interactive/interactive-mode.ts` 的活动条则直接使用：

```ts
action: activity.phase === "runningTool" ? current?.name : activity.action
```

因此执行 `apply_patch` 时，活动条显示原始 Tool 名 `apply_patch`，Tool 卡片显示“正在应用补丁”。两个区域刷新时会给用户造成同一个操作在切换名称或切换阶段的感觉。

用户反馈中的“正在补丁文件”原文没有出现在当前源码中，暂不能证明它来自固定 locale；但原始 Tool 名与中文状态来自两套展示链路已经确认，本轮按统一状态语义修复，并在真实 PTY 中复现和回查最终可见文案。

### 2.5 Tool 卡片双前缀来自共享摘要函数

截图中的 `apply_patch` 卡片实际显示为：

```text
▸ ✎ 已应用补丁 1 个文件 +5 -3
```

Bash 卡片显示为：

```text
▸ $ 已运行 ...
```

这两个 Tool 使用不同 renderer，但都经过 `packages/coding-agent/src/modes/interactive/components/tool-summary.ts` 的 `formatToolSummary()`。该函数固定在业务图标前添加：

```ts
const chevron = options.expanded ? uiGlyphs.expanded : uiGlyphs.collapsed;
```

因此 `▸/▾` 会出现在 read、write、edit、bash、grep、find、ls、`apply_patch`、`image_gen` 等所有采用共享摘要格式的 Tool 前面。只删 Web Search 或 `apply_patch` 中的字符无法解决共性问题，正确责任位置是 `formatToolSummary()`。

### 2.6 Turn Summary 的快捷键提示会破坏单行布局

截图中的完成摘要为：

```text
✓ 完成 · 修改 1 个文件 · +437/-0 · 命令 14/15 · 5m35s （Ctrl+O 展开）
```

`TurnSummaryComponent` 使用普通 `Text` 拼接完整摘要和快捷键提示，没有宽度优先级，也没有单行裁切。宽度不足时，只有右侧括号被折到下一行，形成一条没有独立含义的残缺行。

固定底部 `WorkspaceShortcutBar` 已经持续显示 `Ctrl+O 展开`。Turn Summary、Skill、分支摘要和上下文压缩再次显示同一提示，造成重复信息和布局抖动。

### 2.7 apply_patch 文件行缺少宽度约束

截图中的长路径自动换成两行，`+5 -3` 与文件名发生视觉分离。当前 `renderResult()` 把路径和统计直接交给普通 `Text`，没有为右侧统计保留稳定宽度。

同类结果行应遵守统一规则：

- 操作图标和统计固定可见。
- 路径占用中间剩余宽度。
- 路径过长时单行省略，不能把扩展名或统计甩到下一行。
- 中文宽字符按终端可见宽度计算，不能用字符串长度裁切。

### 2.8 Subagent 直接展示内部枚举

`packages/coding-agent/src/extensions/subagent/index.ts` 当前摘要直接拼接：

```text
subagent parallel · 2 个 Agent · user
```

其中 `parallel`、`single`、`chain` 和 `user`、`project`、`both` 是 Tool 参数与 Session details 的协议值，应继续原样存储；TUI 没有提供显示层映射，导致内部枚举直接暴露给用户。

同一 Extension 中还存在用户可见的英文确认、参数错误和执行失败文本。模型提示、Tool description、schema description 属于模型和协议边界，不在汉化范围；TUI 摘要、确认弹窗和 Tool Result 错误属于内置界面，必须中文化。

## 3. 修复原则

- 每个 `webSearchCall` 是独立交互对象，状态按稳定 `content.id` 归属。
- 鼠标点击只影响命中的搜索卡片；不能再借用整个 Assistant 消息的展开状态。
- `Ctrl+O` 继续作为全局详情开关，可以统一展开或收起当前已渲染卡片。
- 来源链接继续由 OSC 8 链接处理，点击链接只打开网页，不触发展开切换。
- 搜索摘要保留一个搜索图标，不在放大镜前叠加第二个图形符号。
- 所有可展开卡片头只保留一个语义图标，不再显示通用 `▸/▾`。
- 展开状态由正文是否出现、点击反馈和固定快捷栏表达，不在每张卡片重复加符号和快捷键。
- 所有摘要头保持单行；空间不足时按信息优先级缩短或省略，禁止产生只有括号或快捷键的残缺行。
- `apply_patch` 的执行中、成功和失败文案使用同一 locale 事实源。
- Subagent 内部枚举只在显示层汉化，存储值和 Tool 参数保持原样。
- Tool 名仍为协议值 `apply_patch`，不修改 ToolDefinition `name`、调用参数或 Session 记录。
- 不新增设置项，不增加依赖，不重做通用卡片体系。

## 4. Web Search 目标行为

### 4.1 每条搜索独立展开

假设一条 Assistant 消息包含两个搜索调用：

```text
⌕ 已搜索网页 · 4 个来源
⌕ 已搜索网页 · 2 个来源
```

点击第一条后：

```text
⌕ 已搜索网页 · 4 个来源
  搜索来源
  1. OpenAI Web Search
  2. GitHub Actions
  3. Node.js
  4. Example

⌕ 已搜索网页 · 2 个来源
```

此时第二条必须保持收起。再次点击第一条，只收起第一条来源。

### 4.2 摘要图标

折叠和展开状态都使用同一个摘要头：

```text
⌕ 已搜索网页 · 4 个来源
```

删除放大镜前的 `▸/▾`。展开状态由下方来源列表是否存在表达，不再叠加第二个前导图标。

Windows 字符降级继续走 `uiGlyphs.search`，不能在组件内硬编码另一套 Windows 符号。

### 4.3 来源列表

- 默认收起，只显示来源数量。
- 展开后使用现有编号链接列表，不显示原始 URL 长串。
- 标题优先使用 citation title，没有标题时回退域名。
- “搜索来源：”调整为更轻的“来源”，避免摘要已经说明搜索后再重复描述。
- 来源列表与下一条搜索、回答正文之间保留一个稳定空行。
- 40 列窄终端允许标题自然截断或换行，不能挤出终端宽度。

### 4.4 点击规则

| 点击位置 | 行为 |
| --- | --- |
| 搜索摘要行 | 只切换当前搜索来源 |
| 当前搜索来源的非链接空白区域 | 切换当前搜索来源 |
| 来源链接字符区域 | 打开网页，不切换 |
| Assistant 普通回答 | 只在该消息确有长 Markdown/代码时切换长内容 |
| 另一条搜索摘要 | 只切换另一条搜索 |

### 4.5 Ctrl+O

`Ctrl+O` 保持现有全局语义：

- 展开时，长 Markdown、长代码、Tool Diff 和每条 Web Search 来源都展开。
- 收起时，上述内容统一收起。
- 用户用鼠标单独调整某条搜索后，只改变该条局部状态。
- 下一次 `Ctrl+O` 仍以全局目标值覆盖全部局部状态。

## 5. Web Search 实现设计

### 5.1 增加独立组件

在 `assistant-message.ts` 附近增加内部组件 `WebSearchCallComponent`，实现现有 `InteractiveCard` 契约。

职责限定为：

- 保存一个 `webSearchCall` 的展开状态。
- 渲染摘要和当前调用的来源列表。
- 返回当前卡片的点击动作。
- 使用 `web-search:${content.id}` 作为稳定状态 key。

不为该组件新建公共框架。若实现保持清楚，可以先作为 `assistant-message.ts` 内部类；只有文件明显失控时再拆到独立文件。

### 5.2 组件复用与状态保持

`AssistantMessageComponent` 维护：

```ts
private webSearchComponents = new Map<string, WebSearchCallComponent>();
```

每次 `updateContent()`：

1. 按 `content.id` 查找已有组件。
2. 已存在时更新 status、sources 和 citation title，不重置 `expanded`。
3. 不存在时创建新组件，初始值跟随当前全局 `toolOutputExpanded` 传入的 `setExpanded()` 结果。
4. 删除本次消息已不存在的旧 id。

禁止用数组下标或来源 URL 拼接作为状态 key；流式响应中内容顺序可能变化，`content.id` 才是 Provider 已提供的稳定标识。

### 5.3 行范围路由

`AssistantMessageComponent` 在渲染时记录每个 Web Search 子组件的行范围：

```ts
interface WebSearchRange {
  component: WebSearchCallComponent;
  start: number;
  end: number;
}
```

`getCardClickActionAtRow(row)` 按顺序处理：

1. 命中 Web Search range 时，把组件内行号交给该搜索组件。
2. 未命中搜索，且消息有长 Markdown/代码时，返回 Assistant 自身 toggle。
3. 其他情况返回 `undefined`，不吞普通文本点击。

这条规则沿用 `ToolExecutionGroupComponent` 已有的“父组件记录范围、点击路由到子卡片”模式，不另建命中系统。

### 5.4 全局展开兼容

`AssistantMessageComponent.setExpanded(expanded)` 同时：

- 更新自身长 Markdown/代码的 `contentExpanded`。
- 对当前全部 `WebSearchCallComponent` 调用 `setExpanded(expanded)`。

`getChildCards()` 返回当前 Web Search 子卡片，保证 Subagent Overlay 的卡片状态访问和稳定 key 机制能够识别这些子卡片。

## 6. apply_patch 目标行为

### 6.1 执行期间

活动条和 Tool 卡片统一表达同一动作：

```text
正在应用补丁
```

不再在活动条显示裸 `apply_patch`，也不出现“正在补丁文件”等不完整语序。

### 6.2 执行成功

卡片保持当前结构：

```text
✎ 已应用补丁 3 个文件 +2 -2
  + docs/new.md  +1 -0
  ✎ src/index.ts  +1 -1
  - src/old.ts  +0 -1
```

折叠只隐藏具体 Diff，文件列表和增删统计继续默认可见。

活动条在 Tool 完成后按现有流程进入“等待下一步”，不额外闪现成功文案。

### 6.3 执行失败

```text
应用补丁失败
  Could not find the expected text in src/index.ts
```

失败正文直接可见，不显示“已应用补丁”或文件成功统计。

## 7. apply_patch 实现设计

### 7.1 统一 locale

在 `packages/coding-agent/src/locales/zh-CN.ts` 增加 `apply_patch` 三态文案，例如：

```ts
"tool.applyPatch.running": "正在应用补丁",
"tool.applyPatch.success": "已应用补丁",
"tool.applyPatch.error": "应用补丁失败",
```

`createApplyPatchToolDefinition().renderCall()` 使用这三个 locale key，不再维护局部字符串。

### 7.2 活动条不直接展示 raw Tool name

扩展 `getTrackedToolDisplay()` 的返回值：

```ts
{ action?: string; subject?: string; filePath?: string }
```

对 `apply_patch` 返回：

```ts
{ action: t("tool.applyPatch.running") }
```

`TrackedTurnTool` 保存可选 `action`。`updateActivityBar()` 在单 Tool 运行时优先使用 `current.action`，没有专用 action 才回退 `current.name`。

本轮只补 `apply_patch` 已确认的不一致，不顺手重写所有 Tool 的活动文案，也不修改 Extension API。

### 7.3 保持协议兼容

以下值继续保持原样：

- ToolDefinition `name: "apply_patch"`。
- 系统提示中的 Tool 名。
- Tool Call 和 Tool Result 的 `toolName`。
- Session JSONL 中的 Tool 名与 details。
- `--tools`、`--exclude-tools` 使用的参数值。

中文只作用于 TUI 展示层。

## 8. 统一 TUI 卡片视觉规则

### 8.1 单图标卡片头

所有 Tool 摘要统一为：

```text
功能图标  状态  主体  元数据
```

示例：

```text
✎ 已应用补丁  1 个文件  +5 -3
$ 已运行  npm run check
⌕ 已搜索网页  4 个来源
◆ Subagent  并行  2 个 Agent  用户级
✓ 完成  修改 1 个文件  +437 -0  命令 14/15  5m35s
```

规则：

- 删除卡片头最前面的 `▸/▾`。
- 保留 Tool 或状态本身的语义图标。
- 元数据使用现有 muted/dim 颜色，不增加新颜色角色。
- 状态、主体和元数据之间使用稳定空格或中点分组，同一类组件必须一致。
- 展开和折叠不能让摘要头的图标、标题或主要统计发生横向跳动。
- 图标必须来自 `uiGlyphs` 或经过 `toUiGlyph()` 转换，Windows 继续使用现有 ASCII 降级符号。

### 8.2 修改共享摘要函数

`formatToolSummary()` 中删除 `expanded` 参数和 chevron 拼接。`expanded` 只决定 renderer 是否显示正文，不再参与摘要字符串。

现有 `ToolSummary.render(width)` 已使用 `truncateToWidth()` 保证摘要单行，本轮直接复用，不再新增一套摘要裁切组件。

需要同步更新现有调用者：

- read
- write
- edit
- bash
- grep
- find
- ls
- `apply_patch`
- `image_gen`
- 通用 Tool fallback

这项修改必须在共享函数完成，禁止在每个 Tool renderer 中分别 `replace()` 或传空字符。

### 8.3 多 Bash Tool 组

`ToolExecutionGroupComponent` 当前组摘要也使用 `▸/▾`。组摘要改用一个列表或 Tool 图标，例如：

```text
◆ 3 条命令执行完成 · 1 条失败
```

点击组摘要仍然展开或收起组内容，行为不变。子 Bash Tool 继续使用 `$`，组头和子项有清楚层级。

### 8.4 Tool 结果行

`apply_patch` 文件行按固定三段布局渲染：

```text
操作图标  路径                         +N -N
```

实现使用 `visibleWidth()` 和 `truncateToWidth()` 为统计预留宽度。窄终端按以下优先级保留：

1. 操作图标。
2. `+N -N`。
3. 文件名尾部或路径尾部。
4. 中间目录。

默认单行显示。Diff 展开后可以多行，文件摘要行不能因长路径自动换行。

在 `apply-patch` Extension 内增加局部的宽度感知文件行组件，避免把通用 Tool 卡片体系复杂化。渲染顺序为：

1. 用现有 `shortenPath()` 生成 `~` 路径。
2. 完整路径放不下时压缩为 `…/basename`。
3. 为操作图标和统计预留宽度后裁切显示路径。
4. 使用现有 `linkPath()` 把压缩后的显示文本链接到完整原始路径，不能丢失 OSC 8 文件链接。

### 8.5 快捷键只由固定快捷栏承担

从以下组件的卡片正文中删除内嵌 `Ctrl+O 展开`：

- `TurnSummaryComponent`
- `SkillInvocationMessageComponent`
- `BranchSummaryMessageComponent`
- `CompactionSummaryMessageComponent`

`WorkspaceShortcutBar` 保持唯一的全局快捷键提示。组件收起时只显示自身摘要，例如：

```text
[skill] shuorenhua
[分支摘要]
[上下文压缩] 已压缩 120,000 Token
```

### 8.6 Turn Summary 响应式

Turn Summary 必须始终渲染为一行摘要，不能依赖普通 `Text` 自动换行。

完整宽度：

```text
✓ 完成 · 修改 1 个文件 · +437 -0 · 命令 14/15 · 5m35s
```

宽度不足时按顺序压缩：

1. 删除“修改”“命令”等可从上下文推断的连接词，保留事实值。
2. 隐藏耗时。
3. 隐藏命令统计。
4. 最后才截断文件统计。

结果始终是一条完整可读的单行，不能出现单独的 `）`、快捷键或元数据残片。展开后文件和失败详情继续显示在正文区域。

### 8.7 其他展开卡片

Branch Summary、Compaction Summary、Skill、Custom Entry 和 Subagent Overlay 继续使用现有背景、间距和点击逻辑。本轮只统一以下共性：

- 单图标或单标签头。
- 无内嵌快捷键。
- 单行摘要不产生残缺换行。
- 展开正文与下一张卡片之间保持一个稳定空行。

不借本轮调整主题色、圆角、边框或整体信息架构。

## 9. Subagent 汉化与展示规则

### 9.1 模式映射

| 协议值 | TUI 显示 |
| --- | --- |
| `single` | 单任务 |
| `parallel` | 并行 |
| `chain` | 串行 |

`chain` 当前按前一步输出传给后一步执行，界面使用“串行”比“链式”更直接。协议值保持 `chain`。

### 9.2 作用域映射

| 协议值 | TUI 显示 |
| --- | --- |
| `user` | 用户级 |
| `project` | 项目级 |
| `both` | 用户级 + 项目级 |

### 9.3 Subagent 摘要

改为：

```text
◆ Subagent · 并行 · 2 个 Agent · 用户级
```

约束：

- `Subagent`、`Agent` 和 Agent 名属于产品术语，保留。
- `parallel`、`single`、`chain`、`user`、`project`、`both` 不再直接出现在 TUI。
- Agent 名、Agent ID、Tool 名和 Session 引用保持原样。
- 数量为 0 时显示真实 `0 个 Agent`，不能根据空 `chain` 误判模式或数量。

### 9.4 内置用户文案

汉化 Subagent Extension 中会直接进入 TUI 的内容：

- 项目 Agent 信任确认标题、正文和按钮。
- 并行任务超过上限。
- 参数无效与可用 Agent 列表。
- Agent 启动、会话恢复、已结束或仍运行中的用户可见错误。
- 并行执行进度 `Parallel: N/M done, K running...`。
- 并行结果中的 `succeeded`、`completed`、`failed`。
- 串行中止 `Chain stopped at step N`。
- 单 Agent 失败 `Agent failed`。
- 空结果 `(no output)` 和运行中占位 `(running...)`。

保持英文的内容：

- Tool description、prompt snippet 和 schema description。
- Tool 参数名和枚举值。
- RPC 命令、事件名、JSON 字段。
- 第三方或子进程返回的原始错误正文；可以加中文前缀，不能改写原始技术信息。

### 9.5 locale 事实源

Subagent 模式、作用域、状态、确认和错误文案进入 `zh-CN.ts`。`subagent-run.ts`、Extension renderer 和 Agent Workbench 复用同一组 locale key，避免三处各维护一套“运行中/已完成/失败”。

显示层映射必须是纯函数或静态 locale 表，未知值回退原始值，不能因为汉化增加第二套 Subagent 状态机。

## 10. 预计改动文件

### 必改

- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
  - Web Search 独立组件、独立状态和行范围路由。
  - 去掉搜索图标前的展开符。
  - 长 Markdown/代码与搜索来源状态解耦。
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `TrackedTurnTool` 增加展示 action。
  - 活动条优先使用 `apply_patch` 中文 action。
- `packages/coding-agent/src/extensions/apply-patch/index.ts`
  - 三态文案改用 locale。
  - 增加局部宽度感知文件行，保留完整文件链接和右侧统计。
- `packages/coding-agent/src/extensions/image-gen/index.ts`
- `packages/coding-agent/src/core/tools/read.ts`
- `packages/coding-agent/src/core/tools/write.ts`
- `packages/coding-agent/src/core/tools/edit.ts`
- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/core/tools/grep.ts`
- `packages/coding-agent/src/core/tools/find.ts`
- `packages/coding-agent/src/core/tools/ls.ts`
- `packages/coding-agent/src/modes/interactive/components/bash-execution.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
  - 同步删除传给 `formatToolSummary()` 的无效 `expanded` 格式参数，不改变各 Tool 的正文展开逻辑。
- `packages/coding-agent/src/extensions/subagent/index.ts`
  - 模式、作用域、确认和内置错误的 TUI 显示汉化。
- `packages/coding-agent/src/locales/zh-CN.ts`
  - 增加 Tool、Subagent 模式/作用域/状态和确认文案。
- `packages/coding-agent/src/modes/interactive/components/tool-summary.ts`
  - 删除共享 Tool 摘要的 chevron 和 `expanded` 格式参数。
- `packages/coding-agent/src/modes/interactive/components/tool-execution-group.ts`
  - 多命令组头改为单语义图标。
- `packages/coding-agent/src/modes/interactive/components/turn-summary.ts`
  - 删除内嵌快捷键，增加单行宽度优先级。
- `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts`
- `packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts`
- `packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts`
  - 删除重复的卡片内快捷键提示。
- `packages/coding-agent/src/modes/interactive/components/subagent-run.ts`
  - 复用统一 Subagent 状态 locale。
- `packages/coding-agent/src/modes/interactive/components/agent-workbench.ts`
  - 复用统一 Subagent 状态 locale。
- `packages/coding-agent/test/assistant-message.test.ts`
  - 多搜索独立展开、行命中和图标回归。
- `packages/coding-agent/test/interactive-tui.test.ts`
  - 真实鼠标点击两条搜索卡片和链接优先级。
  - Skill、分支摘要和上下文压缩不再重复卡片内快捷键。
- `packages/coding-agent/test/interactive-mode-status.test.ts`
  - 活动条不再显示裸 `apply_patch`。
- `packages/coding-agent/test/tool-execution-component.test.ts`
  - Tool 单图标头、`apply_patch` 文案、长路径和统计布局。
- `packages/coding-agent/test/tool-execution-group.test.ts`
  - 多命令组头不再使用 chevron。
- `packages/coding-agent/test/task-workbench-components.test.ts`
  - Turn Summary 响应式和快捷键去重。
- `packages/coding-agent/test/subagent-extension.test.ts`
  - mode/scope 汉化和用户可见错误。
- `packages/coding-agent/test/subagent-session-view.test.ts`
  - Subagent 行状态与交互保持。

### 按测试结果决定

- `packages/coding-agent/src/modes/interactive/components/interactive-card.ts`
  - 现有契约已支持子卡片，预期无需修改。
- `packages/coding-agent/src/modes/interactive/components/subagent-session-view.ts`
  - 现有 `getChildCards()` 和稳定 key 路径可复用；只有 Overlay 测试暴露状态恢复缺口时才调整。

## 11. 自动测试

### 11.1 Web Search 组件测试

至少覆盖：

1. 同一消息包含两个有来源的 `webSearchCall`。
2. 点击第一条摘要后，只显示第一条来源。
3. 点击第二条摘要后，两条可以保持不同展开状态。
4. 收起第一条不影响第二条。
5. 更新同一 `content.id` 的 status 或 sources 后保留展开状态。
6. 搜索调用消失后清理旧组件状态。
7. 摘要包含 `⌕ 已搜索网页 · N 个来源`。
8. 摘要不包含 `▸ ⌕`、`▾ ⌕` 或放大镜前的其他装饰符。
9. 普通引用行在没有长 Markdown/代码时不再返回 Assistant 消息级 toggle。
10. `setExpanded(true/false)` 仍能统一控制全部搜索和长内容。

### 11.2 鼠标与链接测试

在真实 `LystarTUI + RecordingTerminal` 路径覆盖：

1. 点击第一条搜索摘要，只展开第一条。
2. 点击第二条搜索摘要，只改变第二条。
3. 点击来源链接打开对应 URL，不改变展开状态。
4. 滚动后点击仍命中正确搜索卡片。
5. resize 后行范围重新计算，点击不串卡片。

### 11.3 apply_patch 测试

覆盖：

1. Tool 进入 running 后，活动条显示“正在应用补丁”，不包含裸 `apply_patch`。
2. Tool 卡片执行中使用同一“正在应用补丁”。
3. 成功后显示“已应用补丁”、文件数和统计。
4. 失败后显示“应用补丁失败”和错误正文。
5. Session 重放仍根据持久 Tool Result 正确显示成功或失败状态。

### 11.4 统一卡片头测试

覆盖所有使用 `formatToolSummary()` 的内置 Tool：

1. 摘要头只有一个语义图标。
2. 不包含 `uiGlyphs.expanded` 或 `uiGlyphs.collapsed`。
3. 展开前后摘要头的图标和主要状态不移动。
4. 40、80、120 列下摘要头不产生自动换行。
5. `apply_patch` 长路径单行省略，右侧 `+N -N` 保持可见。
6. 多 Bash Tool 组头使用单图标，子项继续使用 `$`。
7. Windows glyph 映射不输出 `▸/▾` 和无法降级的富字符号。

### 11.5 Turn Summary 与快捷键测试

1. Turn Summary 不包含 `Ctrl+O` 或括号提示。
2. 40、60、80、120 列始终只有一行摘要。
3. 窄宽度按既定优先级删除低优先信息，不产生孤立符号。
4. Skill、分支摘要和上下文压缩收起态不再重复快捷键。
5. `WorkspaceShortcutBar` 继续显示 `Ctrl+O 展开`。

### 11.6 Subagent 汉化测试

1. `single/parallel/chain` 分别显示“单任务/并行/串行”。
2. `user/project/both` 分别显示“用户级/项目级/用户级 + 项目级”。
3. TUI 摘要不包含裸模式和作用域枚举。
4. Agent 名、数量和运行状态保持正确。
5. 内置确认、参数错误、并行上限、执行进度、结果状态和空结果使用中文。
6. Tool 参数、details.mode、details.agentScope 和 Session 数据仍保存原协议值。

## 12. 真实 PTY 验收

使用本轮独立 tmux socket，至少覆盖 `80x24`、`80x8` 和 `120x36`。

准备一个包含以下内容的 Session fixture：

- 同一 Assistant 消息中连续两个 `webSearchCall`，来源数量不同。
- 第一条来源包含 citation title，第二条只包含 URL。
- 一个执行成功的多文件 `apply_patch`。
- 一个执行失败的 `apply_patch`。
- 一个 Bash Tool。
- 一个包含两个 Agent 的 parallel Subagent。
- 一个完整 Turn Summary，包含文件、命令、耗时和 Tool 失败恢复记录。

验收动作：

1. 启动后两条搜索默认收起，摘要前只有搜索图标。
2. 鼠标展开第一条，第二条不动。
3. 展开第二条后收起第一条，状态互不影响。
4. 点击来源链接能打开 URL，不触发卡片切换。
5. `Ctrl+O` 能统一展开，再次按下统一收起。
6. 流式执行 `apply_patch` 时，活动条和卡片都使用“正在应用补丁”。
7. 成功、失败状态不出现裸 Tool 名与中文状态来回切换。
8. `apply_patch`、Bash、Web Search 和 Subagent 卡片头都只有一个语义图标。
9. `apply_patch` 长路径不会把统计挤到下一行。
10. Turn Summary 不显示卡片内 `Ctrl+O`，且 40/80/120 列都保持单行。
11. Subagent 显示“并行 · 2 个 Agent · 用户级”，不显示 `parallel` 或 `user`。
12. 极小高度下 Composer 和快捷栏仍可见，展开正文不能挤出固定底部区。
13. resize 和滚动后重新点击，命中关系保持正确。

## 13. 验证命令

实施完成后至少运行：

```bash
cd packages/coding-agent
npx vitest --run \
  test/assistant-message.test.ts \
  test/interactive-tui.test.ts \
  test/interactive-mode-status.test.ts \
  test/tool-execution-component.test.ts \
  test/tool-execution-group.test.ts \
  test/task-workbench-components.test.ts \
  test/subagent-extension.test.ts \
  test/subagent-session-view.test.ts

cd ../..
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
git diff --check
```

可见 TUI 改动必须完成第 12 节真实 PTY 验收，自动测试不能替代鼠标命中、窄终端和实际刷新过程。

## 14. 完成标准

以下条件全部满足才算完成：

1. 点击任意 Web Search 摘要只改变当前搜索卡片。
2. 同一 Assistant 消息中的多条搜索可以保持不同展开状态。
3. 长 Markdown、长代码和搜索来源不再共用一个局部展开状态。
4. 搜索摘要前只有搜索图标，不再出现多余前导符号。
5. 来源链接点击优先级不变，仍能正常打开。
6. `Ctrl+O` 继续统一控制当前已渲染详情。
7. `apply_patch` 活动条和 Tool 卡片使用同一组中文状态文案。
8. TUI 不再显示裸 `apply_patch` 与中文动作来回切换。
9. 成功文件统计、展开 Diff、失败错误和历史 Session 重放保持正常。
10. 所有内置 Tool 卡片头只保留一个语义图标，不再出现 `▸/▾ + 功能图标`。
11. Turn Summary、Skill、分支摘要和上下文压缩不再内嵌 `Ctrl+O`。
12. Turn Summary 和 Tool 摘要在窄宽度下不产生残缺换行。
13. `apply_patch` 长路径与增删统计保持同一行。
14. Subagent 模式、作用域、确认和内置错误完成中文显示，协议值保持兼容。
15. 聚焦测试、Coding Agent 全量测试、静态检查、离线构建和真实 PTY 验收通过。

## 15. 不在本轮处理

- 不改变 Provider 返回的 `webSearchCall`、sources 或 citation 数据结构。
- 不改变 HTML 导出中的搜索展示。
- 不重做所有 Tool 的活动条中文化。
- 不修改 `apply_patch` 执行、校验、原子写入和回滚逻辑。
- 不改变全局 `Ctrl+O` 快捷键及其存储语义。
- 不引入新的卡片状态持久化格式。
- 不翻译 Tool 名、Agent 名、模型名、Provider 名、参数名、JSON 字段或 RPC 事件。
- 不修改主题配色、背景色、字体、终端行高和整体全屏布局。

本文所列修复已完成，验证结果以本轮交付记录为准。