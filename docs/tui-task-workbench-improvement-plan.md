# Interactive TUI 任务工作台优化方案

> 状态：待 Yean 确认。
>
> 编写日期：2026-08-07。
>
> 实施基线：LYStar Agent `0.84.1-lystar.1`，Pi `v0.84.1`。
>
> 本文只设计 Interactive TUI 的信息结构、交互和显示责任。Session、Agent Runtime、Tool、Extension、Skill、Package、Provider 和 `PI_*` 契约保持不变。

## 1. 背景与判断

LYStar 当前已经具备成熟的全屏终端工作区：顶部展示项目与上下文，中间维护独立滚动的对话历史，底部固定 Composer、状态和快捷操作；用户消息、Agent 回复、思考、Tool、Diff、错误和排队消息均有独立显示语义。

现有实现重点解决了终端产品最难处理的基础问题：

- alternate screen 生命周期与退出恢复。
- 固定输入区和独立历史滚动。
- 80×8、80×24、120×36 等终端尺寸适配。
- 长 Session 虚拟历史窗口和组件缓存。
- 流式更新、绝对坐标重绘和周期校准。
- Tool/Diff 摘要、展开、鼠标点击和同轮 Bash 命令组。
- steering、follow-up 和压缩期间的消息排队。
- 普通模式与全屏模式运行时切换。
- Extension header、footer、widget、editor 和 overlay 兼容。

当前主要缺口已经从“终端能否稳定使用”转为“用户能否快速监督任务并确认结果”。现有界面能完整展示过程，但用户仍要从滚动历史中自行判断：

- 当前任务做到哪一步。
- Agent 此刻正在处理什么。
- 本轮执行了多少操作。
- 修改了哪些文件。
- 命令和验证是否成功。
- 任务结束后应该从哪里开始复核。

Codex GUI 的 project/thread、并行任务、Diff review 和结果审阅，以及 Grok Build 的计划审查、任务状态和 Agent Dashboard，都说明编码 Agent 的界面正在从对话窗口走向任务监督工作台。LYStar 应吸收这层信息组织方式，同时保留终端的高密度、低打扰和键盘优先特征。

## 2. 产品目标

本次优化围绕四个结果：

1. **进入即工作**：启动信息不占满首屏，当前项目和任务成为第一视觉焦点。
2. **过程可判断**：运行期间能看到当前动作、执行数量、耗时和排队状态。
3. **结果可复核**：每轮结束都有基于真实 Tool 事件的完成摘要，并能进入统一变更视图。
4. **信息不常驻膨胀**：活动条、完成摘要和审阅入口按状态出现，空闲时归还对话空间。

## 3. 兼容与责任边界

### 3.1 保持不变

- 不修改 Session JSONL 格式和 entry 类型。
- 不增加任务数据库、计划文件格式或 LYStar 专属会话格式。
- 不复制 Agent Runtime、Todo、后台任务或子 Agent 调度器。
- 不新增第二套 ANSI renderer、焦点系统或输入系统。
- 不改变 Tool Call、Tool Result、Extension event 和 renderer API。
- 不改变 `la` CLI 参数、退出码、模型 ID、Provider ID 和 `PI_*` 环境变量。
- 不把第三方 Extension 文案强制翻译或重排。

### 3.2 责任分配

| 责任 | 归属 |
|---|---|
| 固定区域、裁切、viewport 和终端尺寸适配 | `LystarWorkspace` |
| 当前运行状态和本轮事实收集 | `InteractiveMode` |
| 单个 Tool 的文件、命令、Diff 和结果事实 | 现有 Tool renderer 与 Tool Result |
| 活动条、完成摘要、变更选择器 | LYStar 显示组件 |
| Todo、计划步骤和长期任务状态 | Pi Extension |
| 多会话实时状态 | 现有 Pi Server/Protocol 能力可提供时接入 |
| Git 工作区事实 | Git 原生命令和现有 session cwd |

TUI 只展示能从真实事件、Tool Result、SessionManager 或 Git 得到的事实。没有事实源时不显示推测进度。

