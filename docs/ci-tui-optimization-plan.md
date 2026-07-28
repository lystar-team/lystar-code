# CI 与 Interactive TUI 优化问题及实施方案

> 状态：待实施。
>
> 实施基线：LYStar Agent `0.82.1-lystar.7`，发布目标：`0.82.1-lystar.8`，Pi `v0.82.1`。
>
> 本文记录已经确认的问题、代码根因、实施边界和验收标准。各项改动按依赖关系连续完成，不改变 Session、Extension、Tool、Provider 和 `PI_*` 兼容契约。

## 1. 背景与目标

当前需要同时解决两类问题：

1. GitHub Actions CI 正常执行约 3 分钟，Coding Agent 测试串行占据主要时间，部分预期失败测试还会访问真实 npm 和 GitHub，成功日志中出现红色错误文本。
2. Interactive TUI 在长会话、并行 Tool Call、窄终端和 Windows 环境下仍有明显的性能与交互问题，包括完整历史重复渲染、执行状态偶发消失、命令缺少分组、输入区耦合脆弱、快捷栏信息固定、滚轮步长不合理和内置字符显示方格。

本次实施目标：

| 方向 | 当前基线 | 目标 |
|---|---:|---:|
| GitHub Actions 正常执行时间 | 中位数约 182 秒 | 中位数 80 至 110 秒 |
| Coding Agent 测试 | 单 job 约 84 秒 | 两个 shard 并行，失败可独立定位 |
| 成功 CI 日志 | 含真实 npm/GitHub 预期失败输出 | 不访问无效外部资源，不出现误导性红色错误 |
| 长会话渲染 | 每次遍历并拼装完整历史 | 未变化历史块复用，主要处理当前视口和活动块 |
| Tool 执行展示 | 多个 Tool Call 各自散列 | 同轮多条 Bash 命令组成可收起命令组 |
| 执行状态 | 可能被 Footer 或 Widget 裁掉 | 有空间显示 Composer 时优先保留当前状态 |
| 鼠标滚轮 | 固定 3 行 | 按会话视口自适应 2 至 8 行 |
| Windows 内置图标 | 部分字体显示方格 | Windows 使用内置安全字符集 |

CI 时间只统计 runner 实际执行时间，不把 GitHub 排队时间计入代码优化结果。

## 2. 兼容边界

本次改动保持以下事实源和对外契约不变：

- Session JSONL 结构、消息角色、Tool Call 和 Tool Result 存储格式。
- Extension API、Extension 自定义 Tool renderer 和 Widget 能力。
- Tool 名、Provider ID、模型 ID、CLI 参数、退出码和 `PI_*` 环境变量。
- Pi TUI 的差量 renderer、16ms 合帧、overlay、焦点和输入系统。
- Release 五平台产物、安装器、manifest 和同 commit CI gate。

命令组、动态快捷栏、平台字符和视口缓存全部属于显示层。TPS 中文化只修改项目内 Extension 文案，不改变统计口径和事件协议。

## 3. CI 现状与问题

### 3.1 实测基线

最近 14 次成功的 `main` push CI：

| 指标 | 时间 |
|---|---:|
| 最短 | 149 秒 |
| 中位数 | 182 秒 |
| P90 | 198 秒 |
| 最长 | 199 秒 |

最新成功运行的 Linux job 约 178 秒，主要步骤为：

| 步骤 | 时间 |
|---|---:|
| 系统依赖安装 | 约 25 秒 |
| `npm ci` | 约 8 秒 |
| `npm run check` | 约 11 秒 |
| `npm run build:offline` | 约 7 秒 |
| TUI 测试 | 约 6 秒 |
| AI 测试 | 约 24 秒 |
| Coding Agent 测试 | 约 84 秒 |
| Agent Core 测试 | 约 5 秒 |

Windows job 约 68 秒并与 Linux 并行。部分 Actions 页面显示接近 7 分钟，实际包含 230 至 279 秒 runner 排队时间，无法通过仓库代码消除。

### 3.2 根因

#### 测试在一个 Linux job 中串行执行

