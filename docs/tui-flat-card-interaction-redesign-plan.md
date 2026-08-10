# LYStar TUI 平面卡片与多级交互重设计实施方案

> 状态：待 Yean 审阅确认，尚未实施
>
> 日期：2026 年 8 月 10 日
>
> 视觉参考：`docs/tui-pic/lystar-tui-redesign.png`

## 1. 结论

本方案可以实施，没有 Session、Provider、Tool 或 Extension 协议层面的阻碍。

本轮采用参考图的顶部状态、平面 Tool 列表、细分隔线、低对比背景、文件路径层级、命令结果分组、底部活动状态和统一图标语言。以下内容明确不进入实施范围：

- 不做左侧连续时间线。
- 不生成“检查文件与调用链”一类任务阶段标题。
- 不做发光、阴影或像素级特效。
- 不修改现有输入框结构、尺寸、品牌切口和模型信息。

实施后的核心变化是：当前互相独立的 Tool 背景卡片改成连续、紧凑、可逐张点击的平面卡片列表。每张卡片都按当前终端宽度重新排版，完成后紧跟一条低对比灰色细线，线的上下没有空白行。

## 2. 当前事实

### 2.1 已有能力

当前代码已经具备以下基础：

- `InteractiveCard` 提供 `isExpanded()`、`setExpanded()`、稳定状态键和嵌套卡片访问契约。
- `LystarWorkspace` 能按渲染行定位顶层组件，支持鼠标按下、释放确认和滚动后的坐标换算。
- `ToolExecutionComponent` 已经是独立可展开卡片，状态键为 Tool call ID。
- `ToolExecutionGroupComponent` 已经能维护子 Tool 行范围并把点击路由到具体子卡片。
- Web Search 已经按搜索调用 ID 独立展开。
- `SubagentResultComponent` 已经能按 Agent 行找到对应 Agent，但当前点击后直接打开会话，Agent 行自身没有展开状态。
- `SubagentSessionViewComponent` 已经能保存嵌套卡片展开状态，并保证链接点击优先于卡片点击。
- `WorkspaceComposer` 已经接近参考图输入区，本轮直接保留。
- `LystarWorkspace` 已经有右侧滚动条和固定底部区域。
- Windows 默认交互入口已经使用 `lystar-terminal.exe`，通过 ConPTY、WebView2、xterm.js 和发行包内置 Noto Sans Mono CJK 字体显示现有 TUI。

### 2.2 当前结构问题

当前 Tool 调用由 `interactive-mode.ts` 直接向聊天容器追加 `Spacer + ToolExecutionComponent`。每张 Tool 卡片独立决定背景、间距和内容结构，造成：

- 相邻 Tool 之间依赖空白行，没有稳定分隔关系。
- pending、success、error 使用不同的大块背景，画面切得很碎。
- 路径、动作、状态、统计和错误经常挤在同一行。
- 卡片可点击，但没有统一的展开状态提示位置。
- Subagent 外层 Tool、Agent 行和 Agent 会话入口只有两层行为，无法同时满足“外层收起”和“单行展开”。
- Windows 即使运行在自带字体的独立宿主中，`ui-glyphs.ts` 仍按 `process.platform === "win32"` 强制降级为 ASCII，默认 Windows 窗口没有使用与 macOS、Linux 相同的图标。

## 3. 最终界面目标

下面是实施后的宽屏示意。字符、内容和数量来自真实运行状态，不生成阶段标题。

