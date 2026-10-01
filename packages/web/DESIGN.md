# LYStar Code Web 设计规范

本文记录 `packages/web` 已经落地的设计决定：任务与承载位置、token 使用、组件选择、状态文案、响应式与可访问性要求。新增页面或改动现有界面时先读本文，再改代码；源码与本文冲突时以源码为准，并同步修正本文。

## 1. 适用范围与事实源

| 范围 | 说明 |
| --- | --- |
| 适用 | `packages/web` 的页面结构、组件归属、token、状态文案、响应式、可访问性 |
| 不适用 | Gateway、Runtime、协议字段语义、会话与租约业务规则，见 `docs/development/web-overview.md` 和 `docs/development/web-architecture.md` |
| 实现入口 | `src/main.tsx` → `src/App.tsx` → `src/components/workbench.tsx`，状态入口 `src/state/use-workbench.ts` |

事实源优先级：源码与协议 Schema > 本文 > 设计决策稿。

- `src/styles/tokens.css`：颜色、排版和布局变量的事实源。
- `packages/web-protocol/src/schemas.ts`：状态枚举的事实源。
- `plan/pi-web-ui-spec.md`：设计判断来源。该文件的 Vue / shadcn-vue 技术栈表述已过时，当前实现是 React + TSX，只沿用其中仍然成立的设计判断。
- `plan/lystar-code-web-ui-local/`、`plan/lystar-code-web-ui-refinement/`：工具活动、图片结果和详情载体的确认稿。

## 2. 使用者与主要任务

使用者是通过浏览器控制本机 LYStar Code 的开发者，服务对象是正在读 Agent 执行过程并随时下达新任务的人。

- 主要任务：连续阅读 Agent 正文、发送与停止任务、判断当前运行状态。
- 高频操作：切换项目和会话、发送或停止、展开工具活动、打开文件与 Diff、进入子会话或协作房间。
- 需要同时比较的内容：正文与工作过程、活动工具与其原始输出、会话列表与当前会话状态。

页面为高密度操作界面，不承担营销、引导和内容消费任务。不要为它加入 Hero、指标卡、渐变背景或装饰性图表。

## 3. 视觉基础

### 3.1 技术栈

React 19 + TypeScript、Vite 8、Tailwind CSS 4、CSS 语义变量、shadcn/ui（new-york、neutral、CSS variables，源码在 `src/components/ui/`）、Radix 原语、Lucide 图标、CVA 变体。AI 展示组件在 `src/components/ai-elements/`，工作台组件在 `src/components/workbench/`。

新页面复用这些既有组件与 token，不引入第二套设计系统、组件库或图标库。

### 3.2 颜色 token

组件只消费语义变量，不在组件里写十六进制色值。`src/styles/tokens.css` 定义两层：项目语义变量（`--bg`、`--line`、`--text`、`--brand` 等）与 shadcn 映射（`--background`、`--primary`、`--ring` 等）。

| 变量 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#151515` | 页面主背景 |
| `--bg-elevated` | `#ffffff` | `#1e1e1e` | 弹窗、菜单、浮层 |
| `--bg-soft` | `#f5f5f5` | `#292929` | 次级表面：用户消息、代码底、占位 |
| `--bg-strong` | `#eeeeee` | `#343434` | 终端输出底色 |
| `--line` | `#eeeeee` | `#3b3b3b` | 分隔线、普通边框 |
| `--line-strong` | `#d7d7d7` | `#555555` | 输入框边框 |
| `--text` | `#111111` | `#f4f4f4` | 正文与主要文字 |
| `--text-muted` | `#767676` | `#b0b0b0` | 次要文字、时间、路径 |
| `--brand` | `#1677ff` | `#7db7ff` | 链接、焦点、选中强调、列表符号 |
| `--accent` | `#f3f3f3` | `#2b2b2b` | 悬停表面 |
| `--accent-soft` | `#f8f8f8` | `#252525` | 正文引用块 |
| `--success` | `#087f3e` | `#46ce83` | 成功、Diff 新增 |
| `--warning` | `#a95800` | `#f0a45b` | 警告、等待 |
| `--danger` | `#c52b22` | `#ff7168` | 错误、Diff 删除 |

使用规则：

