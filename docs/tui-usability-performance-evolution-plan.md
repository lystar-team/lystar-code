# LYStar Agent TUI 易用性与性能后续优化方案

> 文档状态：已完成技术 Review，可按实施清单进入开发
> 评估日期：2026-08-08
> 项目基线：Pi `v0.84.1`，LYStar Agent `0.84.1-lystar.5`
> 评估范围：全屏 TUI、Session Resume、历史记录、Markdown/LaTeX/Mermaid、Tool 调用稳固性、完成摘要、Subagent 运行与监督
> 约束：保持 Session JSONL、Extension API、Tool、Provider、模型 ID 和 `PI_*` 契约兼容

## 1. 结论

LYStar TUI 已经解决全屏稳定性、固定输入区、长会话虚拟窗口、工具折叠、任务监督和 Diff 审阅等基础问题。后续最值得做的工作有七项：

1. **分离模型上下文与可见会话记录**。模型继续读取压缩感知上下文，界面改从完整活动分支分页读取。这样才能查看压缩前历史，继续扩大 `LystarWorkspace` 窗口没有作用。
2. **把 Resume 拆成首屏、运行时就绪、完整索引三个独立时刻**。先显示尾页，再准备模型上下文，最后补齐全树索引。当前同步读取、解析、建树和组件物化都在启动路径上。
3. **继续使用现有 Markdown renderer**。项目已经支持常用 Markdown、表格、代码块、链接、终端图片、LaTeX Unicode 渲染和 Mermaid 子集。后续重点是流式稳定性、超长内容降级、按宽度缓存和可见块重排。
4. **补齐 Tool 兼容与可恢复错误链路**。对 GPT 常见的 `apply_patch` 调用提供 LYStar 兼容 Tool；`edit` 重复匹配错误返回候选行号和明确重试方式，保持唯一匹配保护。
5. **按本轮最终结果生成完成摘要**。工具尝试失败只进入过程详情，不能直接把最终状态改成“完成但有问题”。最终失败、取消和未完成分别由 Assistant stop reason 与未结束 Tool 决定。
6. **把 Subagent 从 Tool Result 文本升级为结构化运行视图**。先补稳定 `agentId`、状态和动作事件，再做 Agent 工作台。只改 `renderResult()` 无法准确表达多个 Agent 的实时状态。
7. **使用现有 RPC 能力实现继续指令**。RPC 已有 `prompt`、`steer`、`follow_up`、`abort` 和 Session 操作。LYStar 负责界面与适配层，SessionManager 等 Pi 核心改动保持窄边界。

优先级建议：

| 优先级 | 工作 | 直接收益 |
|---|---|---|
| P0 | 完整 transcript 分页、压缩前历史可见 | 修复明确的历史缺失 |
| P0 | Resume 尾页首屏与性能基准 | 大 Session 打开后尽快可见 |
| P0 | Tool 兼容、`edit` 可恢复错误、完成摘要判定 | 减少日常无效重试和错误状态 |
| P1 | AgentRunRegistry、结构化事件、Agent 工作台 | 多 Agent 状态和动作可监督 |
| P1 | 窄终端布局规则、内容块降级 | 手机终端和小窗口可用 |
| P1 | Markdown 流式与宽度缓存 | 降低长回复重排成本 |
| P2 | 主 Agent/用户向 Subagent 继续指令 | 支持纠偏、追加任务和中断 |
| 暂缓 | 任意 Agent 互相对话、浏览器级 Markdown | 成本高，当前没有必要 |

### 1.1 Review 结论

2026-08-08 使用 6 个只读 Subagent 分别核验交互、Session、Tool、RPC、上游边界和测试。主会话随后回到源码复核。初版发现的阻塞已在本文修正：

| 初版缺口 | 本版修正 |
|---|---|
| Transcript 默认把文件最后一条当所有场景的活动 leaf | 冷启动允许发现持久化尾 leaf；运行中必须显式传入 `SessionManager.getLeafId()` |
| Opening View 只要求在 runtime 前，仍可能晚于全量 Session 打开 | 明确拆分 target resolve/open，在 `SessionManager.open()` 前显示 shell 和尾页 |
| overlay 行级点击链路不明确 | 明确复用 focused overlay 的 `handleInput()`、`parseMouseEvent()` 和 `overlayTop` 模式 |
| `apply_patch` 多文件结果无法进入当前单文件 `/changes` 聚合 | 定义 `details.files[]`，由 turn collector 合并多文件变更 |
| 完成摘要只有结果枚举，没有事件落点 | 明确记录最后一个 Assistant `message_end.stopReason`，在 `agent_settled` 统一判定 |
| RPC 迁移缺少等待、保留、终止和 chain 生命周期 | 增加 `SubagentRunController` 的完整生命周期和超时 |
| 新测试名称、性能阈值和 PTY 只有描述 | 区分现有/新增入口，并给出实现后直接运行的命令和 gate |

**开发判断**：P0 可以直接开工。每个工作单元先完成本文列出的最小测试，再接下一个单元。P1/P2 的接口、状态和退出条件已经明确，不需要开发者临场补产品规则。

这里的“可进入开发”只表示方案边界、接口、交互和验收已经明确。文档中的 `[ ]` 仍表示源码尚未实现；benchmark、自动测试和 PTY 结果需要开发完成后才能填写，不能把方案 Review 结论当成运行验证通过。

项目版本以 `packages/coding-agent/package.json` 的 `piConfig` 为事实源：Pi `v0.84.1`、LYStar Agent `0.84.1-lystar.5`。本地维护说明中仍出现的旧版本号不作为本方案基线。

## 2. 现有基础与证据

### 2.1 近期提交已经完成的能力

| 提交 | 已完成内容 | 对本方案的影响 |
|---|---|---|
| `c13ffe187`、`ea1e77e2d` | alternate screen renderer 与 viewport layout | 保持现有 renderer，不新增第二套终端渲染器 |
| `e4be6ca73`、`28087eede`、`65e9c300d` | 高频刷新合并、直连终端稳定、坐标漂移修复 | 后续优化不能破坏绝对坐标和校准链路 |
| `edbe8470c`、`6493bf058` | 长会话组件缓存和虚拟历史窗口 | 当前只虚拟化已物化组件，不能解决数据源缺失 |
| `5e7a180ca` | Session 恢复首帧和图片粘贴 | Resume 已有局部优化，仍存在全量 Session 读取成本 |
| `f030d37e2`、`6c25e3866` | Bash 分组和 Tool 记录统一 | Agent 动作应复用同类摘要和展开模式 |
| `73414d08b`、`a8ee03b81` | alternate screen 图片和布局重绘优化 | 图片与复杂内容继续走现有缓存和可见区策略 |
| `163cbef6b`、`a3e93ec85`、`0e496a61e` | 单行滚轮、半页滚动、全屏历史滚动修复 | 分页加载必须保持现有滚动语义和锚点 |
| `05e89b418`、`aa601d7ba` | LaTeX 渲染与空白、矩阵修复 | LaTeX 已进入维护期，无需重新选型 |
| `66534fbdc` | Mermaid 终端图接入 | 保留源码降级，不追求浏览器像素一致 |
| `e63bd5d46`、`555046f1f` | 任务监督视图和 `/changes` 审阅修正 | Agent 工作台应沿用“摘要 + 详情”的监督模型 |

已有方案 [tui-task-workbench-improvement-plan.md](./tui-task-workbench-improvement-plan.md) 已覆盖任务层级、活动条、完成摘要和变更审阅；[ci-tui-optimization-plan.md](./ci-tui-optimization-plan.md) 已覆盖虚拟窗口、滚动和渲染热点。本方案处理仍未解决的历史数据源、Resume、内容渲染边界、Tool 调用恢复、结果判定和多 Agent 控制面。

### 2.2 当前代码链路

```text
Session JSONL
    |
    v
main.ts 选择 SessionManager
    |
    v
SessionManager._setSessionFile()
    |- loadEntriesFromFile()        同步读取并 JSON.parse 全文件
    |- migrateToCurrentVersion()
    `- _buildIndex()                建立完整 byId/label/leaf 索引
            |
            +-> buildSessionContext()   模型上下文，压缩感知
            |
            `-> buildContextEntries()   当前也被初始 UI 渲染使用
                       |
                       v
createAgentSessionRuntime()
    |
    v
new InteractiveMode()
    `-> renderInitialMessages()
            `-> renderSessionItems()
                    `-> chatContainer
                            `-> LystarWorkspace 虚拟化已存在组件
```

这里有三个关键事实：

- `buildContextEntries()` 会保留最新 compaction、`firstKeptEntryId` 之后的保留项和 compaction 后的新项，压缩前的旧项会被省略。这个行为对模型上下文正确，对用户查看完整记录不正确。
- `LystarWorkspace` 只决定 `chatContainer` 中哪些组件进入当前渲染窗口。旧条目没有被 `renderSessionItems()` 物化时，滚到顶部也无法找回。
- `main.ts` 在创建 `InteractiveMode` 前已经同步打开 SessionManager 并创建完整 runtime。仅在 `InteractiveMode` 中增加尾页渲染，无法缩短启动空屏时间。

因此，历史截断的根因在数据投影层，Resume 慢的根因横跨启动编排、文件读取、索引、上下文构建和 UI 物化。

### 2.3 当前 Markdown 和图表能力