`.github/workflows/ci.yml` 把源码检查、构建和四套测试放在同一个 Linux job。Coding Agent 测试结束前，其他测试即使已经完成也无法缩短墙钟时间；任何一个测试失败都需要重跑整个 Linux job。

#### Coding Agent 测试占据主要时间

Coding Agent 测试约 84 秒，占 Linux job 实际执行时间接近一半。当前 Vitest `4.1.9` 已原生支持 `--shard`，不需要自建测试分片脚本。

#### 安装了未使用的图形开发包

Linux job 安装 Cairo、Pango、JPEG、GIF 和 RSVG 开发包，但当前默认测试与离线构建没有使用这些 native 图形依赖。安装过程约 25 秒，并扩大 runner 镜像差异影响。

#### 成功日志包含真实外部错误

`packages/coding-agent/test/package-manager.test.ts` 的失败路径会访问不存在的 npm 包和 GitHub 仓库，成功 CI 中因此出现：

```text
npm error ETARGET nonexistent-package@1.0.0
fatal: could not read Username for 'https://github.com'
```

这些输出来自预期失败断言，但测试仍依赖外部网络、npm registry 和 GitHub 行为，是当前最明确的潜在波动来源。

#### CI gate 会修改工作区

根脚本 `check` 当前执行 `biome check --write --error-on-warnings .`。CI gate 应只验证源码，不能依靠自动改写后继续通过。

### 3.3 历史失败判断

最近四次失败都已定位为确定性缺陷：

| Run | 原因 |
|---|---|
| `30148933010` | 离线模型数据提交不完整，生成类型为空 |
| `30161932934` | ANSI 测试硬编码 RGB，runner 实际使用 256 色 |
| `30192338953` | `.mjs` 中残留 TypeScript 类型标注 |
| `30192465315` | PowerShell 5.1 中文编码导致字符串断言失真 |

这些失败不能证明当前仍有高概率随机失败。真实外网错误路径测试仍需清理，之后继续通过 CI 样本观察稳定性。

## 4. CI 实施方案

### 4.1 并行 job 拓扑

将 Linux 串行 job 拆为以下独立 job：

| Job | 责任 | 主要命令 |
|---|---|---|
| `verify-source` | 格式、依赖、类型、离线构建和浏览器 smoke | `npm run check`、`npm run build:offline` |
| `test-tui` | TUI 测试 | `npm --workspace @earendil-works/pi-tui test` |
| `test-ai` | AI 测试 | `npm --workspace @earendil-works/pi-ai test` |
| `test-coding-agent-1` | Coding Agent 前半分片 | `... test -- --maxWorkers=4 --shard=1/2` |
| `test-coding-agent-2` | Coding Agent 后半分片 | `... test -- --maxWorkers=4 --shard=2/2` |
| `test-agent-core` | Agent Core 测试 | `npm --workspace @earendil-works/pi-agent-core test` |
| `windows-installer` | Windows 安装链路 | 保持现有 Windows 验证 |

所有测试 job 设置 `strategy.fail-fast: false`。一个 shard 失败时，其他 job 继续执行并留下完整证据。

每个 job 独立执行 `npm ci` 会增加 runner 总使用量，预计从约 4.1 分钟增至 5.5 至 6 分钟。换取的收益是墙钟时间下降约 40% 至 55%，并能只重跑失败 job。

### 4.2 固定执行环境

CI 固定使用：

```text
Linux runner   ubuntu-24.04
Windows runner windows-2025
Node.js        22.19.0
```

依赖安装统一使用：

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

`@earendil-works/gondolin@0.12.0` 声明 Node.js `>=23.6.0` 造成的 `EBADENGINE` 当前属于上游依赖警告，本次不通过随意升级或降低项目 Node 基线处理。

### 4.3 精简系统依赖

按 job 安装最小依赖：

| Job | apt 依赖 |
|---|---|
| `verify-source` | 按 `check` 和浏览器 smoke 的实际需求保留 |
| `test-tui` | `fd-find` |
| Coding Agent shards | `fd-find ripgrep` |
| `test-ai`、`test-agent-core` | 无额外 apt 依赖 |