- 蓝色只做小面积强调：焦点环、链接、图标、极窄的活动标识。不给大面积区域上品牌色。
- 状态色不能单独承载信息，同时给出图标或文字。
- `--text-faint`、`--text-disabled`、`--accent-strong`、`--sidebar-width` 目前没有组件引用，属于预留；项目栏宽度由 `src/components/workbench/constants.ts` 的 `SIDEBAR_MIN_WIDTH / DEFAULT_WIDTH / MAX_WIDTH`（280 / 392 / 560）控制，不读 CSS 变量。
- 状态色在终端输出与 Diff 中通过 `color-mix` 降低浓度，避免整块高饱和色。

### 3.3 主题

三档：跟随系统、浅色、深色（`src/components/workbench/settings/appearance.tsx`）。`applyTheme` 把 `data-theme` 设为 `"" | "light" | "dark"`，空值表示跟随系统，选择写入 `localStorage`。

- 浅色与深色分别给值，深色不是浅色反相。
- Logo 有浅色和深色两版，通过 `data-theme` 切换，媒体查询只覆盖跟随系统的情况。
- 已知约束：Tailwind 的 `dark` 变体被重定义为 `data-theme="dark"`（`src/styles.css`）。选择「跟随系统」时，系统深色只切换 token 值，`dark:` 工具类不生效。写新样式时优先只用 token，不用 `dark:` 变体区分主题。

### 3.4 字体与排版

- 界面字体：`Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"`，不下载 Web Font。
- 界面字号常用层级：`text-xs` 12px（辅助、状态、计数）、`text-sm` 14px（控件、次级说明）、`text-base` 16px（顶栏标题、对话框标题）、`text-lg` 18px（顶栏标题 sm 以上）。设置页头是例外，使用 `text-2xl sm:text-4xl`，只用于设置页内标题。
- 代码、路径、命令、模型 ID 使用等宽字体。
- 正文：`.sd-prose` 为 `0.9375rem / 1.78`，行内代码、表格和引用块沿用 `src/styles/prose.css`。
- 项目栏列表项固定 `13px`；工作区导航栏按钮文字 `10px`（`src/styles.css` 的 `.workspace-navigation-rail` 覆盖）。
- 会话标题单行截断，工具标题单行截断，完整内容通过展开或可访问名称提供。

### 3.5 间距、圆角、阴影与图标

- 圆角基准 `--radius: 0.625rem`，派生 `--radius-sm/md/lg/xl`；界面控件默认 `rounded-md`。
- 输入区是例外：`src/styles.css` 把 `.prompt-input-shell` 内的 input-group 设为 `border-radius: 48px`，与排队消息区拼成一个整体。不要把其他控件也改成胶囊。
- 审阅工作区浮层面板使用 `rounded-[28px]` 和 `0 12px 36px` 阴影，是页面内唯一的浮起面板样式。
- 阴影只给浮层：输入区 `0 2px 12px rgb(0 0 0 / 0.05)`、覆盖面板 `shadow-lg`。分组靠边框和背景差，不靠阴影。
- 图标来自 Lucide，默认 `size-4`（16px），小图标 `size-3`，导航栏图标 18px。图标按钮命中区用 `size-8`、`size-9`、`size-10`，导航栏按钮 `h-14 w-14`。
- 滚动条：`10px` 宽，滑块用 `--line`，悬停用 `--text-muted`，轨道透明。

### 3.6 动效

GSAP，动效曲线集中在 `src/lib/ease.ts` 与 `src/lib/gsap-motion.ts`。

| 用途 | 组件 | 参数 |
| --- | --- | --- |
| 区域入场、会话切换 | `GsapReveal` | 默认 `distance 12`、`duration 0.32s`、`power2.out`；实测用法 8–18px、0.24–0.34s |
| 展开收起 | `GsapCollapsibleContent` | 默认 `duration 0.18s`，高度加透明度 |
| 按下反馈 | `SPRING_PRESS` | `stiffness 500 / damping 30 / mass 0.6` |

规则：