## 4. 当前界面评估

### 4.1 已有优势

| 方向 | 当前能力 | 评价 |
|---|---|---|
| 全屏布局 | 顶栏、viewport、Composer、快捷栏固定 | 已成熟 |
| 长会话 | 有界双向滑动窗口、块缓存、按需渲染 | 已成熟 |
| 用户轮次 | 用户消息背景与左侧任务轨道清楚 | 保持 |
| Tool | 摘要、状态、展开、错误直接显示 | 保持并增强汇总 |
| Bash | 同轮命令组、完成数、失败数、自动折叠 | 已成熟 |
| Diff | 行号、增删颜色、行内差异 | 可直接复用 |
| 消息队列 | steering、follow-up、恢复到输入框 | 功能完整，管理入口偏弱 |
| Session | 搜索、树形关系、范围、排序、重命名、删除 | 功能完整，任务信息不足 |
| Extension | header、footer、widget、editor、overlay | 必须继续兼容 |

### 4.2 真实画面发现

使用当前源码在真实 tmux PTY 中检查 `120×36` 和 `80×24`：

- 启动 Changelog 可以占据几乎整个对话 viewport。
- `80×24` 下产品名和 Session 会先被裁掉，精确上下文用量仍固定保留。
- Composer 同时展示 Provider、模型、思考强度和项目可信状态，窄宽度下信息竞争明显。
- 当前运行状态有单独状态行，但主要表达“正在工作”，缺少任务级进展。
- Agent 结束后状态行消失，缺少稳定的本轮结果锚点。
- Diff 分散在 Edit Tool 中，长任务结束后没有跨文件审阅入口。

## 5. 视觉方向

```text
产品与核心任务：终端中的持续编码与任务监督。
视觉方向：安静、高密度、状态明确的工程工作台。
一个识别点：运行活动条与完成结果条形成统一任务轨道。
保持项：中性黑灰、青绿强调、固定 Composer、独立 viewport、少边框。
避免项：常驻侧栏、卡片堆叠、装饰动画、虚假百分比和桌面 GUI 式多面板。
```

设计原则：

- 常态保持简洁，异常和运行状态提高对比度。
- 颜色只区分状态，不承担唯一信息来源。
- 固定区域只放当前决策需要的信息。
- 历史事实进入对话区，不长期占用底部。
- 运行时多一行状态，空闲时自动隐藏。
- 完成摘要作为当前轮次的一部分进入历史，可回看、可展开。

## 6. 目标界面

### 6.1 空闲状态

```text
LYStar · liteasy-pi-agent/main · 修复全屏滚动                 上下文 36%
────────────────────────────────────────────────────────────────────────

│ 用户任务

Agent 回复、Tool、Diff 与历史记录

╭──────────────────────────────────────────────────────────────────────╮
│❯                                                                    │
╰─ upstream/gpt-5.6-sol · 思考 高 ────────────────────────────────╯
Shift+Tab 思考强度 · Ctrl+O 展开 · / 命令
```

项目已经可信时不常驻显示“项目已信任”。只有未信任或资源受限时才显示状态。

### 6.2 运行状态

```text
LYStar · liteasy-pi-agent/main · 修复全屏滚动                 上下文 36%
执行中 · edit interactive-mode.ts · 操作 4/6 · 01:26 · 队列 1
────────────────────────────────────────────────────────────────────────

Agent 回复与当前 Tool

╭──────────────────────────────────────────────────────────────────────╮
│❯                                                                    │
╰─ upstream/gpt-5.6-sol · 思考 高 ────────────────────────────────╯
Esc 取消 · Ctrl+O 详情 · Alt+Up 编辑队列
```

### 6.3 完成状态

完成摘要进入对话历史，不继续占用固定状态行：

```text
完成 · 修改 4 个文件 · +86/-21 · 命令 5/5 · 用时 2m14s
Enter 审阅本轮结果
```

展开后：