使用 `--no-install-recommends`，删除 Cairo、Pango、JPEG、GIF 和 RSVG 开发包。实施时通过一次干净 runner 验证，发现真实运行依赖后只补回对应包。

### 4.4 分离格式化和 CI 检查

根 `package.json` 增加本地格式化命令：

```json
{
  "format": "biome check --write ."
}
```

`check` 中改为只读验证：

```bash
biome check --error-on-warnings .
```

其余依赖固定检查、TS import 检查、shrinkwrap/install-lock 校验、`tsgo --noEmit` 和浏览器 smoke 保持原有责任。

### 4.5 隔离 Package Manager 失败路径

修改 `packages/coding-agent/test/package-manager.test.ts`：

- mock 命令执行边界，不请求不存在的 npm 包或私有 GitHub 地址。
- 保留 npm/Git source 识别、命令参数、工作目录、progress event、错误包装和返回结果断言。
- 保留 MinGit 正式 Windows 安装链路的真实下载测试，该测试验证发行能力，不属于普通失败路径单测。

验收时成功 CI 日志中不再出现 `ETARGET` 和 GitHub 凭据错误。

### 4.6 Release workflow

Release workflow 当前约 82 秒，已经验证同 commit 的 `main` CI 后再构建五平台包，不做结构性拆分。

CI job 改名后需要确认 `.github/workflows/release.yml` 仍按 workflow 和 commit conclusion 判断成功，不绑定旧 Linux job 名。只有存在绑定时才同步调整判断条件。

## 5. TUI 现状与问题

### 5.1 长会话重复渲染

`LystarWorkspace.render()` 当前会：

1. 遍历 `chatContainer` 中的全部组件。
2. 调用每个组件的 `render(width)`。
3. 拼接完整 `contentLines` 和 `contentRanges`。
4. 最后才按 `scrollTop` 和 `viewportHeight` 截取视口。

`Markdown`、`Text` 和 TUI renderer 已有缓存、差量输出与 16ms 合帧，但完整历史仍在每次输入、流式更新和滚动时参与遍历与数组拼装。会话越长，单次刷新成本越高。

### 5.2 Footer 每帧扫描 Session

`FooterComponent.render()` 每次刷新都会遍历 `sessionManager.getEntries()` 汇总 Token 和 usage。输入光标、spinner、流式内容等无关刷新也会重复计算相同结果。

### 5.3 滚轮固定三行

`interactive-mode.ts` 对滚轮事件固定调用：

```ts
this.workspace.scrollBy(-3);
this.workspace.scrollBy(3);
```

小视口中三行跨度偏大，大视口中又显得迟缓。

### 5.4 Composer 依赖字符串解析

`WorkspaceComposer` 从 Editor 渲染后的字符串中查找以 `─` 开头的行，再拆分主体、边框和补全列表。这使 LYStar 输入框依赖 Editor 的具体字符输出，边框或补全布局改变时容易失效。

窄终端下，模型、Provider、思考强度和项目可信状态还会同时竞争底边空间，当前没有明确的信息优先级。

### 5.5 快捷栏固定不变

底部快捷栏初始化后固定显示思考强度、取消、Tool 展开和 `/`。空闲、流式回复、Bash、排队消息和已上滚状态都显示同一组操作，当前最需要的动作没有优先级。

### 5.6 Windows 内置字符缺字

`visibleWidth()` 和 RGI Emoji 逻辑只能计算终端列宽，无法让字体提供缺失 glyph。内置状态图标中的 `❯`、`✓`、`✗`、`◆`、`▸`、`▾`、`↳` 等字符，在部分 Windows 字体中会显示为方格。

### 5.7 多条命令缺少轮次级容器

Bash Tool 输入只有一个 `command: string`。用户看到的多条并行命令，实际来自同一轮 Assistant 消息中的多个 Tool Call，由 Agent 并发执行。

`interactive-mode.ts` 当前使用 `pendingTools: Map<string, ToolExecutionComponent>`，每发现一个 Tool Call 就直接加入 `chatContainer`，没有轮次级命令组。结果是：