```text
~/projectWorkspace/guotou-platform  │  执行中  │  上下文 40.1%
────────────────────────────────────────────────────────────────────

  Planning comprehensive file inspection

✓ 命令执行完成 · 6 条                                  11m23s  ▸
✗ 命令 2 项失败                                                 ▾
  └ Error: Command failed (exit code 1): eslint src/**/*.ts
  $ eslint src/**/*.ts
  $ npm test
  ────────────────────────────────────────────────────────────────
▤ 读取   完成                                                   ▸
  ~/projectWorkspace/.../src/mock/park-business.ts          1–500
  ────────────────────────────────────────────────────────────────
▤ 读取   完成                                                   ▸
  ~/projectWorkspace/.../contract/index.vue                 1–500
  ────────────────────────────────────────────────────────────────
✎ 应用补丁   完成                                              ▸
  src/modes/interactive/components/tool-execution.ts        +18 -9
  ────────────────────────────────────────────────────────────────
◆ Subagent · 并行 · 3 个 Agent · 用户级                 完成 3/3  ▾
  ▸ reader    检查调用链                                      已完成
  ▾ worker    修改 Tool 卡片                                  已完成
    任务：统一 Tool 展示和点击行为
    结果：已修改 6 个文件
    ↗ 打开 Agent 会话
    ──────────────────────────────────────────────────────────────
  ▸ reviewer  检查回归                                          失败
  ────────────────────────────────────────────────────────────────
⌕ 搜索网页   完成                                              ▸
  TUI responsive terminal card design · 5 个来源
  ────────────────────────────────────────────────────────────────

≡ 正在整理调用关系…                             已完成 45/45 · 11m23s

╭──────────────────────────────────────────── LYStar Code ─╮
│ ❯                                                        │
╰─ upstream/gpt-5.6-sol · 思考 高(high) ───────────────────╯
Shift+Tab 思考强度  ·  Ctrl+O 展开  ·  / 命令
```

### 3.1 视觉纪律

- 整个聊天内容使用统一终端底色。
- Tool 成功、运行中和失败不再使用大块背景色。
- 左侧只放一个语义图标，不恢复“展开图标 + 语义图标”的双前缀。
- 展开状态使用最右侧 `▸/▾`，它是交互提示，不和语义图标挤在一起。
- 动作使用正文色或加粗，状态使用 success、warning、error、muted 角色。
- 目录使用 muted，文件名使用 accent，行号范围和警告使用 warning。
- 原始错误第一行默认可见，`Error:` 使用 error，后续原文保持 toolOutput 或 muted。
- 卡片之间只使用一条细分隔线，不使用空行、背景块、双线或白色高亮线。
- 用户消息可以继续保留已有背景，用来区分用户输入；Tool、Turn Summary 和系统过程卡片改成平面结构。

## 4. 卡片交互总契约

### 4.1 哪些内容算卡片

以下可见内容必须实现独立展开与收起：

- 每一个 Tool call。
- 多 Bash 命令分组。
- 每一个 Web Search 调用。
- Subagent 外层 Tool。
- Subagent 中的每一个 Agent 行。
- Turn Summary。
- Skill Invocation、Branch Summary、Compaction Summary 和 Custom Entry。
- 有长正文或长代码的 Assistant 消息。

普通用户消息和没有隐藏详情的短 Assistant 正文属于内容，不制造没有实际变化的假展开动作。

### 4.2 点击规则

- 鼠标左键按下和释放必须落在同一位置才触发动作，继续避免拖选误触。
- 点击卡片标题、摘要、参数摘要、错误预览或普通详情行，切换当前卡片。
- 点击分隔线不触发上一张或下一张卡片。
- OSC 8 链接区域优先打开链接，不触发卡片展开。
- Subagent 的“打开 Agent 会话”独占一行，点击该行打开会话，不切换 Agent 行。
- 点击一张卡片只改变该卡片，不改变相邻卡片和兄弟 Agent 行。
- `Ctrl+O` 继续作为全局动作，递归展开或收起当前已渲染的所有卡片。

### 4.3 展开状态

每张卡片都提供稳定状态键：

| 卡片 | 状态键 |
| --- | --- |
| Tool | `tool:<toolCallId>` |
| Tool Group | 由组内 Tool call ID 稳定组成 |
| Web Search | `web-search:<callId>` |
| Subagent Agent 行 | `subagent-run:<runId>:<agentId>` |
| Turn Summary | 当前轮次的稳定渲染 ID |
| Session Entry 卡片 | Session entry ID 或物化时稳定索引 |

