# Subagent 独立会话与 TUI 导航优化方案

## 1. 目标

本次优化解决两个直接问题：

1. 主会话中的多个 Subagent 必须分别显示为独立组件，每个组件有自己的点击区域，不能继续依赖一个 Tool Result 文本块内的行号和名称匹配。
2. 点击某个 Subagent 后进入它自己的会话视图。该视图展示完整历史和实时输出，支持继续输入、取消当前执行，并能返回主会话且恢复原来的滚动位置、焦点和输入草稿。

验收时应满足以下用户路径：

```text
主会话
  ├─ Subagent A 独立行 ──点击──> A 的会话 ──返回──> 主会话原位置
  ├─ Subagent B 独立行 ──点击──> B 的会话 ──返回──> 主会话原位置
  └─ /agents ───────────> 子会话索引 ──选择──> 对应子会话
```

Subagent 即使已经完成、RPC 进程已经退出或主程序已经重启，也应保留可读取、可恢复、可继续输入的会话身份。

## 2. 当前实现与根因

### 2.1 当前链路

当前 Subagent 的执行和展示链路如下：

```text
主 Agent 发出一个 subagent Tool Call
  -> subagent Extension 为 single / parallel / chain 创建 RPC 子进程
  -> 每个子进程使用 --no-session
  -> SubagentRunController 在内存收集 messages、state、usage
  -> Extension 把所有结果写入同一个 Tool Result details.results
  -> ToolExecutionComponent 调用一个 renderResult 生成整块文本
  -> 点击时根据渲染行和 Agent 名称反查 agentId
  -> 打开 /agents 使用的 AgentWorkbench overlay
```

这条链路把“运行实例”“结果摘要”“会话”“详情面板”混成了一个对象。

### 2.2 根因

#### 根因一：`agentId` 只有运行含义，没有会话含义

当前 `runId` 标识一次 Subagent Tool Call，`agentId` 通常是 `${runId}:${index}`。它们可以区分本次运行中的结果，却不能定位一个可恢复的 Pi Session。

`SubagentRunController` 启动参数包含 `--no-session`，子代理没有持久 JSONL，没有稳定的 `sessionId` 和 `sessionFile`。主程序重启后只能从父会话 Tool Result 中读取一份消息副本，无法恢复真实子会话。

#### 根因二：RPC 进程寿命被当成会话寿命

Controller 完成后只保留约 60 秒。定时器到期会停止 RPC 并从注册表移除 Controller。`steerSubagent()`、`followUpSubagent()`、`abortSubagent()` 都依赖这个内存对象，因此完成一段时间后无法继续输入。

RPC 进程适合承担实时执行，不能承担会话持久化。进程可以退出，会话必须继续存在。

#### 根因三：一个 Tool Result renderer 承担了所有 Subagent 展示

parallel 和 chain 虽然有多个 `results`，TUI 仍然只创建一个 `ToolExecutionComponent`。`renderResult` 最终返回一个组件，多个 Agent 只是在该组件中的多行文本。

`getAgentTargetAtRow()` 需要重新渲染文本、搜索 Agent 名称、推算行号。该方法会受到标题换行、终端宽度、重复 Agent 名称、输出内容包含同名文本和 renderer 格式变化影响。测试通过只能证明当前固定文本布局可用，不能建立稳定的组件身份。

#### 根因四：`/agents` 的详情页没有会话能力

`AgentWorkbenchComponent` 当前是列表加详情 overlay：

- `detailVisible` 控制窄屏详情切换。
- 详情内容来自父 Tool Result 中的 `messages`、`stderr` 或 `currentAction`。
- 输入通过临时 `showExtensionInput()` 收集，然后调用 `steer` 或 `followUp`。
- 组件没有自己的 transcript、编辑器、分页和会话恢复能力。

它适合做运行监督入口，不适合作为子会话页面。

#### 根因五：父 Tool Result 保存了整份子代理消息副本

`SingleResult.messages` 被写入父会话 Tool Result details。它同时承担最终输出提取、详情展示和历史保存，导致以下问题：

- 父会话文件重复保存完整子会话内容。
- 子会话后续输入无法回写到已经落盘的旧 Tool Result。
- 父记录和实际运行状态容易分叉。
- TUI 被迫围绕 Tool Result details 构造“伪会话”。

## 3. 核心设计