- 同时执行的命令散落成多条独立记录。
- 无法通过一行判断整批命令的完成数量和失败情况。
- 收起多条命令需要逐项操作。
- 命令之间缺少稳定留白，扫描困难。

### 5.8 当前执行状态会被裁掉

`statusContainer` 位于 Workspace 可裁切底部区域。当前剩余高度按 `bottomContainers` 从后往前分配，Footer 和 Extension Widget 会先于状态行获得预算。

当 Widget、Footer、Autocomplete 或窄终端占用更多高度时，状态行可能获得 0 行，因此表现为执行中的 spinner 或状态文字偶发消失。

### 5.9 TPS 完成提示仍为英文

项目内 `.pi/extensions/tps.ts` 在 `agent_end` 后显示：

```text
TPS 31.7 tok/s. out 226, in 21,591, cache r/w 0/0, total 21,817, 7.1s
```

该文案由项目 Extension 维护，不属于内置 TUI locale。

## 6. TUI 实施方案

### 6.1 Workspace 组件块缓存和视口装配

保留现有 Pi renderer，在 `LystarWorkspace` 增加组件块布局：

```text
Workspace block
  component identity
  rendered width
  rendered lines
  line count
  content start/end
  dirty revision
```

处理规则：

- 首次渲染或终端宽度改变时重建全部块。
- 新消息只追加新块，不重新拼接既有历史。
- 流式回复只标记当前 Assistant 块为 dirty。
- Tool update 只标记对应 Tool 或命令组块为 dirty。
- 展开、收起、主题变化和图片宽度变化按实际影响失效。
- 滚动只根据块高度定位与视口相交的块，再装配可见行。
- Session 切换、branch、compaction 和完整 rebuild 时清空块缓存。

第一版使用现有组件身份和渲染结果，不引入第二套消息模型，也不实现通用虚拟列表框架。

需要保证：

- 用户上滚后，新内容不会改变当前阅读位置。
- 流式回复时只有最新 Assistant 块持续失效。
- Tool 展开后块高度变化能够重新计算后续偏移。
- `getComponentHitAtScreenRow()` 在视口缓存后仍能返回正确组件和相对行。

### 6.2 Footer usage leaf 缓存

`FooterComponent` 缓存以下键和值：

```text
Session 实例
sessionManager.getLeafId()
聚合后的 input/output/cache/total usage
```

Session 和 leaf 未变化时直接复用。以下事件触发失效：

- 消息追加。
- branch 或 Session 切换。
- compaction 完成。
- Session rebuild。

缓存只减少重复统计，不建立新的 Token 事实源。

### 6.3 自适应滚轮

滚轮步长按会话视口计算：

```text
step = round(viewportHeight × 20%)
step = clamp(step, 2, 8)
step <= viewportHeight - 1
```

- 极小视口至少移动 1 行。
- Shift 继续绕过 LYStar 鼠标处理，保留终端原生选择行为。
- Page Up、Page Down、Top 和 Bottom 快捷键语义不变。
- 本次不增加设置项和滚轮加速度。

### 6.4 Composer 结构化输出和信息优先级

在 LYStar 的 `CustomEditor` 与 `WorkspaceComposer` 之间提供结构化渲染结果：

```text
body lines
autocomplete lines
cursor state
minimum body height
```

`WorkspaceComposer` 只负责 LYStar 外框、底边信息和最终裁切，不再通过 `─` 字符猜测 Editor 内部结构。Extension Editor API 和通用 TUI Editor 对外契约保持不变。

底边信息按以下顺序保留：

1. `操作需确认` 或项目可信状态。
2. 当前模型。
3. 思考强度。
4. Provider，仅在多 Provider 且宽度足够时显示。

窄终端逐项移除低优先级信息，保持单行，不缩放字号，不覆盖输入内容。

### 6.5 动态单行快捷栏

新增 `WorkspaceShortcutBar`，根据当前状态生成候选操作：