```text
本轮结果

文件
  M interactive-mode.ts       +42/-8
  M lystar-workspace.ts       +31/-9
  M workspace-shortcut-bar.ts +13/-4
  A turn-summary.test.ts      +20/-0

执行
  ✓ 5 条命令成功
  ✓ 3 个文件修改成功
  ✓ 1 个文件创建成功
```

只有 Tool Result 提供明确验证事实时才显示“测试通过”“类型检查通过”等语义。普通 Bash 成功只显示命令成功，不把退出码 `0` 推断为业务验证完成。

### 6.4 80 列降级

```text
liteasy-pi-agent/main · 修复全屏滚动                    36%
执行中 · edit interactive-mode.ts · 4/6 · 01:26
```

裁切顺序：

1. 精确 Token 数。
2. Provider。
3. 完整路径。
4. 思考强度原始值。
5. 产品名。

任务名、项目、分支、运行状态和上下文百分比优先保留。

### 6.5 极小高度

`80×8` 下保留顺序：

1. Composer 最小主体。
2. 运行状态。
3. 一行快捷操作。
4. 一行对话或当前 Tool。

顶栏、Footer、Extension Widget 和排队详情按现有预算规则让位。运行状态没有活动时不占行。

## 7. 详细方案

### 7.1 启动内容收拢

#### 当前问题

新版本 Changelog 会进入主对话区。内容较长时，用户启动后必须先滚动或输入，才能回到任务上下文。

#### 调整

```text
已更新到 v0.84.1。使用 /changelog 查看完整更新记录。
```

`/changelog` 使用现有 Overlay 或选择器能力显示完整内容。普通模式继续允许按当前设置展开，避免改变 inline 日志使用习惯。

#### 验收
- `/changelog` 可查看完整内容。
- 恢复已有 Session 时不显示 Changelog。
- Extension 启动通知和真实错误不被合并进 Changelog。

### 7.2 顶栏信息优先级

#### 当前问题

`WorkspaceHeader` 为右侧上下文预留完整宽度，再从产品、路径、分支和 Session 中逐项删除。窄宽度下，任务方向信息会先消失。

#### 新结构

```text
左侧：产品、项目、分支
中间：Session 名或任务标题
右侧：运行状态、上下文百分比
```

任务标题来源按顺序选择：

1. 用户显式设置的 Session 名。
2. 当前 Session 第一条用户消息的第一行。
3. `新会话`。

第一条消息只做显示裁切，不自动写入 Session 名称，不调用模型生成标题。

#### 宽度规则

| 宽度 | 显示 |
|---:|---|
| `>=120` | 产品、项目、分支、任务名、上下文百分比和精确 Token |
| `80-119` | 项目、分支、任务名、上下文百分比 |
| `<80` | 项目或任务名、运行状态、上下文百分比 |

#### 上下文显示

宽屏：

```text
上下文 36.2% · 98K/272K
```

窄屏：

```text
上下文 36%
```

接近自动压缩阈值时使用 warning 色；发生 overflow 时继续使用现有错误和压缩状态，不只靠颜色提示。

### 7.3 运行活动条

#### 目标

用户无需阅读完整 Tool 输出，也能判断 Agent 当前动作和任务是否仍在推进。

#### 布局位置

活动条使用独立的顶部状态槽，位于 header 与对话 viewport 之间，不塞进 `headerContainer` 或底部 `statusContainer`：

- 内置 header 和 Extension custom header 的替换契约保持不变。
- 常规高度下显示 header 一行和活动条一行。
- 极小高度下先隐藏 header 的次要信息，活动条优先于普通 header 保留。
- 无活动时组件返回空数组，不占高度。

#### 状态模型

活动条只维护当前进程内的临时显示状态：

```ts
type WorkspaceActivityState = {
  phase:
    | "thinking"
    | "runningTool"
    | "waiting"
    | "retrying"
    | "compacting"
    | "summarizing"
    | "cancelled";
  action?: string;
  subject?: string;
  startedAt: number;
  completedTools: number;
  knownTools: number;
  queueCount: number;
};
```

该状态不写入 Session。Session 重放继续以已有消息和 Tool Result 为准。

#### 事件来源