### 3.1 保留一个 Tool Call 协议，拆分 TUI 组件和子会话

主模型只发出一个 `subagent` Tool Call，因此父 Session 中继续保留一个 Tool Call 和一个 Tool Result。强行拆成多个 Tool Result 会破坏工具调用协议，也会影响主模型上下文。

TUI 展示采用独立结构：一个 Tool Call 对应一个内部 binding，binding 为每个结果创建一个顶层 `SubagentRunComponent`。这些组件分别加入主会话 `chatContainer`，不再包装进同一个文本组件。

```text
父 Session 协议层：1 个 Tool Call + 1 个 Tool Result

TUI 组件层：
  SubagentRunComponent(session A)
  SubagentRunComponent(session B)
  SubagentRunComponent(session C)
```

点击命中直接来自组件对象携带的 `agentId` 和 `sessionRef`，不再搜索渲染文本。

### 3.2 每个 Subagent 创建真实持久 Session

每个 `SingleResult` 对应一个独立 Pi Session。首次启动顺序如下：

1. 启动 RPC 子进程时移除 `--no-session`，继续保留 `--no-extensions --exclude-tools subagent`。
2. RPC 启动后调用现有 `new_session(parentSessionFile)`，让 Session header 记录父会话路径。
3. 调用现有 `get_state`，取得真实 `sessionId` 和 `sessionFile`。
4. 将会话引用写入 Controller 快照、partial Tool Result 和最终 Tool Result details。
5. 会话身份就绪后再发送首个 `prompt`。

现有 RPC 和 `SessionManager` 已支持 `new_session(parentSession)`、`get_state`、`get_entries`、`get_messages` 和持久 JSONL，这里不需要新增协议命令。

主会话使用 `--no-session` 时没有可记录的父文件路径，子代理仍可建立自己的持久 Session，`parentSessionFile` 留空。常规持久主会话则必须写入父子关系。

### 3.3 明确三种身份

三个 ID 保留各自职责，禁止互相替代：

| 字段 | 含义 | 生命周期 |
| --- | --- | --- |
| `runId` | 一次 `subagent` Tool Call | Tool Call 级 |
| `agentId` | 本次 Tool Call 中一个结果项的稳定标识 | 父记录级 |
| `sessionId` | Pi 持久会话身份 | 子会话级 |

新增会话引用：

```ts
interface SubagentSessionRef {
  version: 1;
  sessionId: string;
  sessionFile: string;
  parentSessionFile?: string;
  cwd: string;
  createdAt: number;
}
```

`SingleResult` 增加 `session?: SubagentSessionRef` 和 `finalOutput?: string`。Controller 可以在内存保留消息用于当前执行，写入父 Tool Result details 时只保存会话引用、状态、用量、错误和最终输出，不再保存完整 `messages`。

父 Tool Result 的 `content` 继续向主模型提供各任务最终输出，主模型行为不变。完整 transcript 只以子 Session JSONL 为事实源。

### 3.4 Session 与 RPC 分离

Controller 的职责调整为“当前连接和当前 turn”，Session 文件负责完整历史。

```text
持久层：Subagent Session JSONL
  - 历史消息
  - Tool Call / Tool Result
  - Session header 和 parentSession
  - 重启后的恢复入口

运行层：SubagentRunController + RpcClient
  - 实时事件
  - 当前 turn 状态
  - steer / prompt / abort
  - 进程退出和重连
```

60 秒 retention 可以继续作为空闲进程回收策略。到期后只关闭 RPC 连接和清理临时 prompt 文件，不能让子会话失效。下一次输入使用 `--session <sessionFile>` 启动新的 RPC 进程并恢复同一 Session。

### 3.5 输入语义

子会话编辑器提交后按实际运行状态处理：

| 状态 | 行为 |
| --- | --- |
| Controller 存在且正在运行 | 调用 `steer` |
| Controller 存在且空闲 | 调用 `prompt` 开始新 turn |
| Controller 已回收或主程序重启 | 用 `--session <sessionFile>` 恢复 RPC，再调用 `prompt` |
| 当前 turn 需要取消 | 调用 `abort`，保留 Session |

完成后的继续输入不再使用 `follow_up` 模拟新 turn。`follow_up` 是运行队列语义；用户在独立子会话编辑器中提交一条新消息，应走普通 `prompt`。