| 状态 | 优先操作 |
|---|---|
| 空闲 | `/ 命令`、思考强度、Tool 展开 |
| 流式回复 | `Esc 取消`、Tool 展开 |
| Bash 执行 | `Esc 取消`、Tool 展开 |
| 已上滚 | 回到底部、Tool 展开 |
| 有排队消息 | 取消或管理当前队列操作 |

规则：

- 保持一行且禁止换行。
- 从低优先级项目开始裁减，最后才截断当前关键操作。
- 键位文本读取现有 KeybindingsManager，不硬编码实际按键。
- 完整快捷键仍通过 `/hotkeys` 查看。

### 6.6 Windows 内置字符表

新增 `ui-glyphs.ts`，集中维护 LYStar 内置交互字符：

| 语义 | 常规终端 | Windows 安全集 |
|---|---|---|
| 输入提示 | `❯` | `>` |
| 成功 | `✓` | `+` |
| 失败 | `✗` | `x` |
| Tool | `◆` | `*` |
| 展开 | `▾` | `-` |
| 收起 | `▸` | `+` |
| 分支/子项 | `↳` | `>` |
| 增删摘要 | `±` | `+/-` |

使用 `process.platform === "win32"` 选择内置字符集，不增加字体探测、Nerd Font 依赖或用户配置。用户消息、模型输出和 Extension 自定义 Emoji 原样保留。

### 6.7 同轮命令组

新增 `ToolExecutionGroupComponent`，按 Assistant 消息轮次管理 Bash Tool Call：

- 同一轮只有一条 Bash 命令时，直接渲染现有 `ToolExecutionComponent`，不显示组头。
- 同一轮出现第二条 Bash 命令后切换为命令组。
- 非 Bash Tool 保持现有独立 Tool 展示。
- Agent 并发模式、Tool Call 顺序和结果事件不变。

运行中示例：

```text
▾ 正在执行 4 条命令 · 已完成 2/4

  ▸ $ 已运行 rg ...

  ▸ $ 正在运行 npm test ...

  ▸ $ 已运行 git status ...

  ▸ $ 正在运行 npm run check ...
```

完成状态：

```text
▸ 4 条命令执行完成
▸ 4 条命令执行完成 · 1 条失败
```

交互规则：

- 命令组默认展开命令摘要，用户可点击组头收起。
- 组内每条命令仍能独立展开输出。
- 命令之间恰好一个空行，首条之前和末条之后不增加空行。
- 异步完成时只原地更新状态，显示顺序保持 Tool Call 原始顺序。
- `Ctrl+O` 继续控制 Tool 详细输出，不破坏命令组本身的可见性。
- 中途取消时，已完成命令保留结果，未完成命令显示取消状态。
- Session 重放时按 Assistant 消息重新构造组，不写入新的 Session entry。

`pendingTools` 继续按 `toolCallId` 指向子 `ToolExecutionComponent`。命令组只维护显示状态和子组件布局，不复制 Tool Result。

### 6.8 底部区域优先级

Workspace 将显示顺序和高度预算优先级分开。视觉顺序保持：

```text
排队消息
当前状态
Editor 上方 Widget
Composer
Editor 下方 Widget
Footer
快捷栏
```

高度预算优先级调整为：

1. Composer 最小主体。
2. 当前执行、重试或压缩状态。
3. 快捷栏。
4. 排队消息。
5. Footer 用量。
6. Extension Widget。
7. Autocomplete 超出部分。

在 `80×8` 等极小高度下，先裁掉低优先级内容和 Autocomplete 行，确保输入主体、当前状态和关键操作仍可判断。终端高度小到无法容纳三者时，保留输入主体和当前状态，快捷键可通过命令帮助查看。

命令组头也持续提供本轮 Tool 状态，避免单条命令恰好位于视口外时失去执行反馈。

### 6.9 TPS 中文化

修改 `.pi/extensions/tps.ts`，显示为：

```text
生成速度 31.7 Token/秒 · 输出 226 · 输入 21,591 · 缓存读/写 0/0 · 总计 21,817 · 用时 7.1 秒
```