| AgentSession 事件 | 活动条 |
|---|---|
| `agent_start` | `正在思考` |
| `message_update` 出现 Tool Call | 更新已知 Tool 数量 |
| `tool_execution_start` | `执行中 · <动作> <对象>` |
| `tool_execution_end` | 增加完成数量，切到下一个活动 Tool |
| `queue_update` | 更新队列数量 |
| `compaction_start` | `正在压缩上下文` |
| `compaction_end` 且重试 | 恢复执行状态 |
| retry 事件 | 显示倒计时和次数 |
| `agent_end` | 完成本次响应；发生自动重试时保留本轮收集器 |
| `agent_settled` | 清除固定活动条并生成一条最终完成摘要 |

#### 动作文本

优先使用内置 Tool renderer 已有的结构化摘要：

```text
read packages/.../interactive-mode.ts
edit packages/.../lystar-workspace.ts
bash npm run check
write docs/...
```

第三方 Tool 没有结构化摘要时显示 Tool 名，不读取或猜测参数语义。

#### 多 Tool

多个 Tool 并行时：

```text
执行中 · 3 个操作并行 · 已完成 2/5 · 01:26
```

只有一个 Tool 时优先显示具体动作和对象。

#### 耗时

- 从 `agent_start` 开始计时。
- 少于 60 秒显示 `42s`。
- 超过 60 秒显示 `2m14s`。
- `reduceMotion=true` 时仍更新秒数，但不增加新动画。

### 7.4 本轮完成摘要

#### 目标

为每次 Agent 运行留下一个清楚、可回看的结果锚点。

#### 数据来源

在一次 `agent_start` 到最终 `agent_settled` 之间收集：

- Tool 总数、成功数、失败数、取消数。
- Bash 命令数量和退出状态。
- Edit、Write 等文件修改 Tool 触及的路径。
- Tool Result 中已有的 additions、deletions 和 diff。
- 运行起止时间。
- 是否发生 retry、compaction 或取消。

#### 摘要规则

成功：

```text
完成 · 修改 4 个文件 · +86/-21 · 命令 5/5 · 2m14s
```

部分失败：

```text
完成但有问题 · 4 个文件 · 5 条命令中 1 条失败 · 2m14s
```

取消：

```text
已取消 · 完成 3/6 个操作 · 修改 2 个文件 · 48s
```

无 Tool 的纯回答不增加完成摘要，避免普通问答出现多余状态块。

#### 展开内容

- 文件列表按首次触及顺序显示。
- 同一文件多次修改只显示一项，增删行累计使用 Tool Result 的真实值。
- 失败项直接显示首条可操作错误。
- 不复制完整 Tool 输出。
- 点击摘要或使用现有展开 action 查看详情。

#### Session 重放

第一版完成摘要只服务当前运行，不写入新的 Session entry。恢复 Session 时继续显示原有消息和 Tool，不重新推导历史完成摘要。

后续如果 Pi 上游提供稳定的 turn summary entry，再评估持久化，不提前扩展 Session 格式。

### 7.5 `/changes` 变更审阅器

#### 目标

把分散在各个 Edit/Write Tool 中的 Diff 汇总为统一入口。

#### 命令

新增内置命令：

```text
/changes
```

第一版不新增全局快捷键。用户确认高频使用后，再进入 `DEFAULT_APP_KEYBINDINGS` 增加 action 和默认键位。

#### 数据范围

审阅器明确区分：

```text
本轮触及
工作区全部
```

- “本轮触及”来自当前进程内记录的文件路径和 Tool Diff。
- “工作区全部”来自当前 cwd 的 Git 状态和 Diff。
- 工作区原有改动不能归到 Agent 名下。
- 无法区分行级归属时，界面写“当前工作区变更”，不写“本轮新增”。

#### 非 Git 目录

- 有本轮 Tool Diff 时仍可查看“本轮触及”。
- 没有结构化 Diff 时只显示文件列表。
- 不显示 Git 相关操作或错误。

#### 布局