| 内容 | 当前能力 | 结论 |
|---|---|---|
| 标题、段落、强调、引用、列表 | `marked` 解析并输出终端样式 | 已具备 |
| GFM 表格 | 支持宽度计算和终端表格输出 | 已具备，需要窄宽降级 |
| fenced code、语法高亮 | 已接入代码块 renderer | 已具备，需要超长内容策略 |
| OSC 8 链接 | 按终端能力启用 | 已具备 |
| 图片 | Kitty/iTerm2 等终端协议及文字回退 | 已具备，受终端能力限制 |
| 行内和块级 LaTeX | 转为终端友好的 Unicode 公式 | 已具备常用子集，不等同完整 TeX 引擎 |
| Mermaid | `grok-mermaid` 转为 Unicode 图 | 已具备子集，`pie` 等不支持语法会保留源码 |
| 流式未闭合 Mermaid | 支持临时渲染 | 已具备，需降低重复计算 |
| 浏览器级 HTML/CSS 布局 | 无 | 不纳入 TUI 目标 |

“完整 Markdown”在终端中的合理定义应为：内容不丢失、常用结构可读、复杂结构有明确降级、原始源码始终可查看。浏览器级排版、任意 HTML、完整 TeX 宏包和全部 Mermaid 图型不适合作为 TUI 完成标准。

### 2.4 当前 Subagent 结构

内置 `subagent` Extension 通过独立 `pi --mode json -p --no-session` 子进程运行 single、parallel 和 chain：

- `SingleResult` 已保存 agent、task、messages、usage、model、exitCode、stopReason 和错误。
- parallel 使用 `exitCode === -1` 表示运行中，更新时返回整个 `SubagentDetails` 快照。
- `renderResult()` 把多个任务继续压在同一 Tool Result 中，缺少稳定 ID、明确状态机、当前动作和可寻址详情。
- 子进程使用 `stdio: ["ignore", "pipe", "pipe"]`，完成后退出，运行中无法继续发送指令。
- 当前结果是 Tool 的一次执行记录，多个子 Agent 还没有独立 Thread/Session 身份。

界面简陋只是表象。先补结构化运行模型，界面才能可靠展示和控制。

### 2.5 Tool 调用与完成摘要链路

当前两个日常错误最终走入同一条状态链：

```text
GPT 调用不存在的 apply_patch
    `-> Agent loop: Tool apply_patch not found, isError=true

edit 的 oldText 匹配到多个位置
    `-> applyEditsToNormalizedContent() 抛出 duplicate error
        `-> tool_execution_end(isError=true)
            `-> TrackedTurnTool.status = "error"
                `-> finishTurnActivity(): failedTools > 0
                    `-> formatTurnSummary(): "完成但有问题"
```

根因分为三层：

- **Tool 兼容层**：系统提示会列出 `read`、`bash`、`edit`、`write`，没有 `apply_patch`。GPT/Codex 系模型仍可能受既有 Tool 使用习惯影响调用 `apply_patch`。`packages/agent/src/agent-loop.ts` 对所有未知 Tool 只返回 `Tool <name> not found`，没有可用 Tool 列表和替代建议。
- **编辑诊断层**：`packages/agent/src/harness/tools/edit-diff.ts` 与 `packages/coding-agent/src/core/tools/edit-diff.ts` 会在 fuzzy normalization 后统计 `oldText` 出现次数。多于一次时拒绝写入是正确保护，但错误只给出次数，没有候选行号，模型只能重新读文件猜上下文。
- **结果聚合层**：`InteractiveMode` 把本轮每次 `tool_execution_end(isError=true)` 永久记为失败；`TurnSummaryComponent` 只看 `failedTools` 和 `cancelledTools`，没有本轮最终 Assistant stop reason，也没有“失败后已继续”的概念。

CodeGraph 影响面显示：

- `applyEditsToNormalizedContent()` 同时影响 Agent Harness、Coding Agent Tool preview/execute 及两组 Tool 测试。
- `finishTurnActivity()` 只由交互事件处理链调用，完成摘要改动可以留在 LYStar TUI 层。
- `formatTurnSummary()` 影响组件显示和 `task-workbench-components.test.ts`，没有 Session 或 Provider 契约影响。

旧方案 [tui-task-workbench-improvement-plan.md](./tui-task-workbench-improvement-plan.md) 第 7.4 节的“存在失败 Tool 即完成但有问题”规则由本方案第 7 节替代。

## 3. 目标体验

### 3.1 常规终端

- 打开 Session 后先看到最近对话、当前任务和输入区。
- 滚到当前已加载历史顶部时自动加载上一页，位置不跳。
- compaction 前的用户、Assistant、Tool 和自定义可见消息都能继续向前查看。
- 多 Agent 运行时，主 transcript 只显示一条紧凑总览；`/agents` 打开专用工作台查看每个 Agent。
- Markdown、公式和图表默认直接阅读，渲染失败时保留源码和原因。

### 3.2 窄终端和手机终端

TUI 的“移动端适配”指 SSH 客户端、手机终端和窄分屏，不涉及 Web 响应式页面。

| 宽度/高度 | 布局规则 |
|---|---|
| `>= 100` 列 | Agent 工作台可用列表 + 详情双栏；主 transcript 仍为单主栏 |
| `60-99` 列 | 单栏主界面；Agent 工作台用列表进入详情 |
| `40-59` 列 | 隐藏低优先级 header 字段；状态、Agent、表格全部单栏 |
| `32-39` 列 | 保留 transcript、状态、composer 和退出路径；复杂内容强制降级 |
| `< 12` 行 | 固定 composer 和一行状态；overlay 占用剩余正文区 |

视觉层级继续使用低噪声工程工作台方向：

1. 用户任务和当前运行状态最醒目。
2. Assistant 正文保持高可读性。
3. Tool、Agent 动作和系统消息使用较弱层级，错误保持直接可见。
4. 使用左侧轨道、短分隔线、图标和文字权重区分角色，不堆叠边框和卡片。
5. 不让 Agent 面板常驻挤压 transcript；需要时打开 overlay。

## 4. 完整 Transcript 与历史分页

### 4.1 数据职责分离

新增两个明确的数据投影：

```text
ModelContextProjection
    输入：当前活动分支
    规则：compaction-aware
    用途：发送给模型

TranscriptProjection
    输入：当前完整活动分支
    规则：不因 compaction 丢弃旧可见条目
    用途：TUI 历史、导出和审阅
```

Session JSONL 保持原样。`buildContextEntries()` 的模型语义保持原样。TUI 不再把它当完整 transcript。

建议新增 LYStar 层文件：

```text
packages/coding-agent/src/modes/interactive/session-transcript-source.ts
```

最小接口：

```ts
interface TranscriptPage {
  entries: SessionEntry[];
  previousCursor?: string;
  hasMore: boolean;
}

interface TranscriptSource {
  readTail(options: { leafId: string | null; limit: number }): Promise<TranscriptPage>;
  readPrevious(cursor: string, limit: number): Promise<TranscriptPage>;
  reset(leafId: string | null): void;
}
```

`cursor` 是不透明字符串，至少绑定 `sessionId`、本次活动 `leafId`、下一待查 `parentId`、反向扫描 byte offset 和文件 rewrite generation。UI 不依赖 offset 细节。

`leafId` 的来源必须明确：

- 冷启动、尚未创建 SessionManager 时，reader 从文件末尾找到最后一条有效非 header 记录。它与当前 `_buildIndex()` 打开文件后的初始 leaf 规则一致。
- SessionManager 就绪后，始终传入 `sessionManager.getLeafId()`。
- branch、tree navigation、fork、resume 或 session switch 成功后，调用 `reset(sessionManager.getLeafId())`，清空旧页和 cursor。
- 文件 append 只延长当前分支时，旧的向前 cursor 仍可继续；文件 rewrite、truncate、session switch 或 leaf 跳转会让 cursor 失效并重新读 tail。

### 4.2 无索引读取

Session 是 append-only parent chain。首版使用反向 JSONL 扫描：

1. 冷启动没有显式 `leafId` 时，从末尾寻找最后一条有效非 header 记录，只用于确定打开文件后的初始 leaf。
2. 运行中直接使用 `SessionManager.getLeafId()`；不能把物理文件尾当作当前 leaf，因为 `branch()` 可以只移动内存 leaf，尚未追加新记录。
3. 以 `wantedId = leafId` 开始反向扫描。只在记录 `id === wantedId` 时接纳该记录，然后令 `wantedId = parentId`。
4. label、model change、thinking change 等不可见控制记录继续参与 parent chain，但不计入页面的可见条目数量。
5. 收集到指定数量的可见条目后停止，cursor 保存当前 byte offset 和下一个 `wantedId`。
6. `readPrevious()` 从 cursor 继续，返回顺序统一为从旧到新；兄弟分支因为 ID 不匹配自然跳过。

这个算法不需要改变 Session 文件，也不需要先解析全部 JSONL。分支跨度极大时最坏会扫描较多字节，所以先基准无索引路径，再决定 sidecar。

实现时不能在 candidate 行上重新做第二套搜索。当前版本的 reverse scanner 与 `loadEntriesFromFile()` 使用相同 JSONL parse/malformed-line 规则；Session migration 仍只由 SessionManager 负责。

### 4.3 可重建 sidecar 索引

无索引反向扫描跑通并有基准后，再增加可重建索引：

```text
<session>.jsonl.idx
```

索引只保存：

```text
session file size
session mtime
header/session id
entry id
parent id
type
byte offset
byte length
last persisted entry id
```