- 项目里有两套动效库：GSAP 是主实现，`motion/react`（`components/agents/image-generation.tsx`）只用于图片生成结果的入场与状态切换。新增动效优先用 GSAP 组件，不在同一批界面里混用两套。
- 只为切换会话、展开内容、面板切换和新建消息加动效，不做循环装饰动画。
- `runGsapMotion` 统一处理 `prefers-reduced-motion: reduce`，此时不播放位移。`src/styles.css` 另有全局降级规则覆盖 CSS 动画。
- 滚动跟随不触发重排动画；流式内容靠增量渲染，不做逐 token 的整段闪烁。

## 4. 布局

### 4.1 壳层

页面是 `h-dvh` 的固定三段式外壳，滚动只发生在对话区和面板内部。

```text
┌──────┬───────────────┬──────────────────────────┬──────────────┐
│ 导航 │ 项目与会话栏  │ 顶栏：标题 / 副标题 / 审阅入口           │
│ 64px │ 280–560px     ├──────────────────────────┤ 审阅工作区   │
│      │               │ 对话区（虚拟滚动）        │ ≥1280 并排   │
│      │               ├──────────────────────────┤ <1280 抽屉   │
│      │               │ 输入区                   │              │
└──────┴───────────────┴──────────────────────────┴──────────────┘
```

- 导航栏 `w-16`，项目栏默认 392px，可拖动分隔条调整，范围 280–560。
- 顶栏 `min-h-16`，顶部留 `env(safe-area-inset-top)`。
- 对话区与输入区共用 `--conversation-width: 1280px` 居中容器，审阅工作区不压缩正文阅读宽度。
- 页面不出现整体滚动条。

### 4.2 断点

断点以代码中的媒体查询为准，不另设规范值。

| 条件 | 布局 |
| --- | --- |
| `< 768px` 或单视口 | 无导航栏与项目栏，主区占满；项目与会话在 `MobileProjectRailDialog` 中打开 |
| `≥ 768px` 或 `(horizontal-viewport-segments: 2)` | 导航栏常驻；项目栏打开时为覆盖层，主区 `inert`，点遮罩或按 Escape 关闭 |
| `≥ 1280px` | 项目栏并排且可拖动；审阅工作区并排在右侧，宽度 `min(420px, 34vw)`；审阅工作区改为右侧抽屉，最大 `min(560px, 100vw)` |

折叠屏按双视口处理：`(min-width: 768px), (horizontal-viewport-segments: 2)` 同时决定导航形态和设置侧栏宽度。

### 4.3 覆盖层

同一时刻只打开一个主要覆盖层。全部覆盖层：项目栏、审阅工作区抽屉、设置、文件预览、Git Diff、目录选择、项目重命名、会话重命名、项目组新建与选择、会话管理、Agent 会话、Git 凭据授权、UI Request、产品更新、连接恢复遮罩、项目栏窄屏抽屉。连接中断时 `ConnectionRecoveryOverlay` 阻断全屏。

设置是全屏对话框（`inset-0 h-dvh w-screen`），左侧分类导航在 `md` 以上竖排，以下为横向滚动标签；内容区最大宽度 1120px，智能体页放宽到 1680px。

Toast 用 `fixed` 定位在顶栏下方：`top-[calc(env(safe-area-inset-top)+5rem)]`、`right-4`、宽 `min(420px, 100vw-2rem)`，`rounded-xl` 并带阴影。它低于模态和菜单层级，不承载当前任务的唯一错误——重要错误留在对应工具、会话或连接区域。

### 4.4 页面与路由

没有路由层：`src/App.tsx` 不使用 react-router，导航靠工作区模式（会话 / 智能体协作）、会话选择和对话框完成，状态全部在 `state` 里。不要为单个功能新增 URL 或页面历史；需要独立链接的任务先确认是否由后端已有能力支撑。

## 5. 区域规范

### 5.1 工作区导航栏

`WorkspaceNavigationRail`：品牌标识 → 展开项目栏 → 工作区类型（会话 / 智能体协作）→ 设置快捷入口（技能、智能体、模型与认证）→ 设置 → 退出。两个工作区类型是互斥视图，用 `aria-pressed` 表示当前项，不引入第三套导航概念。快捷入口直接打开对应设置页签，不承载新功能。

### 5.2 项目栏与会话列表