保留现有计算：

```text
生成速度 = Assistant output tokens / agent elapsed seconds
```

Token 聚合范围、`agent_start`/`agent_end` 事件和 `ctx.ui.notify()` 调用不变。

## 7. 预计文件范围

| 文件 | 改动 |
|---|---|
| `.github/workflows/ci.yml` | 拆分并行 job、固定 runner/Node、精简系统依赖 |
| `.github/workflows/release.yml` | 仅在旧 job 名被绑定时调整 CI 成功判断 |
| `package.json` | 分离 `format` 和只读 `check` |
| `packages/coding-agent/test/package-manager.test.ts` | mock 外部失败路径 |
| `packages/coding-agent/src/modes/interactive/components/lystar-workspace.ts` | 组件块缓存、视口装配、底部优先级、自适应滚动接口 |
| `packages/coding-agent/src/modes/interactive/components/footer.ts` | Session/leaf usage 缓存 |
| `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` | 向 Composer 提供结构化内容 |
| `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts` | 复用键位显示能力 |
| `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` | 命令组子项状态和命中协作 |
| `packages/coding-agent/src/modes/interactive/components/tool-execution-group.ts` | 新增同轮命令组 |
| `packages/coding-agent/src/modes/interactive/components/workspace-shortcut-bar.ts` | 新增动态快捷栏 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 生命周期接线、组装、滚轮、状态和展开路由 |
| `packages/coding-agent/src/modes/interactive/ui-glyphs.ts` | 平台内置字符表 |
| `.pi/extensions/tps.ts` | TPS 中文文案 |
| 对应 Coding Agent 测试 | Workspace、Footer、Tool 组、鼠标、字符和状态回归 |

实施时以实际责任位置为准。能够在现有文件内清楚完成的逻辑不额外拆 helper。

## 8. 实施顺序

以下顺序只表达依赖关系：

1. 调整 Package Manager 测试、根检查命令和 CI job，先建立更快、更干净的验证入口。
2. 完成 Workspace 组件块缓存和 Footer usage 缓存，解决长会话主要重复工作。
3. 调整底部区域预算，保证当前状态、Composer 和快捷栏的显示优先级。
4. 接入自适应滚轮和动态快捷栏。
5. 实现命令组、子命令间距、鼠标命中和 `Ctrl+O` 协作。
6. 整理 Composer 结构化输出和窄宽度信息降级。
7. 接入 Windows 内置字符表和 TPS 中文文案。
8. 完成自动测试、真实 PTY、Windows Terminal 和 GitHub Actions 实跑。

## 9. 自动验证

### 9.1 聚焦测试

至少覆盖：

- `package-manager.test.ts` 不访问真实无效 npm/GitHub 地址。
- Workspace 未变化历史块复用，活动块失效后高度和命中范围正确。
- Footer 在 leaf 不变时不重复扫描 entries，leaf 改变后刷新。
- 滚轮在不同 viewport 高度下得到 2 至 8 行步长。
- 单条 Bash 不显示命令组。
- 第二条 Bash 出现后形成同轮命令组。
- 多条命令乱序结束时顺序、完成数和失败数正确。
- 命令组收起、子命令展开和 `Ctrl+O` 不串层。
- 组内命令之间恰好一个空行。
- Footer 和 Widget 变高时，活动状态优先可见。
- Windows 平台字符表不含目标高风险 glyph。
- Composer 长模型名、中文可信状态和 Autocomplete 不重叠。

### 9.2 项目 gate

代码完成后运行：

```bash
npm run check
npm run build:offline
npm --workspace @earendil-works/pi-tui test
npm --workspace @earendil-works/pi-ai test
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=4
npm --workspace @earendil-works/pi-agent-core test
bash scripts/test-install-sh.sh
```

修改过的测试文件必须先单独运行。交付前执行 `git diff --check`。

## 10. 真实 TUI 验证

使用本轮独立 tmux socket，覆盖：