约束：

- JSONL 仍是唯一事实源。
- 索引缺失、版本不匹配、文件被 rewrite/truncate、文件前缀校验不一致时直接废弃并重建。
- 正常 append 可以增量追加，不因 mtime 单独变化而把可用旧索引全部作废。
- 临时文件写完后 rename，避免半份索引被读取。
- append 时增量追加索引；Session rewrite 后重建。
- 读取错误时退回无索引路径，不影响 Session 可用性。
- 索引不进入导出、同步和兼容契约。

### 4.4 UI 接入

`LystarWorkspace` 保持现有组件虚拟化职责，新增分页协调状态：

```text
idle -> loading -> idle
              `-> exhausted
              `-> failed/retryable
```

加载上一页时：

1. 记录当前顶部锚点的 `entryId` 和该组件首行相对 viewport 的行偏移。
2. 将新组件插入 `chatContainer` 头部。
3. 重新计算高度后，把同一锚点恢复到原行偏移。
4. 对同一 cursor 去重，避免滚轮和 PageUp 重复发请求。
5. 加载提示属于历史区，不进入终端原生 scrollback。

对照 Codex CLI 的可借鉴点是 cursor、请求去重、加载态和 prepend 后的位置保持。LYStar 继续使用现有 alternate screen 和 `LystarWorkspace`，不复制 Codex 的 ratatui 实现。

### 4.5 正确性门槛

- compaction 前的可见条目能一直加载到活动分支根节点。
- 分支 Session 在冷启动和运行中 leaf 跳转后都只展示目标 leaf 的祖先链，不混入兄弟分支。
- `branch()` 只移动内存 leaf 且尚未 append 时，分页仍从 `getLeafId()` 指定的分支读取。
- label、model change、thinking change 等控制项不错误显示，但不能破坏 parent chain。
- malformed line 的处理与现有 `loadEntriesFromFile()` 一致。
- 加载一页后锚点偏移误差不超过 1 行。
- 同一 entry 不重复物化。
- streaming 期间加载历史不会改变当前 streaming block 身份。
- `Ctrl+O` 展开状态、Tool 分组和图片组件在分页后保持有效。

## 5. 大 Session Resume

### 5.1 拆分时间指标

Resume 不再只记录一个总耗时，至少测量：

| 指标 | 定义 |
|---|---|
| `T_shell` | alternate screen、header、composer 和加载状态首次可见 |
| `T_tail` | 最近一页 transcript 可见 |
| `T_context_ready` | 模型上下文可发送，输入解除只读 |
| `T_index_ready` | 完整树/sidecar 可用于 branch、tree 和历史分页 |
| `M_peak` | Resume 过程 Node/Bun 峰值 RSS |
| `R_resize` | Resume 后首次 resize 的重排时间 |

UI 状态：

```text
正在打开会话 -> 最近记录可见 -> 正在准备上下文 -> 可输入
                                      `-> 历史索引后台完成
```

如果上下文尚未就绪，composer 可见但只读，避免用户输入后无明确去向。

### 5.2 启动协调边界

当前 `main.ts` 在 `createSessionManager()` 内直接调用 `SessionManager.open()`，全量同步读取、migration 和 `_buildIndex()` 已经发生；此后才创建 runtime 和 `InteractiveMode`。因此 opening view 必须出现在 `SessionManager.open()` 之前。

先把现有流程拆为两个职责：

```ts
interface ResolvedSessionTarget {
  path?: string;
  cwd: string;
  mode: "new" | "open" | "fork";
}

resolveSessionTarget(parsed, cwd, sessionDir): Promise<ResolvedSessionTarget>
openSessionTarget(target): SessionManager
```

`--session`、`--resume`、`--continue` 和已有 session id 都先只解析目标路径；`--continue` 需要把“查找最近路径”和“打开 Session”拆开。new/no-session/help 等无需渐进打开的路径继续走原流程。

interactive-only `SessionOpenCoordinator` 接线顺序：

```text
用户确认或 CLI 解析出 session path
    `-> 启动复用 alternate-screen renderer 的 SessionOpeningView
        |- 轻量读取首个 session header，确认 session id/cwd
        |- TranscriptSource.readTail({ leafId: persistedTailId })
        |      `-> 显示最近记录
        `- SessionManager.open() -> runtime -> InteractiveMode
               `-> 用 getLeafId() 校验/重置 TranscriptSource 后接管同一 renderer