- 顶部是搜索（项目、会话共用一个输入）、工作区类型切换和新建入口。
- 项目按项目组组织；组可拖放项目、会话有分页（每页 7 条）和虚拟列表。
- 会话列表用 `WorkbenchTabBar` 分三档：全部、进行中、已完成。分档是同一资源的互斥视图，用 Tabs 而不是三张列表。
- 会话行：名称单行截断（最长 40 字符）、相对时间、未读标记、运行标记、右键菜单（重命名、置顶、删除）和子会话展开。项目名称和状态在触摸设备上进入正常布局，不依赖悬停（`src/styles.css` 的 `(hover: none)` 分支）。
- 空状态给一句结果（暂无会话、未分组项目），不放说明卡片。
- 未读状态跨标签页同步：`state/use-workbench.ts` 用 `BroadcastChannel` 广播会话已读时间。多个标签打开同一页面时，不得把未读判定收回单个组件的局部状态。
- 项目栏底部是 `RailFooter`：连接状态用 `1.5`（6px）圆点加 `text-xs` 标签，圆点分别取 `--success` / `--warning` / `--danger`，整体带 `role="status"` 和 `aria-label="连接状态：X"`。它随是否带导航栏切换两种布局：有导航栏时只保留更新控制和连接状态（偏好设置、退出已在导航栏），无导航栏时额外提供「偏好设置」和「退出」。

### 5.3 顶栏

左侧当前对象标题（会话名或协作房间名）与副标题（项目名）；会话切换时用 `GsapReveal` 换标题。协作模式额外显示成员头像组和成员数（最多 4 个头像加总数）。右侧是审阅工作区入口，`aria-expanded` 反映状态。连接状态和产品更新在项目栏底部 `RailFooter`，顶栏不重复。

### 5.4 对话区

虚拟滚动列表（react-virtuoso），顶部加载更早消息，底部跟随流式输出，用户离开底部时出现「回到最新消息」按钮。相邻活动行间距为 0，正文行间距 `DEFAULT_TRANSCRIPT_GAP = 12px`。

内容层级，从重到轻：

| 层 | 承载 | 规则 |
| --- | --- | --- |
| 工作过程 | `work-process` 折叠组，默认收起 | 只放工具、Hook、Extension 活动，不放正文结论 |
| 结果分界 | `result-boundary` 分隔线 | 工作过程与最终结果之间只有一条分隔线 |
| Agent 步骤 | `AgentStepContent` 折叠块 | 运行中默认展开，完成后保留用户选择；展开时标题吸顶 |
| 正文消息 | `TranscriptMessageView` | 用户消息 `max-w-[84%]` 右对齐、使用 `--bg-soft`；Agent 正文不套卡片 |
| 工具活动 | `ToolBatch` | 单工具单行，多工具成组；相邻工具不重复画线 |
| 压缩、Hook、Extension | `CompactionCard`、`HookActivityGroup`、`extension-activity-card` | 平面容器，保留真实状态文案 |

消息动作（复制、编辑、删除）默认 `opacity-0`，悬停或聚焦时显示，不常驻占位。用户消息附附件缩略图与投递状态；Agent 消息下方显示本次耗时，两者都是 `text-xs` 次要文字。

用户消息里的引用由 `prompt-token` 高亮：`@[路径]`、`$[技能]`、`/skill:名称`、`@"文件名"`、`@路径` 归类为技能或文件，只改样式不改原文，点击后走已有的打开入口。运行中还有 `live-elapsed-header` 显示实时耗时，回合结束交回下方「本次耗时」。

首屏没读到记录时显示四条左右交替的脉冲骨架（`h-14/h-12 animate-pulse rounded-2xl bg-muted/35`）而不是空白，加载完成后换成真实内容，不在骨架上叠加提示卡片。

### 5.5 工具活动

- 状态文案由 `ToolBatchState` 决定：准备中（`preparing` 时覆盖运行中）、运行中、已排队、已完成、出错、已取消、已中断。状态不能互相合并或用样式暗示。
- 标题行保持单行：工具图标（按工具名映射）、动作摘要、状态文案、耗时、展开符。
- 详情按工具类型分支：命令（`command-presentation` 解析动作图标、ANSI 输出着色）、文件与 Diff、网页搜索来源、图片生成、子会话。详情里提供打开文件、打开子会话等已有入口。
- 工具图标映射在 `tool-batch.tsx` 的 `toolIcon`；新增工具时在此登记，不在组件里散落条件。
- 工具状态由 `adapters/live-tool-view-model.ts` 把协议 `ToolActivityState` 映射为展示状态。展示层不自行推断状态。
- 图片生成结果用 `components/agents/image-generation.tsx`（引自 beUI，使用 `motion/react` 动效），由 `tool-batch.tsx` 接入；其余已安装的 beUI / AI Elements 能力没有接入工作台，见第 8 节。