主会话增加卡片展开状态表，Session 切换时重置，当前 Session 重建、主题切换、历史分页和流式更新时恢复。Subagent Session View 继续使用自己的状态表。

### 4.4 默认状态

- 单个 Tool 完成后默认收起。
- 运行中的 Tool 默认展示标题和必要的当前状态，不自动展开全部输出。
- 错误卡片即使收起，也展示第一条有效错误。
- 多 Bash 分组运行中展开摘要，完成后收起命令明细；失败摘要保持可见。
- Subagent 运行中默认展开 Agent 列表，完成后保留列表但 Agent 行默认收起。
- Web Search 默认收起来源，用户点击后只展开当前搜索。
- `Ctrl+O` 显式覆盖默认状态。

## 5. Tool 列表与灰色细线

### 5.1 新增共享列表容器

新增 `ToolExecutionStackComponent`，负责同一条 Assistant Tool call 批次的：

- 子 Tool 顺序。
- 子卡片渲染行范围。
- 点击路由。
- 嵌套卡片访问。
- 全局展开委托。
- Tool 之间的分隔线。

单个 Tool 不自行添加外部空白或外部分隔线。列表容器渲染结构固定为：

```text
Tool A 的全部可见行
灰色细线
Tool B 的全部可见行
灰色细线
Tool C 的全部可见行
灰色细线
```

灰线的上一行是上一张 Tool 的最后一行，下一行是下一张 Tool 的第一行，中间没有 `Spacer` 和空字符串。

### 5.2 分隔线规格

- 字符：`─`。
- 颜色角色：新增可选 `toolDivider`，内置 dark theme 使用低对比灰色。
- 自定义主题未定义 `toolDivider` 时回退到 `borderMuted`。
- 不修改 `borderMuted` 本身，避免连带改变用户要求保持不动的输入框边框。
- 左右各保留 2 个字符的缩进；极窄宽度下至少绘制 1 个字符。
- 使用 `visibleWidth()` 计算，不让 ANSI 色彩和 OSC 8 链接破坏宽度。
- 分隔线不属于任何子卡片的点击范围。
- Tool 运行状态变化时分隔线高度不变化，避免界面上下跳动。

推荐暗色值：

```text
toolDivider: #34383b
```

最终值以真实 PTY 截图为准，要求明显弱于正文、输入框边框和滚动条滑块。

### 5.3 消息间距

- Assistant 正文与首个 Tool Stack 之间保留一个空行。
- Tool Stack 内部没有空行。
- Tool Stack 与下一段 Assistant 正文之间保留一个空行。
- 展开详情内部按内容需要换行，但详情结束与分隔线之间不插空白行。

## 6. Tool 卡片结构

### 6.1 共享标题组件

新增 `ToolCardHeaderComponent`，内置 Tool 使用统一标题结构：

```text
<语义图标> <动作>  <状态>                <统计或耗时> <▸/▾>
<对象、路径、命令或查询摘要>
```

标题组件只负责显示，不承载 Tool 业务状态机。`ToolExecutionComponent` 继续从原 Tool result 和 `ToolRenderContext` 得到 running、success、error、cancelled 和 expanded。

### 6.2 信息优先级

宽度不足时按以下顺序保留：

1. 语义图标。
2. 动作。
3. 状态。
4. 展开提示 `▸/▾`。
5. 文件名、命令开头或查询主题。
6. 行号范围、增删统计。
7. 耗时、Provider、模型等次要元数据。
8. 完整目录。

不能先保留耗时，再把“失败”或文件名裁掉。

### 6.3 文件路径

新增宽度感知路径渲染 helper：

- `~` 和项目相对路径规则保持不变。
- 目录使用 muted。
- basename 使用 accent。
- 文件范围使用 warning，例如 `1–500`。
- 增删统计使用 success/error，例如 `+18 -9`。
- 路径超宽时从中间省略，优先保留路径开头、basename 和右侧统计。
- OSC 8 链接仍指向完整真实路径。
- 中文路径、空格路径、Windows 盘符和反斜杠都按可见宽度处理。