恢复进程时根据父记录中的 `agent`、`agentScope`、`agentSource`、`cwd` 重新发现 Agent 配置，并沿用其模型、工具和 system prompt 启动参数。这与普通 Pi Session 恢复时重新读取当前项目资源的行为一致。找不到原 Agent 配置时保留 transcript 只读，并显示明确错误，不能静默换成同名的其他来源。

## 4. TUI 结构

### 4.1 主会话中的独立行组件

新增 `SubagentRunComponent`，每个组件只表示一个 Agent：

```text
● worker      运行中   修复分页逻辑
✓ reviewer    已完成   复核回归风险
! researcher  失败     查找接口调用链
```

组件持有自己的：

- `agentId`
- `sessionRef`
- Agent 名称和任务标题
- 当前 turn 状态、动作和更新时间
- 点击回调

parallel 和 chain 在 Tool Call 出现时就按参数创建全部行。partial result 到达后按结果索引绑定真实 `agentId/sessionRef`，随后按 `agentId` 更新。相同 Agent 名称、相同任务文本和输出换行都不会影响点击命中。

`ToolExecutionComponent.getAgentTargetAtRow()` 及其基于名称和行号的特殊逻辑删除。普通工具仍使用现有 `ToolExecutionComponent`。

### 4.2 子会话视图

新增全屏 `SubagentSessionViewComponent`。实现上使用覆盖主工作区的会话视图，主会话仍在后台运行。这样可以天然保留主会话的组件树、滚动位置、编辑器草稿和焦点。

视图结构保持操作型 TUI 的紧凑布局：

```text
← 主会话 · worker · 运行中
────────────────────────
子会话 transcript
...
────────────────────────
❯ 子会话输入框
```

具体行为：

- 点击左上角或按 `Esc` 返回主会话。
- 返回只关闭子会话视图，不取消正在运行的 Agent。
- `Ctrl+C` 取消当前子会话 turn，不影响主会话。
- transcript 支持现有尾部加载、向上分页、Tool 展开和实时流更新。
- 子会话有自己的编辑器实例和输入草稿。
- 子会话打开期间，主会话 Agent 和其他 Subagent 可以继续运行；返回后显示累计更新。

### 4.3 transcript 复用

从 `InteractiveMode.renderSessionItems()`、`renderSessionEntries()` 和实时 Tool 更新逻辑中提取最小的共享 transcript renderer。它只接收以下依赖：

- 目标 `Container`
- 会话 `cwd`
- tool definition 查询函数
- TUI 设置和主题
- pending Tool binding 集合
- render 请求回调

主会话和子会话共同使用这套 renderer，避免两套消息、Tool、Markdown 和错误状态渲染逐渐分叉。`SessionTranscriptSource` 继续负责 JSONL 尾部读取和向上分页。

子会话数据读取顺序：

1. 有活跃 Controller 时调用 RPC `get_entries` 获取内存中的最新 entries，并订阅实时事件。
2. Controller 已回收时从 `sessionFile` 使用 `SessionTranscriptSource` 读取。
3. 恢复 RPC 后重新对齐 `leafId`，按 entry ID 去重，再继续接收实时事件。

### 4.4 `/agents` 的职责

`/agents` 保留为当前父会话的子会话索引和运行监督入口：

- 列出父会话 branch 中所有 Subagent Session。
- 合并当前活跃 Controller 状态。
- 选择一项后打开同一个 `SubagentSessionViewComponent`。
- 运行中的项允许取消。

`AgentWorkbenchComponent.detailVisible`、手工详情滚动和临时输入弹窗删除。`/agents` 不再维护另一套详情页和输入路径。

## 5. 模式映射

### 5.1 Single

一个 Tool Call 创建一个子 Session 和一个 `SubagentRunComponent`。

### 5.2 Parallel

每个 task 创建独立 Session。所有行立即出现，状态分别更新。点击任意行只进入该 Session，其他任务继续运行。

### 5.3 Chain

每个 step 仍创建独立 Session。`{previous}` 只在首次执行 chain 时传递上一步最终文本，不把多个 step 合成一个 Session。

用户后续进入某一步继续对话时，只延续该步 Session，不自动重跑后续 step。父 Tool Call 已经完成的 chain 结果保持不可变，避免一次人工追问隐式触发整条链。