```

约束：

- `T_shell` 从 session path 确定时开始计时；resume picker 自身不计入打开耗时。
- `SessionOpeningView` 复用现有 alternate-screen TUI、主题和 terminal cleanup，不直接写另一套 ANSI 画面。
- reverse scanner 只直接处理当前 Session 版本；header 显示旧版本时先显示 shell/loading，由 `SessionManager.open()` 完成全量 migration 后按正式 leaf 重读，不能在两个模块各实现一套 migration。
- runtime 接管前比较 cold-open leaf 与 `sessionManager.getLeafId()`；不一致时丢弃尾页并按正式 leaf 重读。
- 启动 Resume 和运行中的 `/resume` 共用同一状态模型；运行中切换时保留原 Session，直到新 SessionManager/runtime 成功。
- 打开失败或取消时关闭 opening view。启动路径显示错误后退出；运行中 `/resume` 返回原主会话。
- 仅优化 `InteractiveMode.renderInitialMessages()` 不计入 `T_shell` 或 `T_tail`，因为那时全量 Session 已经读取完成。

### 5.3 落地顺序

1. **先建立基准**：生成固定 16 MB、64 MB、256 MB Session，覆盖长 Tool 输出、图片引用、compaction 和分支。
2. **尾页先显示**：session target 解析完成后、`SessionManager.open()` 前启动 `SessionOpeningView`，通过 `TranscriptSource.readTail({ leafId, limit })` 物化最近 80-120 个可见块。
3. **减少正式 UI 初始组件量**：runtime 就绪后，`renderSessionItems()` 只处理当前 transcript 页；Markdown 和 Tool 组件延迟到进入可见区时创建。
4. **后台准备完整能力**：现有 SessionManager 全量读取移出首个画面路径，完成后绑定 runtime 并切换到可输入状态。
5. **根据基准决定是否改 SessionManager 内部存储**：如果 `T_context_ready` 仍被全量解析主导，再引入 indexed/lazy entry store。

第 2 项改善首屏，第 4 项改善启动空屏，第 5 项改善真实可交互时间。三者需要分别验收。

### 5.4 SessionManager 的最小核心改动

只有基准证明必要时，修改 `SessionManager` 内部：

- 公共方法名、返回类型、Session JSONL 和 Extension 访问方式保持不变。
- `getBranch()`、`buildSessionContext()` 优先按活动链读取需要的 entry。
- `getEntries()`、`getTree()`、branch picker 等明确需要全树的操作触发完整 materialize。
- append、rewrite、migration 继续由 SessionManager 负责。
- 新的索引/reader 放独立模块，`session-manager.ts` 只保留窄接线。

这部分适合拆成可独立提交并尝试上游，避免 LYStar 长期维护一套 Session 核心。

### 5.5 性能门槛

在同一台基准机、冷缓存和热缓存各运行 10 次，记录 median 和 p95：

| Session | `T_shell` p95 | `T_tail` p95 | 目标 |
|---|---:|---:|---|
| 16 MB | `<= 200 ms` | `<= 300 ms` | PR 快速回归 |
| 64 MB | `<= 250 ms` | `<= 700 ms` | 不出现数秒空屏 |
| 256 MB | `<= 300 ms` | `<= 1500 ms` | 保持渐进加载 |

同时要求：

- 如果当前 `T_context_ready` 基线高于 2 秒，优化后 median 至少下降 50% 且目标不高于 1 秒；如果基线已经不高于 1 秒，允许波动不超过 10%。
- `M_peak` 相比当前基线下降至少 30%，如果仅做尾页首屏而未改全量存储，则该项记录为未完成。
- 首帧期间 event loop 单次阻塞不超过 50 ms；同步磁盘读取不得覆盖整个文件。
- `R_resize` p95 不超过 50 ms；索引后台运行期间连续输入 20 个字符不能丢字或乱序。
- 16 MB PR fixture 必须满足绝对阈值；64/256 MB 在固定基准机执行 Release gate。

## 6. Markdown、LaTeX 与 Mermaid

### 6.1 支持等级

每类内容明确标记三种支持等级：

- `native`：终端直接渲染。
- `fallback`：转换为可读的终端结构。
- `source`：保留源码，并显示简短原因。

建议矩阵：

| 内容 | 默认等级 | 窄终端策略 |
|---|---|---|
| 普通 Markdown | native | 正常换行 |
| 表格 | native/fallback | 宽度不足时切换逐行字段视图 |
| code block | native | 先显示受控高度，完整内容进入展开视图 |
| LaTeX 常用语法 | fallback Unicode | 无法转换时显示原公式 |
| Mermaid flowchart 子集 | fallback Unicode | 图过宽时保留源码或打开详情视图 |
| 不支持 Mermaid 图型 | source | 显示源码和一行原因 |
| 终端不支持图片 | source/fallback | 显示文件、类型和尺寸信息 |

不引入 Chromium、KaTeX DOM renderer 或新的 Mermaid 浏览器运行时。它们会显著增加二进制、启动和平台维护成本，也无法保证普通终端体验。

### 6.2 流式渲染

当前 `Markdown` 已按 source 和 available width 缓存 transformer 结果，但流式 `setText()` 会让整个消息重新解析。后续按以下顺序优化：

1. 先加 profiler，记录每次 Markdown parse、transform、render 的字节数和耗时。
2. 流式期间只允许 Mermaid 在完整 fence 或当前尾部未闭合 fence 中转换。
3. 缓存已稳定的块级 token 前缀，只重算最后一个发生变化的 block。
4. 消息完成后做一次最终全量校正，替换流式临时结果。
5. resize 时只重排可见 Markdown 组件；离屏组件进入窗口时再按新宽度渲染。

若 64 KB 连续 Markdown 在 80 列下的单次重排已经低于 16 ms，可暂缓块级 token cache，只保留测量和可见区重排。

### 6.3 超长内容

- 单个 code block 超过 200 行时，transcript 默认显示头尾摘要和总行数，`Ctrl+O` 或详情 overlay 查看完整内容。
- 表格列宽超过可用宽度时，优先缩短空白和可断行文本；仍不够时切换为每行一条记录，不能直接截掉右侧列。
- Mermaid 超过当前宽度时保留源码和“图表宽度超出当前终端”，不反复尝试相同宽度。
- 长 URL、路径和无空格字符串必须硬换行，不能撑破 viewport。
- renderer 失败不得丢失原始内容。

### 6.4 验收

- 40、60、80、120 列下覆盖标题、嵌套列表、表格、代码、OSC 8、图片回退、LaTeX、Mermaid。
- streaming/final 两种模式的最终文本一致。
- 连续 resize 不出现旧宽度缓存污染。
- 不支持的 LaTeX/Mermaid 输入保留完整源码。
- 64 KB Markdown、500 行 code block、50x20 表格和大型 Mermaid 有独立耗时基准。

## 7. Tool 调用稳固性与结果判定

### 7.1 目标与原则

- 模型调用了错误 Tool 名时，直接告诉它当前可用 Tool 和替代方式，让同一轮自动纠正。
- `edit` 继续要求每个 `oldText` 唯一，不能自动挑第一个匹配，也不能默认 replace-all。
- Tool 尝试失败和本轮最终失败分开记录。
- 错误详情继续可见，完成摘要不把已经恢复的过程错误升级成最终问题。
- 新能力集中在 Tool 适配、错误诊断和 LYStar 工作台，不修改 Session JSONL。

### 7.2 `apply_patch` 兼容

#### 根因

GPT/Codex 系模型对 `apply_patch` 有较强的既有调用习惯。当前 system prompt 只列出活动 Tool 和 `edit` 指南，但没有明确说明 `apply_patch` 不可用。模型一旦调用，Agent loop 只返回未知 Tool 错误，随后这次错误又污染完成摘要。

#### 处理方式

采用两层处理：

1. **系统提示纠偏**：当活动 Tool 包含 `edit` 且不包含 `apply_patch` 时，动态加入一句明确规则：`apply_patch is unavailable; use edit with unique oldText/newText replacements.`。这条规则必须根据实际活动 Tool 生成，不能写死在全局提示中。
2. **LYStar 兼容 Tool**：增加内置 Extension Tool `apply_patch`，接收 GPT 常见的 patch 字符串并转换为现有文件修改操作。模型即使忽略提示，也不会落入未知 Tool。

建议文件：

```text
packages/coding-agent/src/extensions/apply-patch/index.ts
```

兼容 Tool 的边界：

- 参数 schema 使用一个必填字符串字段 `input`；`prepareArguments` 兼容模型发出的 `patch` 字段或原始单字符串输入。OpenAI grammar tool 可用时复用项目现有 constrained sampling 能力约束 patch 文本。
- 支持常见 `Add File`、`Update File`、`Delete File`；首版不实现 rename/move，遇到时返回明确错误。
- 先按规范化绝对路径排序，并以固定顺序进入现有 `withFileMutationQueue()`，在同一组锁内读取、校验、暂存和写入，避免并发 edit/write 插入 patch 中间。
- Update 复用当前 exact/fuzzy match、换行符、BOM、mutation queue 和 diff 生成能力。
- Add/Delete 复用现有 Write 与文件访问能力，不通过 Shell 拼接文件。
- 多文件写入前保留原内容；写入中途失败时回滚已修改文件并报告。进程崩溃下不承诺跨文件系统事务原子性。
- 作为 hidden built-in Extension 注册后，继续走现有 `allowedToolNames`、`excludedToolNames` 和 active Tool 过滤；`--no-extensions`、`--tools`、`--exclude-tools apply_patch` 必须按现有语义生效。
- LYStar built-in Extension 按现有加载顺序拥有 `apply_patch` 名称；同名 Extension 保持当前 first-registration 行为，不新增覆盖规则。合并到提供同名 Tool 的 Pi 版本时，Release gate 必须先删除 LYStar adapter。

多文件变更需要显式接入当前单文件 turn collector：

```ts
interface ApplyPatchDetails {
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    diff: string;
  }>;
}
```

`tool_execution_end` 读取 `details.files[]`，规范化每个 path，写入 `TrackedTurnTool.files`；`getCurrentTurnFiles()` 按 path 合并后供完成摘要和 `/changes` 使用。不能只返回一个总 diff，因为当前 `getTrackedToolDisplay()` 和 `/changes` 聚合只认识单个 `filePath`。

未知 Tool 的通用错误也需要改进：

```text
Tool "apply_patch" is unavailable.
Available tools: read, bash, edit, write.
For file changes, retry with "edit".
```

这项通用改进放在 `packages/agent/src/agent-loop.ts`，只改变错误内容，不改变 Agent 事件或 Tool Result 格式，适合独立上游。

#### 验收

- GPT 发出 `apply_patch` 后能够完成 Add、Update、Delete，并生成真实 diff。
- patch 中任一文件校验失败时，不写入任何文件；注入第二个文件写入失败时，第一个文件恢复原内容。
- 多文件成功结果全部出现在本轮完成摘要和 `/changes` 中。
- `--no-extensions`、`--tools edit` 或 `--exclude-tools apply_patch` 时，`apply_patch` 不在活动 Tool 中。
- 旧模型继续使用 `edit`，行为不变。
- 同名第三方 Extension 继续遵循现有 first-registration 行为，不新增重复注册错误；合入提供同名 Tool 的 Pi 版本前必须删除 LYStar adapter。

### 7.3 `edit` 重复匹配恢复

#### 根因

当前唯一匹配规则可以避免改错位置，问题在错误反馈：

```text
Found 3 occurrences ... Each oldText must be unique. Please provide more context.
```

模型只知道“有三个”，不知道它们在哪里，常见结果是再次提交同一段过短 `oldText`，或扩大到很长的整段文件。

#### 处理方式

保留失败和原子性，增强诊断：

```text
Found 3 occurrences of edits[0] in src/example.ts at lines 18, 47, 92.
Include one stable unchanged line before or after the intended block, then retry.
No changes were written.
```

实现要求：

- exact 路径直接复用本次 `findAllOccurrences()` 得到的所有 match offset。
- fuzzy 路径由 `normalizeForFuzzyMatch()` 同一次扫描返回 match offset；建立 normalized line-start table，把 offset 映射为原文件行号。现有 normalization 按行处理，映射必须保持换行边界。
- 不得为了生成错误文本再运行另一套 `indexOf` 或正则搜索，否则候选行号可能与真正拒绝写入的位置不同。
- duplicate error 最多返回前 5 个起始行号，更多位置显示 `+N more`。
- 多 edit 调用中任一项失败时继续保持零写入。
- schema 和 system prompt 把“small”改成“smallest unique block”，并明确重复代码需要带一行稳定上下文。
- 不增加 `occurrence: 2`、`replaceAll: true` 等默认逃生参数。需要批量替换时，由模型明确提交多个互不重叠的唯一 edit。
- `packages/agent` Harness 与 `packages/coding-agent` Tool 的两份实现和测试同步修改，避免 Server/TUI 行为不一致。

#### 验收

- exact、fuzzy、CRLF、BOM 和 Unicode normalization 下的候选行号正确。
- 100 个以上重复位置时错误输出仍受控。
- 模型依据错误返回的行号补上下文后，下一次 edit 成功。
- 失败 edit 不产生文件写入、diff 或 `/changes` 记录。

### 7.4 完成摘要状态模型

#### 根因

当前摘要使用：

```ts
failedTools > 0 || cancelledTools > 0
  ? "完成但有问题"
  : "完成"