```text
变更审阅                         本轮触及 4 · 工作区全部 7

› M interactive-mode.ts                         +42/-8
  M lystar-workspace.ts                         +31/-9
  M workspace-shortcut-bar.ts                   +13/-4
  A turn-summary.test.ts                        +20/-0

────────────────────────────────────────────────────────
- 128 old line
+ 128 new line

Enter 展开 · ↑/↓ 选择 · PageUp/PageDown 滚动 · Esc 返回
```

宽度足够时使用文件列表与 Diff 双栏会显著增加布局复杂度。第一版使用单栏：上方文件列表，下方当前 Diff，优先保证 `80×24` 可用。

#### 交互

- `↑/↓` 选择文件。
- `Enter` 在文件列表和完整 Diff 之间切换。
- `PageUp/PageDown` 滚动 Diff。
- `Ctrl+O` 继续使用现有展开语义。
- `Esc` 返回 Composer。
- 鼠标点击文件行切换文件。
- Shift 选择文本继续交给终端。

#### 修改意见

第一版不在审阅器内新增评论模型。用户关闭审阅器后直接在 Composer 输入修改意见。后续如确有高频需求，可以把选中文件路径插入 Composer，仍走普通用户消息和 Agent 流程。

### 7.6 Composer 信息收敛

#### 当前问题

Composer 底边同时展示 Provider、模型、思考强度和项目可信状态。可信项目是正常状态，长期占位价值较低。

#### 调整

左侧：

```text
provider/model · 思考 高
```

右侧只显示异常或需要用户判断的状态：

```text
项目未信任
项目资源受限
无可用模型
```

正常可信状态不显示。完整信任状态仍可通过 `/trust` 查看。

宽度不足时裁切顺序：

1. Provider。
2. `思考` 前缀，仅保留强度。
3. 模型显示名裁切。

模型 ID 和 Provider ID 在模型选择器中保持完整原值。

### 7.7 信任状态文案

当前 Composer 使用：

```text
项目已信任
操作需确认
```

“操作需确认”容易被理解为每个 Tool 都会进行权限审批。项目可信状态实际关系到项目级 `.pi` 资源和 Package 是否加载。

建议改为：

| 状态 | 文案 |
|---|---|
| 已信任 | 默认不显示 |
| 未信任 | `项目未信任` |
| 项目资源未加载 | `项目资源受限` |

首次进入或状态改变时继续通过现有提示说明具体影响，不把完整解释塞进 Composer。

### 7.8 排队消息管理

现有排队消息会逐条显示，并支持一次性恢复到输入框。后续改善为紧凑摘要：

```text
队列 3 · 引导 2 · 后续 1 · Alt+Up 编辑
```

展开后显示列表：

```text
1 引导  修复失败后继续检查调用者
2 引导  补充 Windows 回归
3 后续  完成后生成变更摘要
```

建议支持：

- 选择单条恢复到 Composer。
- 删除单条排队消息。
- 保留现有“一次恢复全部”能力。
- 不修改 AgentSession 的 steering/follow-up 语义和派发顺序。

该项优先级低于活动条和完成摘要，不进入建议的首次实施范围。

### 7.9 Session 中心

当前 `/resume` 是完整的历史 Session 选择器。后续可增加任务监督信息，但只展示已有事实。

建议每项显示：

```text
任务名或首条消息                     main · 24 条 · 18m
最近结果：修改 4 文件 · 1 条命令失败
```

数据来源：

- 名称：Session name 或第一条用户消息。
- 分支：Session cwd 当前 Git 分支；无法保证历史分支时明确显示当前值。
- 消息数和时间：现有 SessionInfo。
- 最近错误：Session 末尾已有错误结果。
- 运行中状态：只有 Pi Server/Protocol 提供真实活跃会话信息时显示。

不通过扫描进程、锁文件或猜测 Session 最后状态来标记“运行中”。

### 7.10 Slash Command 信息结构

现有 `/` 补全将内置命令、Prompt、Extension 和 Skill 放在一个连续列表中。命令增多后发现成本会上升。

建议按来源和任务分组：