## 6. 状态与异常处理

### 6.1 状态拆分

界面状态由两部分组成：

```ts
type SubagentTurnState =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

type SubagentConnectionState = "attached" | "detached";
```

`turnState` 描述最近一次执行结果，`connectionState` 描述 RPC 是否还在。`detached + succeeded` 是正常的可恢复状态，不能显示成“不可控制”。

### 6.2 关键场景

| 场景 | 预期行为 |
| --- | --- |
| 首次 prompt 尚未完成 | 从活跃 RPC 展示实时 transcript，输入走 `steer` |
| turn 已完成，RPC 仍保留 | 输入走同一 RPC 的 `prompt` |
| retention 到期 | RPC 退出，Session 行仍可点击，输入时恢复进程 |
| 子进程异常退出 | 当前 turn 标记失败，已落盘历史仍可读，可再次输入恢复 |
| 主程序正常退出 | 停止所有子 RPC，不删除任何子 Session |
| 主程序重启并恢复父 Session | 从父 Tool Result 中恢复 Session 引用，直接读取子 JSONL |
| 子 Session 文件缺失 | 保留父会话摘要行，打开后显示文件缺失，禁止伪造空会话 |
| 子 Session 文件格式错误 | 显示读取错误和文件路径，不使用旧父消息覆盖真实错误 |
| 返回主会话 | 恢复原滚动位置、焦点和编辑器草稿，不取消后台任务 |

### 6.3 历史记录兼容

旧 Tool Result 没有 `session` 字段，无法补造真实子 Session。处理方式如下：

- 仍按每个旧 `result` 渲染独立行。
- 点击后使用旧 `messages` 构造只读历史视图。
- 明确标记“旧记录无独立会话”，不提供继续输入。
- 新记录只写 `session + finalOutput`，不继续扩展旧消息副本格式。

不执行批量 JSONL 迁移，也不根据 `runId/agentId` 伪造 Session 文件。

## 7. 代码改动范围

### 7.1 `packages/coding-agent/src/extensions/subagent/index.ts`

- 为每个 Agent 创建持久 Session，记录 `SubagentSessionRef`。
- 将 Controller 的运行连接与 Session 身份分离。
- 增加恢复现有 Session、普通 `prompt` 和实时事件订阅能力。
- retention 到期只回收进程。
- 父 Tool Result details 改为轻量结果，不再保存新会话的完整 `messages`。
- 保留 single、parallel、chain 现有输出顺序和主模型可见文本。

### 7.2 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

- 为 `subagent` Tool Call 创建独立行 binding，普通工具路径不变。
- 点击 `SubagentRunComponent` 时直接打开对应会话。
- 管理子会话全屏视图、输入提交、返回和活跃事件接入。
- `/agents` 改为索引入口。
- 删除 `sendSubagentMessage()` 临时弹窗路径。

### 7.3 新增 TUI 组件

建议新增：

- `components/subagent-run.ts`：主 transcript 中的单个 Agent 行。
- `components/subagent-session-view.ts`：子会话 transcript、编辑器和返回导航。
- `components/session-transcript-renderer.ts`：从 `InteractiveMode` 提取的共享 transcript 渲染逻辑。

组件名称可按现有目录习惯调整，职责边界保持不变。

### 7.4 `packages/coding-agent/src/modes/interactive/components/agent-workbench.ts`

- 只保留索引列表、选择、取消和返回。
- 删除 `detailVisible`、详情文本滚动、steer/follow-up 回调。
- 选择结果统一交给 `SubagentSessionViewComponent`。

### 7.5 `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

- 删除 Subagent 专用的 `getAgentTargetAtRow()` 和文本行匹配。
- 普通 Tool 渲染和展开行为保持不变。

### 7.6 RPC 与 Session 基础设施

`rpc-client.ts`、`rpc-types.ts`、`session-manager.ts` 当前能力足够，预期不新增协议。实现中若发现 `get_entries` 无法覆盖首个未落盘 user entry，只补齐现有 RPC 返回行为，不新建第二套传输协议。

## 8. 实施顺序