```

这个规则把过程事件当成最终结果。`apply_patch` 未找到后改用 `edit` 成功、`edit` 重复后补上下文成功、测试先失败后修复通过，都会被标成“完成但有问题”。

#### 新状态

```ts
type TurnOutcome = "completed" | "failed" | "incomplete" | "cancelled";
```

判定顺序：

1. 用户取消、Assistant `stopReason === "aborted"`：`cancelled`。
2. 最终 Assistant `stopReason === "error"`：`failed`。
3. `agent_settled` 时仍有 pending/running Tool，或最终 `stopReason === "length"` 且没有成功 compaction/continuation：`incomplete`。
4. 正常 `stop` 或 Tool 链完成后正常结束：`completed`。

Tool 错误单独保留：

```ts
interface TurnSummaryData {
  outcome: TurnOutcome;
  toolErrors: number;
  // 现有文件、命令、耗时等事实继续保留
}
```

显示规则：

```text
完成 · 修改 2 个文件 · 命令 2/3 · 1m12s
执行失败 · 2 个操作成功 · 1 个操作未完成 · 36s
未完成 · 输出达到长度限制 · 48s
已取消 · 完成 3/6 个操作 · 21s
```

- 折叠摘要的主状态只看 `outcome`。
- `命令 2/3` 等事实继续直接显示，不能把失败记录藏掉。
- 展开后显示全部失败 Tool、首条错误和“发生过重试/压缩”等过程信息。
- `toolErrors > 0` 但 `outcome === "completed"` 时使用正常完成图标；展开提示“过程中有 N 次 Tool 调用失败，Agent 已继续处理”。
- 无 Tool 的纯回答继续不显示摘要。

`TurnActivityCollector` 增加：

```ts
lastAssistantStopReason?: AssistantMessage["stopReason"];
hadUnfinishedTools: boolean;
```

事件落点：

1. 每个 Assistant `message_end` 都更新 `lastAssistantStopReason`；`toolUse` 只是中间值，后续 Assistant 会覆盖。
2. `agent_end.willRetry === true`、`compaction_end.willRetry === true` 时不结算，等待后续 Assistant。
3. `agent_settled` 是唯一结算点。结算前先记录是否仍有 pending/running Tool，再把它们转成 error/cancelled 供详情显示。
4. 最后一个 stop reason 为 `stop` 才是正常完成；`error` 为失败，`aborted` 或明确用户取消为已取消，`length`、`toolUse`、缺少最终 Assistant 或仍有未结束 Tool 为未完成。
5. 成功 compaction/auto-retry 会产生后续 Assistant `message_end`，因此最终 stop reason 自然覆盖之前的 `length/error`，不需要猜测“是否恢复”。
6. Tool error 数量只进入 `toolErrors` 和展开详情，不参与 `outcome` 主状态。

这条链使用现有 `message_end`、`agent_end`、`compaction_end` 和 `agent_settled`，无需修改 Session 或 Agent core 事件格式。

#### 验收

- `apply_patch` 未找到后 `edit` 成功：显示“完成”。
- `edit` duplicate error 后补上下文成功：显示“完成”。
- 测试先失败、修复后测试通过：显示“完成”，展开可见首次失败。
- 最终 Assistant error：显示“执行失败”。
- 用户中断：显示“已取消”。
- length 且没有成功 continuation：显示“未完成”。
- Tool error 仍保留在 transcript 和展开详情中。

### 7.5 观测指标

在本地回归样本中记录：

| 指标 | 目标 |
|---|---:|
| 未知 `apply_patch` 导致整轮停止 | 0 |
| duplicate error 二次提交仍使用同一 `oldText` | `< 5%` |
| 已恢复 Tool 错误被标成最终问题 | 0 |
| 真正 error/aborted/length 被标成完成 | 0 |
| patch 校验失败时产生文件写入 | 0 |
| 可注入写入失败场景未恢复原内容 | 0 |

## 8. Subagent 工作台

### 8.1 运行模型

先在 Extension 内增加结构化状态，保持 Tool API 和 Session 格式不变：

```ts
type AgentRunState =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

interface AgentRunSnapshot {
  agentId: string;
  runId: string;
  agent: string;
  task: string;
  state: AgentRunState;
  currentAction?: string;
  startedAt?: number;
  updatedAt: number;
  elapsedMs?: number;
  model?: string;
  usage: UsageStats;
  error?: string;
}
```

`agentId` 在一次 subagent tool call 内稳定，`runId` 标识整个 single/parallel/chain 调用。完成结果继续写入 `SubagentDetails`，旧 Session 和旧 renderer 仍可读取。

最小事件集合：

```text
run_started
agent_started
agent_action
agent_message
agent_waiting
agent_finished
agent_failed
agent_cancelled
run_finished
```

事件来自现有 JSON event stream：

- `message_end` 更新消息、usage、model 和 stopReason。
- Tool call start/end 更新 `currentAction`。
- 子进程 close 更新终态。
- AbortSignal 更新 cancelled。

`AgentRunRegistry` 只保存当前进程中仍可控制的运行态，不成为第二个持久化事实源：

- Tool execute 开始时创建 `runId` 和每个 `agentId`。
- 原始 JSON/RPC 事件更新 active snapshot；最终结果仍写入 `SubagentDetails`。
- `SubagentDetails` 增加可选 `runId`、`agentId`、`state` 和有限事件摘要。旧 Session 没有这些字段时，用 `toolCallId + itemIndex` 生成仅用于显示的稳定 ID。
- 工作台 view model 合并“active registry + 当前 Session 中的 SubagentDetails”；同一 `runId/agentId` 以 active snapshot 覆盖旧快照。
- 子进程关闭且最终 Tool Result 已写入后，从 registry 删除 active controller；完成记录继续从 `SubagentDetails` 渲染。
- session switch、reload、主进程 shutdown 时清理 registry 和全部 idle timer。

这样 active registry 负责控制，Tool Result details 负责审计。Session Resume 不需要恢复运行中的 Agent，也不增加新的 Session entry type。

### 8.2 界面结构与返回路径

主 transcript 的折叠态显示 Agent 总数和有限行摘要：

```text
并行 Agent  2 运行 · 1 完成 · 0 失败 · 01:42
  reader   读取 Session 加载链路        运行  rg session...
  worker   设计 Agent 工作台状态模型    完成  38s
  reader   核对 Codex 历史分页          等待
```

任务名称直接来自父 Agent 调用 subagent 时传入的 `task`：取第一行非空文本、合并连续空白，再按当前宽度截断。没有 `task` 时才回退为 `reader #1`、`worker #2`。不依赖 Pi 自动生成 Session Title，也不额外调用模型生成标题。

点击规则：

- 单击汇总标题，打开 Agent 工作台。
- 单击某一 Agent 行，只选择并打开这个 `agentId` 的详情，不展开其他 Agent。主 transcript 中的 Subagent 组件暴露结构化 `getAgentTargetAtRow(row)`；`handleWorkspaceInput()` 在通用展开判断前读取该 target，并调用 `showAgentWorkbench({ runId, agentId })`。
- 点击 Agent 行本身不会发送继续指令、取消任务或改变主 transcript。
- mouse 开启时，`AgentWorkbench` 作为 focused overlay 在自己的 `handleInput()` 中调用现有 `parseMouseEvent()`；按 `ChangesSelector` 的 `overlayTop + rendered row` 模式计算 Agent 行，不依赖 `LystarWorkspace.handleWorkspaceInput()`。
- Agent 列表每次 render 保存 `row -> agentId` 映射；单击只修改 `selectedAgentId`。
- mouse 关闭时，通过 `/agents` 进入工作台，上下键选择，Enter 与单击行为一致。
- `Ctrl+O` 保持现有全局 Tool 展开契约；Subagent 的 expanded renderer 只增加可见 Agent 摘要行，不渲染所有完整输出。完整输出始终进入单 Agent 详情。

宽终端：

```text
>= 100 列
← 主会话   Agent 列表 ────────┬ 当前 Agent 详情 ──────────────
            状态 名称 耗时     │ 任务、当前动作、最近事件、输出
                               │ usage、继续指令、中断
```

单击其他 Agent 行时只更新右侧详情，工作台保持打开。

窄终端：

```text
< 100 列
主会话 -> Agent 列表 -> 单 Agent 详情
   ^            |             |
   `------------+-------------'  点击“← 主会话”直接返回
```

返回规则：

- Agent 列表和单 Agent 详情顶部始终显示可点击的 `← 主会话`。
- 点击 `← 主会话` 直接关闭工作台，返回打开前的主 transcript。
- Esc 在详情页先返回 Agent 列表；在列表页返回主会话。
- 返回时恢复主 transcript 的滚动锚点、当前焦点和 composer 未发送内容。
- 返回主会话不会中断 Agent，运行状态继续在后台更新；再次打开 `/agents` 时恢复上次选中的 `agentId`。

Agent 详情中的命令保持显式：

- 运行中 Agent 提供“追加指令”“完成后继续”“中断”。
- 已完成 Agent 提供“查看完整输出”和“继续该会话”，前提是启用了持久 Session。
- 详情动作需要用户单独点击或确认，选择 Agent 本身不触发动作。

第一版不增加常驻侧栏和新的全局快捷键。使用 `/agents`、行级 mouse hit region 和现有 overlay API 完成核心流程。

### 8.3 进程模型升级

继续指令需要把当前一次性 JSON 子进程替换为现有 RPC 协议和 typed client：

```text
当前：pi --mode json -p --no-session，stdin=ignore，任务结束即退出
目标：pi --mode rpc，stdin/stdout JSONL，父进程持有 RpcClient
```

RPC 已提供 `prompt()`、`steer()`、`followUp()`、`abort()`、`getState()`、Session 切换、entries 和 tree 操作。需要补的通用能力是可执行命令和进程生命周期。

`RpcClientOptions` 增加：

```ts
command?: string;       // 默认 node
commandArgs?: string[]; // 默认 [cliPath]
```

`start()` 最终执行：

```ts
spawn(command, [...commandArgs, "--mode", "rpc", ...args])
```

Subagent 复用 `getPiInvocation()` 生成 command/commandArgs，兼容源码 Node 入口和打包后的 LYStar 二进制。

每个子 Agent 使用一个 `SubagentRunController`：

```text
spawn -> subscribe events -> prompt -> wait agent_settled
     -> running controls: steer / follow_up / abort
     -> settled: 写入 SubagentDetails，进入 60 秒 idle retention
     -> retention 内 follow_up: 取消 timer，再等下一次 agent_settled
     -> timer 到期/session switch/shutdown: RpcClient.stop()