```text
当前任务   /changes /compact /new
会话       /resume /session /tree /fork /clone /name
模型       /model /scoped-models /login /logout
项目       /trust /reload /settings
结果       /copy /export /share
扩展       Extension commands
Prompt     Prompt templates
Skill      /skill:name
```

搜索仍使用现有模糊匹配。分组只影响空查询和宽松查询时的展示，不改变命令名和 Extension 冲突规则。

### 7.11 计划面板

计划、Todo 和长期任务状态继续由 Extension 提供。LYStar 只为结构化 Widget 提供合适的固定区域预算和视觉约定。

推荐 Extension 输出：

```text
计划 2/5
✓ 阅读输入路由
✓ 定位滚动断点
› 修改共享处理器
○ 补回归测试
○ 真实 PTY 验证
```

约束：

- 最多显示当前项、上一项和后两项。
- 完整计划通过 Overlay 查看。
- Widget 不得挤掉 Composer 和运行状态。
- 计划步骤来自 Extension 的真实状态，不由 TUI 解析模型 Markdown。
- 计划审批、评论和持久化由 Extension 自己维护。

### 7.12 多会话 Dashboard

多会话监督只有在现有 Pi Server/Protocol 提供真实状态时实施：

```text
会话 3 · 运行 2 · 等待 1

› 修复 TUI 滚动       执行 bash        01:26
  更新中文文档         等待输入         03:14
  检查 Provider        正在思考         00:42
```

TUI 不自行启动后台守护进程，不扫描其他 `la` 进程，不创建新的调度协议。没有实时状态源时，继续使用 `/resume` 历史会话中心。

## 8. 状态与数据设计

### 8.1 单轮生命周期

```text
用户提交
  -> agent_start
  -> thinking
  -> tool calls / assistant text
  -> tool results
  -> retry / compaction（可选）
  -> agent_end
  -> agent_settled
  -> 完成摘要
```

本轮收集器在 `agent_start` 创建，在 `agent_settled` 结束。

`agent_end` 表示一次响应结束，但此后仍可能自动 retry。只有进入 `agent_settled` 后才生成完成摘要，避免同一任务出现多条伪完成记录。

### 8.2 建议的最小状态

```ts
type TurnActivity = {
  startedAt: number;
  toolOrder: string[];
  tools: Map<string, {
    name: string;
    status: "pending" | "running" | "success" | "error" | "cancelled";
    subject?: string;
    filePath?: string;
    additions?: number;
    deletions?: number;
    error?: string;
  }>;
};
```

该结构只服务显示。Tool Result 和 Session 仍是事实源。

不为它创建通用事件总线、repository、service 或持久化接口。

### 8.3 文件路径去重

- 使用 cwd 解析后的绝对路径作为内部 key。
- 显示时使用 cwd 相对路径。
- Windows 路径继续走项目现有路径规范化能力。
- 同一文件多次 Edit/Write 合并成一项。
- 文件重命名只有 Tool Result 明确提供旧路径和新路径时才显示为 rename。

### 8.4 Diff 数量

优先使用 Tool Result 中已有的 additions/deletions。没有结构化值时可以从已有 display diff 统计 `+` 和 `-` 行，但必须排除 Diff header；无法可靠统计时省略数量。

## 9. 组件设计

建议新增三个职责明确的显示组件：

### `WorkspaceActivityBar`

- 输入当前活动状态。
- 通过 `LystarWorkspace` 的独立顶部状态槽渲染，不依赖内置或自定义 header。
- 只渲染一行。
- 自己负责宽度降级。
- 无活动时返回空数组。
- 不读取 Session 或 Tool Map。

### `TurnSummaryComponent`

- 输入已经完成的只读本轮摘要。
- 默认一行，支持展开详情。
- 实现现有 expandable 和鼠标命中约定。
- 不执行 Git 命令。

### `ChangesSelectorComponent`

- 输入本轮文件摘要和工作区 Git 结果。
- 负责文件选择、Diff 滚动和 Overlay 交互。
- Git 查询由 InteractiveMode 或独立的现有命令边界提供。
- 不修改文件，不承担回退和提交能力。