示例：

```text
~/projectWorkspace/.../controller/contract/index.vue   1–500
C:\Users\...\components\tool-execution.ts             +18 -9
```

### 6.4 展开内容

- Read：展开后显示读取内容、截断说明和图片。
- Bash：展开后显示完整可用输出和截断文件位置。
- Edit/Write/Apply Patch：展开后显示 Diff 或写入详情。
- Grep/Find/LS：展开后显示匹配或列表。
- Web Search：展开后显示当前搜索来源。
- Image Gen：收起时显示模型、保存路径和提示摘要，展开时显示图片与完整提示。
- 错误：收起时显示第一条错误，展开时显示完整错误和输出。

所有展开内容每行的 `visibleWidth` 不得超过传入宽度。

## 7. Bash 命令分组

多条 Bash 保留分组，但视觉改为平面结构。

### 7.1 运行中

```text
≡ 正在执行命令 · 已完成 4/8                         23.4s  ▾
```

展开后显示各命令卡片，各命令仍可单独展开。

### 7.2 全部成功

```text
✓ 命令执行完成 · 8 条                               31.2s  ▸
```

### 7.3 部分失败

```text
✓ 命令执行完成 · 6 条                               31.2s  ▸
✗ 命令 2 项失败                                             ▾
  └ Error: Command failed (exit code 1): eslint src/**/*.ts
```

这里仍是一个命令组组件：

- 成功摘要和失败摘要属于同一组。
- 点击摘要切换命令列表。
- 失败时第一条错误默认可见。
- 展开后每条命令是独立子卡片。
- 组外由 Tool Stack 绘制一条灰色细线，组内命令使用更短的缩进灰线。

## 8. Subagent 多级卡片

Subagent 采用三层结构，不使用背景卡片嵌套。

### 8.1 外层 Subagent Tool

```text
◆ Subagent · 并行 · 3 个 Agent · 用户级        完成 3/3  ▾
```

- 点击外层标题，显示或隐藏全部 Agent 行。
- 收起后只保留这一行。
- 外层状态和计数来自现有 `SubagentDetails`，不增加协议字段。
- 外层结束后由 Tool Stack 绘制普通 Tool 分隔线。

### 8.2 Agent 行

收起：

```text
▸ worker    修改 Tool 卡片                                  已完成
```

展开：

```text
▾ worker    修改 Tool 卡片                                  已完成
  任务：统一 Tool 展示和点击行为
  当前：正在运行测试
  结果：已修改 6 个文件
  ↗ 打开 Agent 会话
  ──────────────────────────────────────────────────────────────
```

每个 Agent 行改为独立 `InteractiveCard`：

- `SubagentRunComponent` 增加 `expanded`。
- 状态键使用 `runId + agentId`。
- 标题行和普通详情行切换当前 Agent 行。
- “打开 Agent 会话”单独占一行，该行返回 `openSubagent` action。
- 有持久 Session 时显示会话入口。
- 旧记录只有 legacy messages 时仍可打开只读会话。
- 没有任何会话内容时不显示空入口。
- 每个 Agent 行之间使用同一 `toolDivider` 颜色，但左右缩进比外层 Tool 分隔线多 2 个字符。
- 展开一个 Agent 不影响其他 Agent。
- 外层 Subagent 收起时保留各 Agent 的内部展开状态，再次展开后恢复。

### 8.3 点击路由

继续使用现有按行路由，不增加列级热区：

| 点击行 | 动作 |
| --- | --- |
| Subagent 外层标题 | 展开或收起 Agent 列表 |
| Agent 标题 | 展开或收起当前 Agent |
| Agent 普通详情 | 展开或收起当前 Agent |
| `↗ 打开 Agent 会话` | 打开当前 Agent 会话 overlay |
| Agent 详情里的 OSC 8 链接 | 打开链接 |
| Agent 分隔线 | 无动作 |