```

生命周期规则：

1. single 和 parallel 都只调用 `runController.start(task)`；parallel 继续使用现有并发上限。
2. chain 仍由父层顺序调度，每一步等待 `agent_settled`，再把最终 Assistant 文本替换到下一步 `{previous}`。
3. Registry 监听原始 `message_*`、`tool_execution_start/end`、`queue_update`、`agent_end`、`agent_settled`。现有只读取 `message_end/tool_result_end` 的 JSON adapter 不再作为实时状态来源。
4. `agent_end.willRetry` 只更新为 retrying/waiting；只有 `agent_settled` 可以结束一次任务等待。
5. 运行中“追加指令”调用 `steer()`；“完成后继续”调用 `followUp()`。Agent 已 settled 但仍在 60 秒 retention 内时也可 `followUp()`。
6. retention 到期后，默认 `--no-session` Agent 的“继续”置灰并说明进程已关闭；只有显式启用持久 Session 才能重新启动并 resume。
7. 用户取消整个 subagent Tool 时，并行向所有 controller 发送 `abort()`；等待最多 2 秒收到 `agent_settled`，随后 `stop()`，超时复用现有进程树 SIGTERM/SIGKILL 逻辑。
8. 子进程异常退出时拒绝所有 pending RPC request，Agent 状态置为 failed，并清理 timer、listener 和进程句柄。
9. 主进程退出、Extension reload 和 Session switch 共用同一个 `disposeAll()`，不能遗留 RPC 子进程。
10. 保留当前 `--no-extensions`、`--exclude-tools subagent`、模型、工具范围和 system prompt 参数。

第一版保留 60 秒固定 retention，不增加设置项。真实使用证明过短或进程占用明显后再调整。

### 8.4 通信边界

先支持：

```text
用户 -> Subagent
主 Agent -> 自己启动的 Subagent
Subagent -> 主 Agent（结果与状态事件）
```

暂缓：

```text
Subagent A -> Subagent B
跨层级任意 Agent 网状通信
多个 Agent 共享同一可写 Session
```

任意网状通信会引入路由、死锁、循环等待、上下文归属和审计问题。当前任务只需要纠偏、追加、等待和中断，树形父子控制已经覆盖。

### 8.5 验收

- 单击任一 Agent 只打开该 Agent，不能展开全部 Agent 输出。
- Agent 显示名称来自调用参数 `task`，不依赖自动 Session Title。
- 点击 `← 主会话` 后恢复原 transcript 滚动位置、焦点和 composer 内容。
- 返回主会话后，运行中的 Agent 继续执行且状态保持更新。
- 8 个并行 Agent 时列表状态准确，无重复、错位和完成后复活。
- 每个 Agent 能显示稳定 ID、任务、状态、当前动作、耗时、模型、usage 和错误。
- Agent 事件高频更新时按帧合并，不能每条事件直接触发整屏重绘。
- `steer`、`follow_up`、`abort` 覆盖 running、settled-retention、timeout 和异常退出。
- chain 每一步只在 `agent_settled` 后启动下一步，`{previous}` 取最终 Assistant 文本。
- 60 秒 retention 到期后按钮状态与持久/非持久 Session 规则一致。
- 主进程退出或 Tool 被取消时，全部本轮子进程正常回收。
- 旧 `SubagentDetails` 仍按现有文本 renderer 显示。
- 40、60、80、120 列以及 80x8 下工作台没有文字重叠。

## 9. 外部产品参考

外部参考核对时间为 2026-08-08。

### 9.1 Codex App

OpenAI 官方文档公开的 Codex App 能力包括：

- 多个 Agent 在独立 Thread 中并行工作。
- 按 Project 组织 Thread。
- worktree 隔离。
- Diff 审阅和结果回看。

LYStar 可借鉴“任务/Thread 独立、结果可审阅”的信息结构，不复制桌面 GUI 的多栏密度。终端主界面保持单主栏，Agent 详情按需打开。

参考：[Codex App](https://developers.openai.com/codex/app/)

### 9.2 Codex CLI TUI 与 App Server

截至 OpenAI Codex 仓库提交 `c2bcb9a26b5bdbdc66c48cf3bc3bb382568e800c`，公开源码显示：

- Resume 可使用 `exclude_turns` 和 `initial_turns_page`，之后通过 cursor 请求历史页。
- TUI 历史分页有请求去重、cursor、加载状态和 prepend 后的滚动处理。
- 子 Agent 有 thread id、nickname、role、status、关闭状态和最近活动。
- 协作事件覆盖 spawn、send input、wait、resume、interrupt/close 等动作。
- TUI 已有 `/agent` 状态预览、Agent picker 和 Agent 前后导航。

这证明“历史分页 + 独立 Agent 身份 + 结构化协作事件”是可行方向。Codex 的 Session/Thread 协议与 Pi 不同，LYStar 只借鉴职责划分。

公开源码：

- [history_pagination.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/history_pagination.rs)
- [agent_status_feed.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/agent_status_feed.rs)
- [agent_picker.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/agent_picker.rs)
- [agent_navigation.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/agent_navigation.rs)
- [thread.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)

需要准确区分：统一管理所有活动和历史 Agent 的完整 Agent View 仍是公开 issue，不能当作现成能力。参考 [openai/codex#22321](https://github.com/openai/codex/issues/22321)。长 Thread Resume 与历史截断也是公开问题，参考 [openai/codex#34663](https://github.com/openai/codex/issues/34663)。

### 9.3 Grok Build

Grok 官方公开页面更强调生成内容、代码、图表和可交互结果的 Build/Artifacts 体验。LYStar 可借鉴两点：

- 过程状态与最终产物分开。
- 生成结果可以继续修改和迭代。

公开资料不足以证明其内部 Agent 调度、历史分页或终端实现细节，因此本方案不据此设计底层协议。

参考：[About Grok](https://help.x.com/en/using-x/about-grok)

## 10. 上游同步边界

### 10.1 LYStar 新增文件

```text
packages/coding-agent/src/modes/interactive/session-open-coordinator.ts
packages/coding-agent/src/modes/interactive/session-transcript-source.ts
packages/coding-agent/src/modes/interactive/components/agent-workbench.ts
packages/coding-agent/src/extensions/apply-patch/index.ts
LYStar 对应 locale 和新测试
```

这些文件承载渐进 opening view、完整 transcript adapter、中文 Agent 工作台和 LYStar Tool 兼容。删除条件明确：

- Pi 上游提供活动分支 cursor pagination 后，删除 `session-transcript-source.ts` adapter。
- Pi 上游提供同名 `apply_patch` 后，删除 LYStar Extension。
- Pi 上游提供结构化 Agent workbench model 后，Agent 视图改接上游事件并删除重复 projection。

### 10.2 共享 Pi 文件的窄改动

```text
packages/coding-agent/src/main.ts
    拆分 session target resolve/open，接入 opening coordinator
packages/coding-agent/src/modes/interactive/interactive-mode.ts
    接入 transcript 页、Agent overlay、多文件 changes 和最终 outcome
packages/coding-agent/src/extensions/subagent/index.ts
    增加稳定 ID、RPC controller 和兼容 details
packages/coding-agent/src/modes/rpc/rpc-client.ts
    支持 command/commandArgs 和受控终止
packages/coding-agent/src/core/session-manager.ts
    仅在基准证明必要时增加 lazy/index 接线
packages/coding-agent/src/core/tools/edit-diff.ts
    返回同次匹配的候选行号
packages/agent/src/harness/tools/edit-diff.ts
    保持 Harness 对等行为
packages/agent/src/agent-loop.ts
    未知 Tool 返回活动 Tool 和替代建议
packages/tui/src/components/markdown.ts
    通用性能修复