这三个组件分别解决固定运行状态、历史完成结果和按需审阅，职责没有重叠。

## 10. 预计文件范围

### 建议首次实施

| 文件 | 改动 |
|---|---|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 收集本轮活动、接入活动条、生成完成摘要、处理 `/changes` |
| `packages/coding-agent/src/modes/interactive/components/lystar-workspace.ts` | 调整顶栏状态组合和宽度优先级；无必要不改 viewport 核心 |
| `packages/coding-agent/src/modes/interactive/components/workspace-activity-bar.ts` | 新增单行运行活动条 |
| `packages/coding-agent/src/modes/interactive/components/turn-summary.ts` | 新增本轮完成摘要 |
| `packages/coding-agent/src/modes/interactive/components/changes-selector.ts` | 新增单栏变更审阅器 |
| `packages/coding-agent/src/core/slash-commands.ts` | 注册 `/changes` |
| `packages/coding-agent/src/locales/zh-CN.ts` | 增加活动、完成和审阅文案 |
| `packages/coding-agent/src/modes/interactive/components/index.ts` | 导出新增组件 |
| 对应 Coding Agent 测试 | 状态、摘要、审阅、宽度和事件回归 |
| `docs/usage/interactive-tui.md` | 实施完成后补用户操作说明 |

### 后续优先项

| 文件 | 改动 |
|---|---|
| `session-selector.ts` | Session 任务信息与最近结果 |
| `workspace-shortcut-bar.ts` | 队列管理和审阅入口的动态提示 |
| `settings-selector.ts` | 如新增显示偏好，接入设置；默认不增加开关 |
| 内置 Extension | 计划面板或 Pi Server Dashboard |

实施时先复用现有 helper 和 Tool renderer。新增文件只服务上面三个独立组件，不继续拆分 formatter、store 或 service。

## 11. 优先级

| 优先级 | 内容 | 原因 |
|---|---|---|
| P0 | Changelog 收拢 | 小改动，直接改善启动首屏 |
| P0 | 顶栏任务优先级 | 窄终端方向感明显提升 |
| P0 | 运行活动条 | 补齐过程监督 |
| P0 | 本轮完成摘要 | 补齐结果锚点 |
| P0 | `/changes` 审阅器 | 形成任务交付闭环 |
| P0 | 信任文案修正 | 避免用户误解权限语义 |
| P1 | 排队消息列表管理 | 改善长任务 steering 体验 |
| P1 | Session 中心增强 | 改善跨会话恢复与判断 |
| P1 | Slash Command 分组 | 降低功能发现成本 |
| P2 | Extension 计划面板 | 依赖真实 Todo/计划来源 |
| P2 | 多会话 Dashboard | 依赖现有实时会话协议 |

## 12. 建议本次实施范围

Yean 确认后，建议先完成以下完整范围：

1. Changelog 默认收成一行。
2. 顶栏改为任务和项目优先。
3. 新增运行活动条。
4. 新增本轮完成摘要。
5. 新增 `/changes` 单栏审阅器。
6. 修正 Composer 信任状态文案和常驻策略。
7. 完成对应自动测试、真实 PTY 和文档更新。

排队消息列表、Session 中心、命令分组、计划面板和多会话 Dashboard 保留在本文中，等 P0 体验稳定后按真实使用反馈决定是否实施。

## 13. 自动验证

### 13.1 聚焦测试

至少覆盖：

- Changelog 在 fullscreen 下最多占两行。
- Session 有名称时顶栏显示名称。
- Session 无名称时使用第一条用户消息首行。
- `120`、`80` 和更窄宽度下按优先级裁切。
- `agent_start` 后活动条出现。
- Tool 开始、结束、失败、取消时活动条状态正确。
- 多 Tool 并行时总数和完成数正确。
- queue update 后数量更新。
- compaction 和 retry 不错误生成完成摘要。
- 最终 `agent_settled` 只生成一条完成摘要。
- 纯文本回答不生成 Tool 摘要。
- 同一文件多次修改只显示一次。
- additions/deletions 只使用可靠事实。
- 工作区已有改动不被标为本轮改动。
- 非 Git 目录可以查看本轮 Tool Diff。
- `/changes` 文件选择、滚动、退出和鼠标命中正确。
- 自定义 Extension header、footer 和 widget 继续工作。