| 场景 | 验收点 |
|---|---|
| `80×24` | 常规对话、Composer、状态和快捷栏布局稳定 |
| `80×8` | 当前状态和输入主体可见，无重叠 |
| `120×36` | 长命令组和 Footer 信息不过度拉散 |
| 500 条历史消息 | 输入和滚动无明显随历史长度增长的停顿 |
| 流式回复时上滚 | 阅读位置保持，下方新内容提示正确 |
| 多条 Bash 并行 | 命令组计数、顺序、留白和乱序完成正确 |
| 一条命令失败 | 组头失败数和子项错误同时可见 |
| 队列和 Bash 模式 | 当前关键操作进入动态快捷栏 |
| Tool/Diff 展开 | 鼠标与 `Ctrl+O` 命中正确 |
| Autocomplete | 极小高度优先保留输入与状态 |
| resize 和 overlay | 缓存失效、边框和点击范围正确 |

验证结束后关闭本轮 tmux 会话，不处理其他会话创建的浏览器或终端进程。

## 11. Windows 验证

真实 Windows Terminal 至少验证：

- 内置提示、成功、失败、Tool、展开和收起字符不显示方格。
- 中文宽字符、模型名、命令组状态和 Composer 边框列宽正确。
- PowerShell 5.1 与托管 MinGit 安装测试继续通过。
- 用户输入和模型输出中的 Emoji 不被替换。

没有 Windows 实机证据时，只能说明字符分支和自动测试通过，不能宣称所有 Windows 字体均已验证。

## 12. GitHub Actions 验收

推送后核对：

1. 七个 CI job 均独立执行，失败时可以只重跑对应 job。
2. 两个 Coding Agent shard 时间接近，不出现长期一边空闲、一边超过目标时间的情况。
3. runner 实际执行时间中位数进入 80 至 110 秒；GitHub 排队时间单独记录。
4. 成功日志不再出现预期的 `ETARGET` 或 GitHub 凭据错误。
5. `npm run check` 不修改工作区。
6. Release workflow 仍能识别同 commit 的成功 `main` CI。
7. 五平台构建、manifest、SHA、安装器和 Release gate 不受影响。

至少观察三次正常 `main` CI 后再确认中位数。单次 runner 网络或缓存波动不作为最终结论。

## 13. 风险与控制

| 风险 | 控制方式 |
|---|---|
| 并行 job 增加 runner 使用量 | 接受约 35% 总分钟增长，换取 40% 至 55% 墙钟下降 |
| Coding Agent shard 不均衡 | 先使用 Vitest 原生分片，按 GitHub 实测再决定是否调整为更多 shard |
| Workspace 缓存出现旧内容 | 所有消息、Tool、展开、宽度、主题和 Session rebuild 路径补失效测试 |
| Tool 命令组影响历史重放 | 只按现有 Assistant Tool Call 重建，不写入新 Session entry |
| 嵌套展开点击错位 | 对组头、子命令首行、输出行和视口滚动后的相对行分别测试 |
| 极小终端无法容纳全部底部内容 | 按明确优先级裁切，保证当前动作和输入能力优先 |
| Windows 字体差异无法完全模拟 | 内置字符使用安全集，并保留真实 Windows Terminal 验证 |
| Extension 自定义 renderer 被统一样式覆盖 | 命令组只包裹 Bash 摘要，Extension 自定义内容和用户 Emoji 保持原样 |

## 14. 完成标准

以下条件全部满足后，本次优化完成：

- GitHub Actions 正常执行中位数达到 80 至 110 秒目标，失败可按 job 隔离。
- 成功 CI 不再依赖无效 npm/GitHub 请求，不再输出误导性外部错误。
- 500 条历史消息下，输入、流式回复和滚动主要复用历史块，Footer 不再每帧扫描 Session。
- 多条并行 Bash 以同轮命令组展示，状态、间距、失败数、展开和历史重放正确。
- 活动状态在受支持的小终端布局中持续可见。
- 滚轮、Composer、动态快捷栏和 Windows 内置字符通过自动与真实终端验证。
- TPS 完成提示使用中文。
- `npm run check`、离线构建、相关全量测试、Unix 安装测试和 Release gate 全部通过。