这样避免“点击 Agent 到底是展开还是打开会话”的冲突，也不需要依赖鼠标列坐标。

### 8.4 Agent Workbench

`/agents` 工作台继续保留键盘选择和宽屏双栏，不改成聊天卡片。主会话中的 Agent 行和 Workbench 共用：

- Agent 名称格式。
- 状态文字和颜色。
- 任务标题裁切。
- 图标和路径规则。

工作台本身的选择、steer、follow-up、abort 和会话打开逻辑不变。

## 9. 顶部状态与底部活动行

### 9.1 顶部状态

顶部改为：

```text
<路径>  │  <会话状态>  │  <上下文占用>
<灰色横线>
```

会话状态只来自现有运行状态：

- 等待输入。
- 思考中。
- 执行中。
- 重试中。
- 压缩中。
- 正在取消。

不生成任务阶段名。

### 9.2 底部活动行

`WorkspaceActivityBar` 从顶部移到输入框上方：

```text
≡ 正在读取 src/.../index.vue                 已完成 12/18 · 1m24s
```

- 只在活动中显示。
- 宽度不足时先去掉耗时，再去掉进度右侧信息，保留当前动作。
- 极小高度下它属于可选底部区，先让位于输入框和快捷栏。
- 输入框组件、品牌切口、模型信息和快捷栏不修改。

## 10. 宽度自适应

所有新组件必须只依赖 `render(width)`，不读取固定终端列数。

### 10.1 宽度等级

| 可用宽度 | 显示规则 |
| --- | --- |
| `>= 100` | 双行完整布局，右侧状态、统计和耗时右对齐 |
| `72–99` | 双行布局，路径中间省略，次要耗时可移除 |
| `50–71` | 状态紧跟动作，第二行保留 basename、范围和关键统计 |
| `< 50` | 单行或最小双行，保留图标、动作、状态、basename 和展开提示 |

### 10.2 稳定宽度规则

- 所有行在 ANSI 和 OSC 8 处理后仍满足 `visibleWidth(line) <= width`。
- 右侧 `▸/▾` 固定预留 1 列。
- 中文、宽字符、组合字符和长英文单词不允许覆盖下一段内容。
- 宽度变化只重新排版，不重置展开状态。
- resize 后重新建立每张卡片和每个 Subagent Agent 行的点击范围。
- 分隔线始终匹配当前宽度，不保留旧宽度缓存。

## 11. 三端统一内置图标

### 11.1 当前问题

当前 `ui-glyphs.ts` 直接按操作系统区分：

- macOS/Linux 使用 rich glyph。
- Windows 使用 ASCII fallback。

现在 Windows 默认交互窗口由 `lystar-terminal.exe` 托管，并通过环境变量 `LYSTAR_TERMINAL_HOST=1` 启动 `lc.exe --attached`。宿主固定加载 xterm.js 和 Noto Sans Mono CJK，当前 Windows UI smoke 已经展示 `✓ ✗ ✎ ⌕ ≡ ▶ ◆ →`。

因此默认 Windows 独立窗口继续强制 ASCII 没有必要。

### 11.2 新能力判断

图标 profile 改为按终端能力判断：

| 环境 | 图标 profile |
| --- | --- |
| macOS 交互终端 | rich |
| Linux 交互终端 | rich |
| Windows `lystar-terminal.exe` | rich |
| Windows `lc --attached` 或未知旧终端 | safe ASCII |
| 非交互输出、管道 | 不依赖图标表达关键信息 |

判断依据：

```text
process.platform !== "win32" -> rich
process.platform === "win32" && LYSTAR_TERMINAL_HOST === "1" -> rich
其余 Windows -> safe
```

不新增用户配置，不做不可靠的字体猜测。

### 11.3 内置图标表

图标全部从 `uiGlyphs` 获取，组件内不散落手写图标：