### 13.2 项目 gate

```bash
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
```

若改动触及共享 TUI renderer、Tool Result 或 Session 事件，再扩大到 AI、Agent Core 和完整 Coding Agent gate。

## 14. 真实 PTY 验证

| 场景 | 验收点 |
|---|---|
| `120×36` 空闲 | 顶栏、任务名、上下文和 Composer 层级清楚 |
| `80×24` 空闲 | 产品次要信息裁切，项目和任务保留 |
| `80×8` 运行 | Composer、活动状态和取消操作可见 |
| 单 Tool | 显示具体动作、对象和耗时 |
| 多 Tool 并行 | 显示并行数和完成数，不快速跳动错乱 |
| Tool 失败 | 活动条和完成摘要都显示失败 |
| 取消 | 显示已取消和实际完成数量 |
| 自动 retry | 中间不生成伪完成摘要 |
| compaction 后续跑 | 状态连续，最终只生成一条摘要 |
| dirty worktree | `/changes` 清楚区分本轮触及和工作区全部 |
| 非 Git 项目 | 审阅器不显示误导性 Git 错误 |
| 上滚阅读 | 新内容不抢回底部，活动条仍可判断 |
| resize | 状态、摘要、Composer 和 Overlay 不重叠 |
| custom header/footer/widget | Extension UI 契约保持 |

真实验证结束后关闭本轮创建的 tmux socket，只管理本轮会话。

## 15. 风险与控制

| 风险 | 控制 |
|---|---|
| 把工作区旧改动算到 Agent 本轮 | 严格区分“本轮触及”和“工作区全部” |
| 从 Bash 输出误判测试成功 | 只有结构化事实才显示测试语义，否则显示命令状态 |
| 固定区域继续膨胀 | 活动条仅运行时出现，完成摘要进入历史 |
| retry 产生多条完成摘要 | 等最终 settled 状态再生成 |
| 新组件影响长会话性能 | 活动状态保持 O(1)，完成摘要只在轮次结束创建一次 |
| Extension custom header 被活动条挤压或覆盖 | custom header 保持完整替换能力；活动条使用独立顶部状态槽，并按终端高度单独分配 |
| `/changes` 在大 Diff 下卡顿 | 文件级按需渲染，只装配当前文件可见行 |
| Git 不可用或目录不是仓库 | 保留本轮 Tool 事实，隐藏工作区 Git 视图 |
| 新快捷键冲突 | 第一版只增加 `/changes` 命令，不新增默认键位 |

## 16. 验收结论

完成后，用户应能在不翻阅完整历史的情况下回答：

- 我现在在哪个项目和任务里。
- Agent 当前正在做什么。
- 已经完成多少操作，是否仍在运行。
- 有没有排队消息或失败。
- 本轮改了哪些文件。
- 命令和 Tool 是否成功。
- 从哪里进入最终 Diff 审阅。

界面仍保持单列终端工作区，不变成桌面 IDE 的缩小版本。任务信息来自真实事件，复杂任务能力继续通过 Pi Extension 和现有协议扩展。

## 17. 参考

项目内事实源：

- `docs/lystar-agent-plan.md`
- `docs/ci-tui-optimization-plan.md`
- `packages/coding-agent/src/modes/interactive/components/lystar-workspace.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution-group.ts`
- `packages/coding-agent/src/modes/interactive/components/session-selector.ts`

外部交互参考：

- OpenAI Codex app：<https://openai.com/index/introducing-the-codex-app/>
- OpenAI Codex：<https://openai.com/index/introducing-codex/>
- Grok Build：<https://x.ai/news/grok-build-cli>
- Grok Build Plan Mode：<https://docs.x.ai/build/features/plan-mode>
- Grok Build Agent Dashboard：<https://x.ai/news/agent-dashboard>
- Grok Build Goal：<https://x.ai/news/introducing-goal>