### 5.6 代码、Diff 与终端输出

- 代码块由 `code-block` / `code-block-view` 渲染，语言与文件名作标题，复制按钮在标题行右侧，代码区内部滚动，不产生页面横向滚动。
- 深色主题使用 shiki 的 `--shiki-dark` 变量。
- Diff 行用 `--success` / `--danger` 以 16% 浓度标记新增与删除，未改行不铺底色。
- 终端 ANSI 输出映射到项目语义色（`src/styles.css` 的 `.tool-command-output`），不引入 ANSI 原色。

### 5.7 输入区

输入区是常驻底部区域，容器与对话区同宽。

- 结构：附件与排队消息区在上、输入框居中、底部一行是能力菜单、模型与思考强度、快速模式、发送方式、发送 / 停止。
- 排队消息与输入框属于同一编辑面板，`src/styles.css` 把两者圆角拼合并共用边框；不要给排队消息单独卡片样式。
- 发送 / 停止复用同一圆形主按钮；发送方式（立即调整、完成后发送）在 Popover 中选择。
- 模型选择使用带搜索的 `ModelSelector`；思考强度下拉只展示模型实际支持的档位（`VISIBLE_THINKING_LEVELS`）。
- 运行中时输入框仍可输入，用于 steer 与 follow-up；草稿只存在浏览器，不写入会话。
- 编辑历史 Prompt 时输入区内联出现，取消丢弃草稿并把焦点交还原消息。
- 协作模式在输入区上方显示正在工作的子会话胶囊，支持 `@` 补全成员。
- 键盘规则（`ai-elements/prompt-input.tsx`）：`Enter` 发送，提交前先检查提交按钮是否 `disabled`；`Shift + Enter` 换行；`Ctrl / Cmd + Enter` 优先提交带 `data-prompt-submit-mode="steer"` 的发送按钮，没有则提交整个表单，即在运行中默认送入 steer；组合输入（`isComposing` / `nativeEvent.isComposing`）期间三种发送都不触发；输入框为空且存在附件时 `Backspace` 删除最后一个附件。设置改变发送键时要在 Tooltip 或帮助中同步说明。
- 斜杠命令：只展示有执行入口的内置命令，白名单在 `state/composer-commands.ts` 的 `WEB_COMMAND_NAMES`（`/compact`、`/new`、`/export`、`/model`、`/thinking`、`/name`、`/settings`、`/changes`、`/resume`、`/fork`、`/tree`、`/trust`、`/session`、`/hotkeys`、`/reload`）。任务运行中执行部分命令要先提示“请等待当前任务结束或停止任务后执行此命令”；插件、模板与 Skill 命令不受该表限制，不得在前端另行拦截。
- 底部一行（`PromptInputFooter`）分两组工具：一组是 `ComposerSessionStats` 会话统计（TPS、缓存命中、输入、输出、最近输出速度、累计输出），另一组是模型、思考强度、快速模式、发送方式、发送 / 停止按钮和 `ContextRing` 上下文使用率环（`aria-label="上下文使用率 N%"`）。缺失值显示 `—`，不填补假数据。
- 附件支持拖拽与点击上传，带上传进度（文件名、百分比、阶段）；内联编辑历史 Prompt 时不启用全局拖拽。文件树也支持拖拽文件到目录上传。
- 图片附件超过 8MB（`MAX_IMAGE_PREVIEW_BYTES`）时不生成内联缩略预览，附件仍可发送。不要把“没缩略图”当成上传失败去修。

### 5.8 审阅工作区

统一入口是顶栏的「审阅工作区」，四个页签视图加一个由工具进入的子会话视图：