```

`interactive-mode.ts` 和 `subagent/index.ts` 属于共享 Pi 代码，不能把整文件视为 LYStar 长期所有。LYStar 只保留窄 composition hook、中文展示和兼容 adapter；通用状态、RPC、Session 和 Markdown 改动拆成可独立上游提交。

提交边界建议按行为拆开：

```text
fix(startup): 拆分 session target 解析与打开
feat(tui): 增加渐进 Session opening view
fix(agent): 为未知 Tool 返回可用 Tool 建议
fix(edit): 返回重复匹配候选行号
fix(tui): 按最终结果生成完成摘要
feat(coding-agent): 增加 apply_patch 兼容 Tool
fix(session): 分离完整记录与压缩上下文
perf(session): 按需加载活动分支
perf(tui): 缓存稳定 Markdown 块
feat(agent): 增加结构化 Subagent 运行状态
feat(agent): 使用 RPC 控制 Subagent 生命周期
feat(tui): 增加 Agent 工作台
```

不要把 Session、Markdown、Subagent 和 UI 混在一个提交中。上游更新时可以分别判断采用、删除或重放。

### 10.3 明确不改

- Session JSONL schema 和 entry type。
- `buildSessionContext()` 的 compaction 语义。
- 现有 Tool 名和参数语义；`apply_patch` 作为可删除的 LYStar 兼容 Extension 增加，不替换 `edit`。
- `PI_*` 环境变量和 CLI 兼容参数。
- `LystarWorkspace` 之外的第二套 renderer。
- 不新增另一个 MCP 或 Agent 调度器。
- `AgentRunRegistry` 只投影当前可控制进程，不持久化、不调度任务；最终事实仍是现有 Tool Result details。

## 11. 实施清单

### P0：Tool 稳固性与完成摘要

- [ ] 活动 Tool 有 `edit` 且无 `apply_patch` 时，在 system prompt 明确引导使用 `edit`。
- [ ] 未知 Tool 错误返回活动 Tool 列表和替代建议。
- [ ] 增加 LYStar `apply_patch` 兼容 Extension，复用现有文件修改与 diff 能力。
- [ ] `ApplyPatchDetails.files[]` 接入 turn collector 与 `/changes`。
- [ ] duplicate error 从同一次 exact/fuzzy match offset 返回候选行号和重试方式，保持零写入。
- [ ] `TurnSummaryData` 增加 `outcome`，在 Assistant `message_end` 记录 stop reason，在 `agent_settled` 结算。
- [ ] 补 apply_patch、duplicate recovery、最终 error/aborted/length 测试。

### P0：完整历史与 Resume 首屏

- [ ] 增加可重复的 16/64/256 MB Session benchmark fixture 生成器。
- [ ] 记录当前 `T_shell`、`T_tail`、`T_context_ready`、`M_peak`。
- [ ] 拆分 `resolveSessionTarget()` 与 `openSessionTarget()`，在 `SessionManager.open()` 前启动 opening view。
- [ ] 实现 `SessionOpenCoordinator`，在 SessionManager 创建前显示复用 renderer 的 shell 和 tail。
- [ ] 实现带显式 `leafId` 的 `TranscriptSource.readTail()`、反向活动链读取和 cursor 失效规则。
- [ ] 正式 TUI 初始渲染只读当前 transcript 页，模型上下文继续走现有链路。
- [ ] branch、tree navigation、fork、resume 和 session switch 后以 `getLeafId()` reset transcript。
- [ ] 补 compaction 前历史、分支、malformed line 和重复页测试。
- [ ] 真实 PTY 验证 80x8、80x24、120x36，并增加 40x20。

### P1：内容渲染与窄终端

- [ ] 建立 Markdown/LaTeX/Mermaid 支持等级测试表。
- [ ] 增加 parse/transform/render 计时点和大内容 benchmark。
- [ ] 只重排可见 Markdown 组件。
- [ ] 表格窄宽降级、长 code block 受控展开、Mermaid 同宽失败缓存。
- [ ] Agent 工作台和其他 overlay 统一单栏/双栏宽度规则。

### P1：结构化 Agent 工作台

- [ ] 为每个子任务生成稳定 `agentId` 和整次调用 `runId`。
- [ ] 增加 `AgentRunRegistry` 与最小事件集合。
- [ ] 从 JSON event stream 提取当前 Tool/动作和最近活动。
- [ ] 保持旧 details 兼容，新增结构化 snapshot。
- [ ] 增加 Agent 行级 mouse hit region，单击只选择一个 `agentId`。
- [ ] 增加始终可见的 `← 主会话`，返回时恢复 transcript 锚点和 composer 状态。
- [ ] Subagent 组件提供 `getAgentTargetAtRow()`，workspace 单击行后打开对应 `agentId`。
- [ ] `Ctrl+O` 仅展开 Agent 摘要行，完整输出只在单 Agent 详情显示。
- [ ] Agent 任务名称直接投影 `task` 首行，补稳定 fallback。
- [ ] 增加 `/agents` overlay、列表、详情和窄终端 drill-down。
- [ ] 增加 `SubagentRunController`，以 `agent_settled` 结束等待。
- [ ] 补 60 秒 retention、chain `{previous}`、异常退出和 `disposeAll()`。
- [ ] 高频事件按帧合并刷新。

### P2：继续指令

- [ ] `RpcClient` 接受 command/commandArgs，复用 `getPiInvocation()`。
- [ ] 接入 `steer`、`follow_up`、`abort`。
- [ ] 60 秒 retention 内允许继续；到期后非持久 Session 明确禁用继续。
- [ ] 主进程退出、Extension reload、Session switch 和 Tool cancel 都调用 `disposeAll()`。
- [ ] 保持父子树形通信，暂不开放任意网状消息。

## 12. 测试与审核证据

### 12.1 自动测试

现有测试文件直接扩展：

```text
packages/agent/test/harness/tools.test.ts
packages/coding-agent/test/tools.test.ts
packages/coding-agent/test/task-workbench-components.test.ts
packages/coding-agent/test/interactive-mode-status.test.ts
packages/coding-agent/test/lystar-workspace.test.ts
packages/coding-agent/test/subagent-extension.test.ts
packages/coding-agent/test/rpc.test.ts
packages/coding-agent/test/mermaid.test.ts
packages/tui/test/markdown.test.ts
```

必须新增：

```text
packages/coding-agent/test/apply-patch-extension.test.ts
packages/coding-agent/test/session-open-coordinator.test.ts
packages/coding-agent/test/session-transcript-source.test.ts
packages/coding-agent/test/agent-workbench.test.ts
scripts/generate-session-benchmark-fixtures.mjs
```

最小测试矩阵：

| 工作 | 必测行为 |
|---|---|
| `apply_patch` | Add/Update/Delete；多文件成功；第二文件校验失败零写入；注入写入失败后回滚；allow/exclude/no-extensions；`details.files[]` 进入 `/changes` |
| `edit` | exact/fuzzy/CRLF/BOM/Unicode duplicate 行号；超过 5 个候选；补上下文后成功；多 edit 失败零写入 |
| 完成摘要 | Tool 失败后恢复为 completed；最终 error；aborted；length；toolUse/缺少最终消息；pending Tool |
| Transcript | cold-open tail；显式 leaf；内存 branch 未 append；兄弟分支；compaction 前历史；control entry；malformed line；cursor rewrite 失效；append 继续 |
| Session opening | target resolve/open 顺序；tail 先于 `SessionManager.open()` 完成；leaf 校验；打开失败/取消；运行中 resume 回退 |
| Agent workbench | 行级 click；宽/窄详情；返回主会话；scroll/focus/composer 恢复；任务名 fallback；8 Agent 高频更新 |
| RPC Subagent | command/commandArgs；agent_settled；steer/followUp/abort；60 秒 retention；chain；异常退出；disposeAll |
| Markdown | 40/60/80/120 列；stream/final 一致；resize cache；长 code/table；Mermaid source fallback |

局部命令：

```bash
(cd packages/agent && npx vitest --run test/harness/tools.test.ts)

(cd packages/coding-agent && npx vitest --run \
  test/apply-patch-extension.test.ts \
  test/tools.test.ts \
  test/task-workbench-components.test.ts \
  test/interactive-mode-status.test.ts \
  test/session-open-coordinator.test.ts \
  test/session-transcript-source.test.ts \
  test/lystar-workspace.test.ts \
  test/subagent-extension.test.ts \
  test/rpc.test.ts \
  test/agent-workbench.test.ts \
  test/mermaid.test.ts)

(cd packages/tui && npx vitest --run test/markdown.test.ts)
```

最终静态和构建 gate：

```bash
npm run check
npm run build:offline
```

### 12.2 Resume benchmark

复用并扩展现有 `scripts/profile-coding-agent-node.mjs`，新增 `--session` 和 `--json`；fixture generator 固定随机种子，按目标字节数生成相同结构分布：

```text
60% 普通 user/assistant 消息
20% 长 Tool output
10% Markdown/表格/Mermaid/LaTeX
5% compaction 边界
5% 分支、label、model/thinking change 和图片引用
```

实现后命令：

```bash
node scripts/generate-session-benchmark-fixtures.mjs \
  --output .tmp/session-bench \
  --sizes 16,64,256 \
  --seed 8401

PI_OFFLINE=1 node scripts/profile-coding-agent-node.mjs \
  --mode tui \
  --session .tmp/session-bench/session-16mb.jsonl \
  --runs 10 \
  --warmup 2 \
  --skip-build \
  --json
```

64 MB 和 256 MB 使用同一命令替换 `--session`。JSON 每次运行必须输出：

```text
sessionBytes, run, T_shell, T_tail, T_context_ready,
T_index_ready, M_peak, R_resize, maxEventLoopBlock
```

Gate：

- PR：16 MB，执行 2 次 warmup + 10 次测量，检查第 5.5 节绝对阈值。
- Release：16/64/256 MB 各 10 次，固定基准机记录 median、p95、RSS 和原始 JSON。
- `T_context_ready`、`M_peak` 使用同一机器的改前 commit 作为 baseline，不跨机器比较绝对值。
- benchmark 只使用本地 fixture 和 `PI_OFFLINE=1`，不调用真实 Provider。

### 12.3 PTY 矩阵

| 尺寸 | 必查内容 |
|---|---|
| 40x20 | 窄 header、表格降级、Agent 单栏、长中文 |
| 80x8 | composer 底边、状态行、历史加载提示 |
| 80x24 | 常规滚动、分页、Tool/Agent 展开 |
| 120x36 | Agent 双栏、复杂 Markdown、Diff |

命令模板：

```bash
SOCKET=lystar-tui-evolution
SESSION=.tmp/session-bench/session-16mb.jsonl

tmux -L "$SOCKET" new-session -d -s tui -x 80 -y 24 \
  "PI_OFFLINE=1 node packages/coding-agent/dist/cli.js --session '$SESSION' --approve"