| 语义 | rich | safe |
| --- | --- | --- |
| 输入 | `❯` | `>` |
| 成功 | `✓` | `+` |
| 失败 | `✗` | `x` |
| 通用 Tool/Subagent | `◆` | `*` |
| 收起 | `▸` | `>` |
| 展开 | `▾` | `v` |
| 文件/读取 | `▤` | `F` |
| 编辑/补丁 | `✎` | `E` |
| 搜索 | `⌕` | `?` |
| 分组/活动 | `≡` | `=` |
| 运行 | `▶` | `>` |
| 打开会话 | `↗` | `>` |
| 分支详情 | `↳` | `>` |

rich 图标在 macOS、Linux 和 Windows 默认独立窗口使用相同 Unicode code point。不同终端字体可能让轮廓略有差异，但语义、占位宽度、颜色和位置一致。要做到像素级完全相同，需要 macOS/Linux 也改成 LYStar 自有终端宿主，本轮不做。

### 11.4 Windows 验证

增强现有 Windows terminal smoke：

- smoke 页面展示完整 rich 图标表。
- 检查每个图标单元格有实际像素输出。
- 检查 xterm 光标位置和 TUI `visibleWidth` 都认为每个 rich 图标宽度为 1。
- 保留 `windows-terminal-smoke.png` artifact 供人工检查 tofu 方框、错位和裁切。
- `ui-glyphs.test.ts` 覆盖 Windows host rich、Windows attached safe、macOS rich 和 Linux rich。
- Windows attached 模式继续验证 ASCII fallback，不因默认独立宿主而删除兼容路径。

## 12. Extension 兼容

### 12.1 默认 shell

`ToolExecutionComponent` 继续负责 Extension renderer 的外壳：

- 收起时至少显示 `renderCall`。
- 成功结果在收起时隐藏详细 `renderResult`。
- 错误结果在收起时保留第一条错误。
- 展开时显示完整 `renderResult`。
- 图片在收起时隐藏，展开时显示。
- 点击外层 Tool 切换 `context.expanded`。

这样即使第三方 Extension 自己没有实现交互卡片，也能获得统一的外层展开行为。

### 12.2 self shell

`renderShell: "self"` 继续保留，避免破坏图片、复杂组件和第三方自定义布局。外层 Tool 仍可点击并更新 `context.expanded`，但自定义 renderer 是否隐藏内部内容取决于它是否使用该状态。

LYStar 内置 Tool 必须全部符合本方案；第三方 self renderer 只保证协议兼容和点击状态传递，不能承诺视觉完全一致。

## 13. 文件级实施范围

### 13.1 新增组件

| 文件 | 责任 |
| --- | --- |
| `components/tool-execution-stack.ts` | Tool 列表、分隔线、子卡片范围和递归展开 |
| `components/tool-card-header.ts` | 两行标题、状态、右侧统计、路径宽度和 `▸/▾` |

文件名实施时可按现有目录命名习惯微调，但职责不能分散回各 Tool。

### 13.2 修改组件

| 文件 | 改动 |
| --- | --- |
| `components/interactive-card.ts` | 保持行级 action，补稳定状态和递归使用约束 |
| `components/tool-execution.ts` | 平面外壳、收起结果策略、子卡片 action 路由 |
| `components/tool-execution-group.ts` | 平面 Bash 摘要、成功/失败分组、组内子卡片 |
| `components/subagent-run.ts` | Agent 行变成独立卡片，增加详情和会话入口行 |
| `components/assistant-message.ts` | Web Search 使用统一标题和分隔规则，保持独立展开 |
| `components/turn-summary.ts` | 去背景、统一标题、宽度和点击提示 |
| `components/skill-invocation-message.ts` | 平面卡片和右侧展开提示 |
| `components/branch-summary-message.ts` | 平面卡片和右侧展开提示 |
| `components/compaction-summary-message.ts` | 平面卡片和右侧展开提示 |
| `components/custom-entry.ts`、`custom-message.ts` | 统一平面交互边界 |
| `components/lystar-workspace.ts` | 顶部状态分隔线和底部活动行布局 |
| `components/workspace-activity-bar.ts` | 参考图式活动摘要和宽度降级 |
| `ui-glyphs.ts` | rich/safe profile 和完整语义图标表 |
| `interactive-mode.ts` | 创建 Tool Stack、保存卡片状态、递归 `Ctrl+O`、活动行位置 |