| 视图 | 内容 |
| --- | --- |
| 文件 | 项目文件树、搜索、上传、新建、重命名、下载 ZIP；文件内容走文件预览对话框 |
| Git | 仓库选择、变更与历史两个互斥页签、暂存与提交、分支管理、凭据授权提示 |
| 运行 | 运行中的任务、操作列表与结果明细（对应 `WebOperation` 状态） |
| 分支 | 会话树节点关系与预览 |
| 子会话 | 无页签入口，由工具活动中的子会话入口打开（`openSubagent`），展示对应子会话的快照与 Transcript |

### 5.9 文件、Diff 与图片预览

- 文件预览统一走 `FilePreviewDialog`：桌面 `h-[min(88vh,900px)]` / `w-[min(94vw,1200px)]`，窄屏全屏。内含 Markdown 视图与编辑视图、代码高亮、图片与 Office 预览，动作是打开、复制、保存、下载、关闭。
- 文件编辑使用 Monaco（`monaco-file-editor.tsx`、`settings/monaco-markdown-editor.tsx`），不要为预览再开一层内嵌编辑器。
- 图片查看器 `ResourceImageViewer`：缩放范围 0.5–3 倍，显示当前百分比，支持鼠标拖动、触摸捏合、下载和多图切换，且被 Composer 附件和文件预览共用。共用就意味着它的外观改动会同时影响这三处，加分支而不是全局覆盖。
- Git Diff 走独立对话框（`GitDiffDialog`），会话正文只保留摘要入口。

### 5.10 智能体协作

协作是与会话互斥的工作区模式，共享同一套外壳、输入区和状态机制。

- 协作栏：按项目列出房间，支持搜索与新建（选择项目、填写房间标题、选择成员）。
- 房间内两个互斥页签：对话、看板。
- 对话：成员发言按成员标识呈现，可定向派发任务，可 @ 成员。
- 看板：四列固定为待认领、进行中、阻塞、已完成；任务详情在对话框中编辑标题、描述、认领人、状态与评论。
- 成员在页面中的显示名用昵称，缺失时用 `collaborationAlias` 生成的稳定别名；owner 显示为「你」。

### 5.11 设置

页签按个人、工作区、系统、其他分组，支持搜索；「系统授权」页签只在浏览器支持对应能力时出现。页签标题下的一段说明描述该页的真实作用，不重复标题。每个页签内部自行组织表单，不套指标卡。

外观页同时承载主题选择、应用安装和推送通知开关（`settings/appearance.tsx`）。推送的注册失败和权限被拒绝是不同状态：被阻止时提示去浏览器网站设置允许通知，失败时用 `role="alert"` 显示具体原因，不笼统一句“开启失败”。产品更新控制在 `RailFooter` 检查与触发，更新会重启 Web 服务，描述必须写明运行中会话会结束、页面会自动恢复。

「系统」页维护品牌：应用名与 Logo 存到本机配置，通过 `state.branding` 下发，`document.title` 和各处标题随之变化。界面标题和 Logo 一律取 `state.branding`，不写新的字面量；已知例外见第 7 节。

### 5.12 鉴权与错误恢复

- 需要密码时 `TokenGate` 接管全屏，说明密码来自 `web-config.json`，不做营销布局。
- UI Request（Runtime 发来的 `select` / `confirm` / `input` / `secret`）用 `UiRequestDialog`：一次只处理队首一条，`onOpenChange` 不响应，不能靠点遮罩或 Esc 跳过；`secret` 用密码输入并提示不会显示，其余用文本输入，提交按钮无内容时禁用；页面不展示请求 ID 和协议字段。
- 工作台按区域设置错误边界（`StabilityBoundary`）：应用根、项目栏、对话区、输入区、审阅工作区、文件预览。每个边界的降级文案说明「哪些区域仍可用」和恢复动作，不显示堆栈给普通用户。

## 6. 状态词表

界面文案按下表映射，不在组件内另造说法。同一枚举在所有区域使用同一组词；不同枚举各保留自己的映射，不互相替换。