tmux -L "$SOCKET" capture-pane -p -t tui -S -24
tmux -L "$SOCKET" send-keys -t tui '/quit' Enter
tmux -L "$SOCKET" kill-server
```

同一 socket 名只服务本轮验证，分别替换为 40x20、80x8、80x24、120x36。PR 使用 16 MB；Release 额外在 80x24 验证 64 MB 和 256 MB。

每个尺寸覆盖：

- 打开 tail、滚到 compaction 前历史、加载中 resize、锚点保持。
- Mermaid、LaTeX、宽表格、长 code block 和 renderer fallback。
- `apply_patch`/`edit` 恢复和完成摘要由自动测试验证，PTY 只核对最终可见文案与布局。
- Agent 工作台使用 fixture details 核对列表、单击、详情和返回；running/steer/followUp/abort 使用 faux provider RPC 集成测试，不消耗真实额度。
- mouse 开启时人工单击一个 Agent，确认只切换该 Agent；mouse 关闭时用上下键和 Enter 完成同一路径。
- 点击 `← 主会话` 后核对 transcript 行、焦点和 composer 文本；后台 Agent 状态继续更新。

### 12.4 兼容回归

- 用已有旧 Session fixture 打开、分页、继续对话，确认 JSONL 未迁移到新格式。
- `--no-session`、`--no-extensions`、`--no-tools`、`--tools edit`、`--exclude-tools apply_patch` 行为保持。
- `la -c`、`la -r`、`la --help`、`PI_OFFLINE=1 la --list-models` 的参数和退出码不变。
- Extension Tool、Provider、模型 ID、RPC command type 和 `PI_*` 名称不改。
- `buildSessionContext()` 的现有 compaction、branch 和 overflow 测试全部通过。
- 与目标 Pi tag 模拟合入时，`main.ts`、`interactive-mode.ts`、`subagent/index.ts` 的差量可以按提交单独判断。

### 12.5 审核材料

每个实现提交附带：

- 修改前后链路图。
- 受影响文件和公共契约说明。
- 自动测试命令与结果。
- benchmark 原始 JSON 和 median/p95 汇总。
- PTY 尺寸、终端环境和 capture。
- 与目标 Pi tag 的模拟合入结果。

## 13. 完成标准

本方案完成时应同时满足：

1. 用户能从当前消息一直向前查看完整活动分支，包括 compaction 前历史。
2. 64 MB Session 的 `T_shell` p95 不超过 250 ms、`T_tail` p95 不超过 700 ms；首屏和可输入时间分别记录。
3. GPT 调用 `apply_patch` 时能够被明确纠偏或兼容执行，不再以未知 Tool 结束。
4. `edit` 重复匹配错误给出候选行号，补充上下文后可直接重试。
5. 已恢复的 Tool 错误不会让完成摘要显示“完成但有问题”，真实失败、未完成和取消仍准确显示。
6. Markdown、LaTeX 和 Mermaid 的支持与降级边界明确，任何失败都不丢内容。
7. 多个 Subagent 有稳定身份、准确状态、当前动作、耗时、usage 和独立详情。
8. 用户单击一个 Subagent 时只打开该 Agent 的详情，并能通过可见入口返回原主会话；滚动位置、焦点和 composer 内容保持。
9. 用户或主 Agent 能对运行中的直接子 Agent 追加、排队或中断指令。
10. 40 列窄终端和 80x8 极小高度仍能完成查看、输入、监督和退出。
11. Session、现有 Tool、Extension、Provider 和 CLI 外部契约保持兼容。
12. LYStar 新增内容集中在 transcript/opening adapter、Agent workbench 和兼容 Extension；`main.ts`、`interactive-mode.ts`、`subagent/index.ts` 等共享文件只保留可独立审核的窄改动。

## 14. 实施与验证记录

记录日期：2026 年 8 月 8 日。

### 14.1 已落地

- 完整活动分支改由 `SessionTranscriptSource` 反向分页读取；模型上下文继续使用原有 compaction-aware 投影。
- fullscreen 首次正式渲染直接读取 transcript tail，不先构建完整 branch；regular 模式继续显示完整分支。
- `SessionOpenCoordinator` 在全量 Session 打开前显示同 renderer opening shell、最近记录和只读 composer。
- `apply_patch` hidden built-in Extension、动态 Tool 提示、未知 Tool 恢复建议和 `edit` 重复候选行号已接通。
- 完成摘要按最终 Assistant stop reason、取消和未结束 Tool 判定；过程 Tool 错误单独保留。
- Subagent 已改用 RPC controller、稳定 `runId/agentId`、60 秒 retention、steer/follow-up/abort、Session switch/shutdown cleanup 和 Agent 工作台。
- Markdown 已增加 profile、窄表格 record fallback、长字符串硬换行、长 code/Markdown 折叠和 Mermaid source fallback。
- `ToolExecutionComponent` 可把 Subagent call/result 标题行映射到唯一 `agentId`，窄屏直接进入该 Agent 详情。

### 14.2 自动验证

通过：

```text
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
node --test scripts/test-session-benchmark-fixtures.test.mjs scripts/test-profile-markdown-render.test.mjs
git diff --check
```

结果：

- Coding Agent：231 个测试文件通过，6 个跳过；2044 项通过，49 项跳过。
- AI：104 个测试文件通过，25 个跳过；870 项通过，825 项跳过。
- Agent Core：20 个测试文件通过；402 项通过，1 项跳过。
- TUI 全量 `node:test` 通过。
- Unix installer 的安装、PATH、checksum、rollback、uninstall 和物化检查通过。
- 浏览器 smoke、依赖固定、shrinkwrap、install-lock、TypeScript 和 Biome gate 通过。

### 14.3 Resume benchmark

环境：Node.js 22.22.2、Linux x64、80x24 tmux PTY、`PI_OFFLINE=1`、无真实 Provider 调用。每档 2 次 warmup、10 次测量；原始 JSON 位于 `/tmp/lystar-final-bench-{16,64,256}mb.json`。

| Session | `T_shell` median / p95 | `T_tail` median / p95 | `T_context_ready` median / p95 | `M_peak` max | event-loop median / p95 |
|---|---:|---:|---:|---:|---:|
| 16 MB | 30 / 35 ms | 70 / 81 ms | 531 / 564 ms | 197.8 MiB | 46.4 / 51.7 ms |
| 64 MB | 30 / 36 ms | 72.5 / 83 ms | 783 / 802 ms | 243.6 MiB | 48.3 / 57.6 ms |
| 256 MB | 32 / 50 ms | 83.5 / 105 ms | 2017.5 / 2728 ms | 432.1 MiB | 76.5 / 115.7 ms |

结论：

- 三档 `T_shell`、`T_tail` 均通过第 5.5 节绝对门槛。
- 64 MB 可输入 p95 为 802 ms，没有数秒空屏。
- 无索引 reverse scan 已满足 tail 门槛，因此本轮没有增加 sidecar；`T_index_ready` 保持 `null`。
- 256 MB 仍由 SessionManager 全量存储和 V8 GC 主导，event-loop p95 超过 50 ms；没有改前 commit 的同机 RSS 数据，不能证明 `M_peak` 下降 30%。严格 Release 性能 gate 未通过。
- `R_resize` 完成真实 PTY resize 和布局核验，尚未形成可重复的数值 p95，JSON 中保持 `null`。

### 14.4 Markdown benchmark

80 列单次冷渲染 / 同宽缓存命中：

| Fixture | 冷渲染 | 缓存命中 |
|---|---:|---:|
| 64 KB 连续 Markdown | 102.813 ms | 0.080 ms |
| 500 行 code block | 3.821 ms | 0.024 ms |
| 50x20 table | 12.513 ms | 0.011 ms |
| 大型 Mermaid source | 2.569 ms | 0.032 ms |

64 KB 连续 Markdown 仍高于 16 ms，因此块级稳定前缀 token cache 仍有继续优化价值；当前已通过 transcript 可见区渲染和长内容折叠限制首屏影响。

### 14.5 PTY 与发行资产

真实 PTY 已覆盖：

- `40x20`：窄 header、固定 composer、Agent 单栏列表和单 Agent 详情。
- `80x8`：composer、模型状态和快捷栏保留，无重叠。
- `80x24`：常规 tail、`Ctrl+Home` 加载更早 Tool 记录、锚点和返回底部提示。
- `120x36`：Agent 双栏、长详情和空态。
- 256 MB Session 加载、resize、正式 UI 接管和退出恢复。

发行验证：

- Bun 1.3.9 五平台归档构建通过：darwin-arm64、darwin-x64、linux-arm64、linux-x64、windows-x64。
- `SHA256SUMS` 中 5 个归档全部校验通过。
- manifest 版本为 `0.84.1-lystar.5`，Pi 版本为 `0.84.1`，仓库为 `octyean/lystar-agent`。
- Linux x64 解压包的 `la --version`、`la --help`、`PI_OFFLINE=1 la --list-models` 通过。

### 14.6 发布判断

功能、兼容、自动测试、PTY 和五平台打包已完成。当前不能按第 5.5 节宣称完全 Release-ready，剩余阻塞是：

1. 256 MB Session 仍全量物化，`M_peak` 高，event-loop p95 为 115.7 ms。
2. `R_resize` 尚无自动化数值 p95。

下一次性能工作只处理这两个证据缺口：引入按活动上下文读取、按需完整 materialize 的 lazy entry store，并给 resize 增加可重复计时入口。