### 13.3 内置 Tool renderer

需要迁移到共享标题和路径规则：

```text
read
write
edit
bash
grep
find
ls
apply_patch
image_gen
subagent
```

Tool 名、参数、执行逻辑、结果 details 和 Session 记录不变。

### 13.4 主题

- `theme-schema.json` 增加可选 `toolDivider`。
- 内置主题补充该值。
- 自定义主题缺失时回退 `borderMuted`。
- 不修改输入框使用的 `borderMuted`。
- 不新增渐变、阴影、发光和背景纹理。

## 14. 实施顺序

1. 增加 `toolDivider` fallback、图标 profile 和对应单元测试。
2. 实现共享 Tool header 和 Tool stack，先用测试 fixture 固定无空行灰线与点击范围。
3. 把 `interactive-mode.ts` 的 `Spacer + Tool` 组合改为每个 Assistant Tool 批次一个 stack。
4. 迁移内置 Tool renderer，完成路径、状态、错误和展开内容布局。
5. 重做 Bash group，覆盖运行、全成功、部分失败和取消。
6. 重做 Subagent 外层与 Agent 行多级交互。
7. 将活动条移到输入框上方，调整顶部状态；输入框组件不改。
8. 迁移 Turn Summary、Skill、Branch、Compaction、Custom Entry 和 Web Search。
9. 完成宽度、状态恢复、历史重放和全局展开测试。
10. 完成 Linux PTY、Windows 独立宿主截图和可用平台实机验收。

每一步都必须保持现有测试通过，不保留新旧两套 Tool 展示路径。

## 15. 自动测试

### 15.1 卡片交互

- 每个 Tool 标题和详情行点击只切换当前 Tool。
- 分隔线点击无动作。
- 点击时按下和释放位置不同不触发。
- 链接优先于卡片。
- 相邻卡片互不影响。
- 卡片状态在流式更新、resize、主题切换和 Session 重建后保持。
- `Ctrl+O` 递归处理 Tool group、Web Search、Subagent 外层和 Agent 行。

### 15.2 分隔线

- 每个 Tool 后恰好一条分隔线。
- 分隔线上下没有空字符串行。
- 分隔线使用 `toolDivider`。
- 宽度 120、100、80、72、60、50、40 下长度正确。
- 展开和收起后分隔线位置随内容变化，但不出现重复线或空白。

### 15.3 Subagent

- 外层收起隐藏全部 Agent 行。
- 外层展开恢复 Agent 行原有展开状态。
- 每个 Agent 行独立展开。
- “打开 Agent 会话”只打开对应 Agent。
- legacy messages 打开只读会话。
- running、waiting、succeeded、failed、cancelled 文案和颜色正确。
- 多层 Subagent 会话继续递归打开。
- 运行过程刷新后 Agent 行状态不丢失。

### 15.4 宽度

- 所有可见行 `visibleWidth <= width`。
- 长 Unix 路径、Windows 路径、中文路径和空格路径保留 basename。
- 右侧 `▸/▾` 不被路径覆盖。
- 状态、错误和文件名不会因统计信息被裁掉。
- resize 后点击行仍命中正确卡片。

### 15.5 图标

- macOS/Linux profile 使用 rich 图标。
- Windows host profile 使用同一 rich 图标。
- Windows attached profile 使用 safe 图标。
- 每个图标的 `visibleWidth` 符合单元格约束。
- 组件只能使用 `uiGlyphs`，测试扫描禁止内置组件散落同义硬编码图标。

## 16. 真实验收

### 16.1 Linux PTY

至少覆盖：