| 来源 | 枚举 | 界面文案 | 映射位置 |
| --- | --- | --- | --- |
| 会话活动 `SessionActivity` | idle / running / waiting_for_input / completed / failed / aborted / interrupted | 空闲 / 进行中 / 等待回复 / 已完成 / 失败 / 已停止 / 已中断 | `collaboration-session.tsx` 的 `collaborationStatus` |
| 工具活动 `ToolActivityState` | preparing / queued / running / success / error / cancelled / interrupted | 准备中 / 已排队 / 运行中 / 已完成 / 出错 / 已取消 / 已中断 | `ai-elements/tool-batch.tsx` 的 `statusLabels`，`preparing` 单独覆盖运行中 |
| 操作 `WebOperation.status` | accepted / running / waiting_for_input / completed / failed / aborted | 已接收 / 执行中 / 等待输入 / 已完成 / 失败 / 已取消 / 已停止 | `run-panel.tsx` 的 `operationStatusLabel` |
| 子会话状态 | queued / running / waiting / succeeded / failed / cancelled | 排队中 / 运行中 / 等待输入 / 已完成 / 失败 / 已停止 | `subagent-panel.tsx` |
| 协作房间任务 | todo / doing / blocked / done | 待认领 / 进行中 / 阻塞 / 已完成 | `room-task-board.tsx` |
| 连接 | 离线 / 重连中 / 已连接 / 未连接 | 标题与说明成对出现 | `state/connection-recovery.ts` 的 `connectionPresentation` |

会话被其他进程占用时进入只读，界面说明占用来源并保留重试入口。工具的取消与中断、操作的取消与停止是不同状态，不用同一个词覆盖。

## 7. 内容准入与字段边界

- 展示前先判断它帮助使用者完成哪项理解或操作。没有用途的字段不展示，组件有插槽也不构成展示理由。
- 不在普通界面展示：Session ID、Lease / Operation ID、请求 ID、协议帧与调试值、凭据内容、内部内容引用。这些字段继续用于请求、选择和内部处理。
- 保持原值展示：模型 ID、Provider、Tool 名、命令、路径、Git 分支、文件名。这类产品需要它们判断操作，不能因含技术词而删除或改写。
- 报错时展示接口返回的真实原因，不生成未经证实的原因说明；错误原文可复制，不被模型改写。
- 空状态说明当前能做什么，不添加没有后端能力的「立即创建」入口。
- 空跑错误、假指标、示例编号不进入页面；示例数据只出现在测试和确认稿中。
- 内置界面文案使用中文；模型 ID、Provider、Tool 名、路径、命令、分支、协议字段和错误原文保持原值，不做中文化。产品名与 Logo 取 `state.branding.name` / `branding.logo`（默认值 `LYStar Code`，见 `state/workbench-state.ts`）。当前仍硬编码产品名的只有更新提示、系统权限提示和 Git 钥匙串提示，新增文案不要再扩散字面量。

## 8. 组件与状态归属

| 目录 | 负责 | 不负责 |
| --- | --- | --- |
| `components/ui` | 基础交互原语，按 shadcn 约定维护 | 业务语义 |
| `components/ai-elements` | AI 内容展示：消息、工具、代码、图片、输入组件 | 读取会话数据、发起请求 |
| `components/workbench` | 工作台区域与页面编排 | 复制服务端规则、直接拼协议 |
| `components/motion` | Tab 选中项的滑动高亮（`ExpandableActionBar`） | 不作为通用动效容器 |
| `state` | 工作台状态、动作与状态转换 | 组件临时状态 |
| `adapters` | HTTP / WebSocket 调用与数据映射 | 布局与样式 |

- 一块界面有独立交互、状态生命周期或独立子任务时，拆成工作台局部组件；不按文件行数拆分。
- 只服务于单个组件的状态留在组件内部；跨区域或需要跨重连、会话切换保留的状态放在 `state`。
- 新的可复用能力需要真实多处使用或共同契约，不为「以后可能复用」抽取公共组件。
- 协议枚举到界面文案的映射集中在适配层（`adapters/`）或已登记的映射表，组件不重复实现。
- `src/components/ai-elements/` 里大量文件当前没有被工作台导入（例如 `artifact`、`reasoning`、`plan`、`tool`、`terminal`、`canvas`、`sandbox` 等）。文件存在不等于已接入：判断某个能力可不可用，看真实导入，不看文件名。

依赖与可见能力的对应关系：