1. 先改 Subagent Controller：创建持久 Session，产出 `sessionId/sessionFile`，支持回收后按 Session 恢复。
2. 调整结果模型：父 Tool Result 保存 `session + finalOutput`，新记录停止保存完整消息副本。
3. 新增独立 `SubagentRunComponent` 和 Tool Call binding，删除行号反查。
4. 提取共享 transcript renderer，保证主会话现有渲染测试继续通过。
5. 实现 `SubagentSessionViewComponent`，接入历史读取、实时事件、编辑器提交和返回。
6. 将 `/agents` 收缩为索引，删除旧详情和临时输入路径。
7. 补齐旧记录只读兼容和进程退出、文件缺失等异常状态。
8. 完成单元测试、聚焦集成测试和真实 PTY 验收。

每一步都应保持 Coding Agent 可构建、已有主会话可运行，避免长期保留新旧两套可写子会话入口。

## 9. 测试方案

### 9.1 Extension 与 Session

在 `subagent-extension.test.ts` 增加：

- 首次运行创建真实 `sessionId/sessionFile`。
- 子 Session header 的 `parentSession` 等于父 Session 文件。
- single、parallel、chain 中每个结果都有不同 Session。
- 新 Tool Result details 不包含完整 `messages`，`content` 仍包含最终输出。
- retention 回收 RPC 后，使用同一 `sessionFile` 恢复并追加下一轮消息。
- 子进程异常退出后可以恢复同一 Session。
- 模拟 Extension 销毁和重新创建后，使用持久引用继续输入。

### 9.2 独立组件与点击

替换现有基于文本行号的测试，覆盖：

- parallel 和 chain 创建与结果数相同的顶层 `SubagentRunComponent`。
- 每个组件只返回自己的 `agentId/sessionRef`。
- 两个相同 Agent 名称仍能分别进入正确 Session。
- 任务标题换行、中文宽字符、40/60/80/120 列不影响点击。
- partial result 顺序变化时按 `agentId` 更新正确组件。
- Subagent 不再调用 `ToolExecutionComponent.getAgentTargetAtRow()`。

### 9.3 子会话视图

新增组件和 InteractiveMode 测试：

- 打开时读取 transcript 尾部，向上滚动继续分页。
- 活跃 RPC 事件实时进入当前子会话。
- running 提交走 `steer`，idle 提交走 `prompt`，detached 提交先恢复再 `prompt`。
- `Ctrl+C` 只取消当前子 turn。
- `Esc` 和点击返回都恢复主会话滚动、焦点和草稿。
- 子会话打开时主会话继续接收事件。
- 旧记录进入只读视图，不出现可提交编辑器。
- Session 文件缺失和格式错误有稳定错误态。

### 9.4 回归命令

聚焦验证：

```bash
npm --prefix packages/coding-agent test -- \
  test/subagent-extension.test.ts \
  test/agent-workbench.test.ts \
  test/tool-execution-component.test.ts \
  test/session-transcript-source.test.ts \
  test/interactive-tui.test.ts
```

静态检查和 Coding Agent 全量测试：

```bash
npm run check
npm --prefix packages/coding-agent test
```

### 9.5 真实 PTY 验收

使用独立 tmux socket 和临时 Session 目录验证：

1. 启动 parallel 两个 Agent，主 transcript 出现两个独立行。
2. 分别点击两个 Agent，确认 transcript、标题和 Session ID 不串线。
3. 在运行中发送引导，确认进入当前 Agent。
4. 完成后等待超过 retention，再次进入并发送新消息，确认恢复同一 Session。
5. 返回主会话，确认滚动位置、焦点和输入草稿不变。
6. 退出并重启主程序，恢复父 Session，再次进入两个子 Session 并继续输入。
7. 在 40、80、120 列下检查标题、状态、编辑器和返回入口无重叠。

## 10. 完成标准

满足以下条件后可认为本次优化完成：

- 主会话中每个 Subagent 都是独立 TUI 组件，点击不依赖文本搜索或行号推算。
- 每个新 Subagent 都有真实持久 `sessionId/sessionFile` 和正确父 Session 关系。
- 子会话支持历史、实时流、输入、取消和返回。
- RPC 回收、子进程退出和主程序重启后仍能恢复同一子 Session。
- `/agents` 与主 transcript 点击进入同一个子会话视图。
- 新父 Tool Result 不再重复保存完整子 transcript。
- single、parallel、chain 的主模型输出和执行顺序不回归。
- 聚焦测试、Coding Agent 全量测试、`npm run check` 和真实 PTY 路径全部通过。