- `120×36` 完整布局。
- `100×30` 参考图接近布局。
- `80×24` 常规终端。
- `80×8` 极小高度，输入框和快捷栏仍固定。
- resize 往返。
- 鼠标逐卡展开、分隔线点击、链接点击。
- 多 Bash、多个 Read、Apply Patch、Web Search 和 Subagent 混合会话。
- 流式运行中和完成后。

### 16.2 Windows 独立宿主

使用实际 `lystar-terminal.exe`：

- rich 图标与 macOS/Linux 使用同一 code point。
- Noto Sans Mono CJK 下没有 tofu 方框。
- 中文、图标、细线和路径单元格不偏移。
- 鼠标点击、resize、滚动和输入法不受影响。
- 截图上传为 CI artifact。

### 16.3 Windows attached

- `lc --attached` 继续使用 safe 图标。
- PowerShell、CMD、Windows Terminal 或 IDE 字体差异不会造成关键语义缺失。
- attached 是兼容入口，不作为默认 Windows 视觉基准。

### 16.4 macOS

- 在可用 macOS 终端检查 rich 图标、Box Drawing、中文宽度和鼠标。
- 没有实机证据时，只报告 render 测试和构建结果，不宣称 macOS 实机视觉通过。

## 17. 验证命令

```bash
cd packages/coding-agent
npx vitest --run \
  test/ui-glyphs.test.ts \
  test/tool-execution-component.test.ts \
  test/tool-execution-group.test.ts \
  test/assistant-message.test.ts \
  test/subagent-extension.test.ts \
  test/subagent-session-view.test.ts \
  test/task-workbench-components.test.ts \
  test/lystar-workspace.test.ts \
  test/interactive-tui.test.ts

cd ../..
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
git diff --check
```

Windows 继续运行：

```powershell
.\scripts\build-windows-release.ps1 -Repository "<releaseRepository>"
.\scripts\test-windows-terminal.ps1 -BundleDir "<bundle>" -ScreenshotPath "<screenshot>"
```

可见 TUI 修改必须完成真实 PTY 和 Windows host 截图，自动测试不能替代实际视觉检查。

## 18. 完成标准

以下条件全部满足才算完成：

1. 每一个内置 Tool 卡片都能独立点击展开和收起。
2. 多 Bash 组和组内命令都能独立操作。
3. Web Search 继续按调用独立展开。
4. Subagent 外层和每个 Agent 行都有独立展开状态。
5. Agent 会话入口不会和 Agent 行展开动作冲突。
6. `Ctrl+O` 能递归展开或收起所有可见卡片。
7. 每个 Tool 后只有一条低对比灰线。
8. 灰线上下没有空白行。
9. 灰线不呈现白色高亮，不影响输入框边框。
10. 所有卡片按传入宽度排版，任意行不越界。
11. 长路径优先保留 basename、范围和增删统计。
12. Tool 不再使用成功、运行中和失败的大面积背景卡片。
13. 顶部状态和底部活动行符合本方案，输入框保持现状。
14. macOS、Linux 和 Windows 默认独立宿主使用同一组 rich 图标。
15. Windows attached 保留 safe fallback。
16. Session JSONL、Provider 数据、Tool 名、Extension API 和 Subagent 执行协议不变。
17. 聚焦测试、Coding Agent 全量测试、静态检查、离线构建和真实终端验收通过。

## 19. 明确边界

- 本轮不做左侧时间线。
- 本轮不生成任务阶段标题。
- 本轮不做发光、阴影、渐变和装饰背景。
- 本轮不修改输入框。
- 本轮不新增用户可配置的图标主题或卡片样式开关。
- 本轮不修改 Subagent 运行、进程终止、递归禁用、Session 写入和结果 details。
- 本轮不修改第三方 Extension API。
- 本轮不承诺第三方 `renderShell: "self"` renderer 和内置 Tool 达到完全一致的内部排版。
- 本轮不为了视觉统一删除错误、路径、统计、链接、图片、Diff 或 Agent 会话入口。

Yean 确认本文后，再开始修改功能代码和测试。