| 依赖 | 进入界面的部分 | 状态 |
| --- | --- | --- |
| GSAP、`components/motion` | 会话切换、折叠、面板入场 | 已接入，主实现 |
| `motion/react` | 图片生成结果（`agents/image-generation.tsx`） | 已接入，仅此一处 |
| react-virtuoso | 会话长列表虚拟滚动 | 已接入 |
| Monaco | 文件与 Markdown 编辑 | 已接入 |
| tokenlens | `ContextRing` 上下文用量 | 已接入 |
| `@ant-design/plots` | 设置 → 诊断的运行状态折线图 | 已接入 |
| `shell-quote` | 命令动作与图标解析 | 已接入 |
| `@xyflow/react`、`embla-carousel-react`、`media-chrome`、`rive`、`react-jsx-parser` | canvas、carousel、音频、角色动画、JSX 预览 | 未接入工作台 |

新增页面优先复用已接入部分；引入未接入依赖前先确认它能解决当前任务，不因为已安装就默认可用。

## 9. 响应式与可访问性

- 触控命中区不小于 44px；桌面图标按钮使用 `size-8` 以上。
- 底部操作留出安全区：输入区 `pb-[max(16px,env(safe-area-inset-bottom))]`，导航栏与项目栏底部同规则，窄屏不被 Home Indicator 遮挡。
- 悬停才出现的操作必须在触摸设备进入正常布局（`src/styles.css` 的 `(hover: none)` 分支）。
- 长路径、长模型名、长会话名和长输出必须截断、换行或进入详情，不产生页面横向滚动。
- 拖拽上传（输入区附件、文件树目录）必须同时保留点击上传的可替代入口，拖拽不是唯一路径。
- 焦点：`src/styles.css` 清除了按钮、`[role="button"]`、`dropdown-menu-trigger`、`select-trigger` 的浏览器默认轮廓，因此这些控件必须自行提供 `focus-visible:ring-2 ring-ring` 或等价的焦点样式，不能依赖默认 outline。
- 图标按钮提供 `aria-label`；Tooltip 不替代可访问名称。
- 折叠触发器写明当前状态，例如「读取文件，展开」；折叠内容用 `GsapCollapsibleContent`，关闭时同步 `aria-hidden`。
- 加载、错误与需要用户处理的状态使用 `role="status"`、`role="alert"` 或 `aria-busy`，不只靠动画表示。
- Dialog、Popover、菜单使用 Radix 原语，焦点进入与返回由原语负责，不自行接管。
- 状态色与状态图标同时出现；颜色不是唯一信息通道。

## 10. 视觉验收清单

改动页面或组件后按目标视口检查，逐项对照：

- [ ] `390px`、`768px`、`1280px`、`1440px` 下主结构成立，项目栏、审阅工作区、设置各按 `src/components/workbench.tsx` 的断点切换。
- [ ] 浅色、深色、跟随系统只改变 token，不改变信息层级和尺寸。
- [ ] 对话区最长正文、代码块、工具详情、图片结果不产生横向滚动。
- [ ] 输入区在空、可发送、运行中、等待输入、只读、断线六种状态下按钮与草稿行为成立。
- [ ] 工具活动七种状态文案与图标正确，取消和中断不被合并成失败。
- [ ] 审阅工作区四个页签和子会话视图可切换，文件预览、Git Diff 有打开与返回路径。
- [ ] 键盘：Enter 发送、Shift + Enter 换行、Ctrl/Cmd + Enter 送入 steer、中文输入法组合不误发、空输入 Backspace 删附件。
- [ ] 斜杠命令与会话统计正常显示，运行中受限命令给出真实原因。
- [ ] 长会话名、长路径、长命令、长错误和中文输入法输入不破坏布局。
- [ ] 键盘可达项目栏、会话、消息动作、工具展开、输入区和设置；焦点样式可见。
- [ ] 协作房间的对话与看板互斥切换，成员、任务状态与列名一致。

验证入口与命令见 `docs/development/verification.md` 和仓库根 `AGENTS.md`。源码检查不能替代真实页面截图与交互检查。

## 11. 未验证项

- 本文依据 `packages/web` 当前源码整理，本次没有启动 Gateway 与 Runtime，没有做浏览器截图、交互或像素级验收。
- 第 10 节是待执行的检查清单，不代表已经通过。
- `plan/lystar-code-web-ui-local/` 中标记为「视觉参考待确认」的局部样式未进入本文；需要时按该目录的说明单独确认。
- 第 8 节的依赖接入状态来自导入搜索，未对每个未接入组件逐一验证其内部实现。
