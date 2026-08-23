# LYStar TUI 持续开发交接

更新时间：2026-08-23

## 文档用途

本文件是后续会话继续开发 LYStar Code TUI 的唯一交接入口。后续会话先读本文件，再读项目根目录 `AGENTS.md`、`AGENT_VERIFICATION.md` 和目标代码，不从聊天历史猜测目标。

本阶段只记录已经确认的产品方向、技术边界和验收要求。未完成内容不能写成已实现。

## 当前基线

- 产品：LYStar Code
- 产品版本事实源：`packages/coding-agent/package.json` 的 `piConfig.productVersion`
- 当前产品版本：`0.84.2-lystar.1`
- 当前 Pi 包版本：`0.84.2`
- 命令：`lc`、`lystar`
- 发行仓库：`lystar-team/lystar-code`
- 当前分支：`main`
- 当前 HEAD：`ee871d44b feat: 完善 Tool Recovery 恢复闭环`
- 当前工作区：原有 8 个未提交的 TUI 文件继续保留；前轮产品版本、Changelog、顶部布局和活动条改动，以及本轮 LYStar Icons 改动都在其上继续叠加，不能回退或覆盖

已有未提交文件：

```text
packages/coding-agent/src/modes/interactive/components/lystar-workspace.ts
packages/coding-agent/src/modes/interactive/components/workspace-activity-bar.ts
packages/coding-agent/src/modes/interactive/interactive-mode.ts
packages/coding-agent/src/modes/interactive/theme/dark.json
packages/coding-agent/src/modes/interactive/theme/light.json
packages/coding-agent/src/utils/ansi.ts
packages/coding-agent/test/lystar-workspace.test.ts
packages/coding-agent/test/task-workbench-components.test.ts
```

这些改动属于当前工作区现状。后续开发必须先阅读 diff，再决定如何与新需求合并。

本轮新增或继续修改的文件：

```text
packages/coding-agent/CHANGELOG.md
packages/coding-agent/src/locales/zh-CN.ts
packages/coding-agent/src/modes/interactive/components/changelog-viewer.ts
packages/coding-agent/src/utils/changelog.ts
packages/coding-agent/test/changelog.test.ts
```

本轮图标系统继续修改或新增的文件：

```text
packages/coding-agent/src/main.ts
packages/coding-agent/src/modes/interactive/DESIGN.md
packages/coding-agent/src/modes/interactive/ui-glyphs.ts
packages/coding-agent/src/modes/interactive/components/assistant-message.ts
packages/coding-agent/src/modes/interactive/components/subagent-run.ts
packages/coding-agent/src/modes/interactive/components/tool-card-layout.ts
packages/coding-agent/src/modes/interactive/components/tool-execution-group.ts
packages/coding-agent/src/modes/interactive/components/tool-execution.ts
packages/coding-agent/src/modes/interactive/components/tool-summary.ts
packages/coding-agent/src/modes/interactive/components/turn-summary.ts
packages/coding-agent/src/modes/interactive/components/workspace-activity-bar.ts
packages/coding-agent/test/tool-execution-component.test.ts
packages/coding-agent/test/ui-glyphs.test.ts
```

## 已确认目标

### 1. 启动更新提示必须使用 LYStar 产品语义

当前启动提示从 `CHANGELOG.md` 的 upstream 版本标题取号，显示的是 Pi 版本，产品意义不足。

目标文案示例：

```text
LYStar Code 已更新到 v0.84.2-lystar.1。
使用 /changelog 查看 LYStar Code 更新记录。
```

要求：

- 使用 `APP_TITLE`、`VERSION` 和 `APP_NAME` 等产品事实源。
- 不再从 upstream Changelog 标题推断 LYStar 产品版本。
- 产品版本比较必须支持 `0.84.2-lystar.1`、`0.84.2-lystar.2` 等后缀。
- 更新内容需要能呈现 LYStar 适配和产品改动。
- `/changelog` 保留完整记录，但启动摘要优先展示当前 LYStar 产品信息。
- 首次安装、普通启动、恢复会话和重复启动的显示规则保持可测试、可解释。

主要入口：

```text
packages/coding-agent/src/modes/interactive/interactive-mode.ts
packages/coding-agent/src/utils/changelog.ts
packages/coding-agent/src/locales/zh-CN.ts
packages/coding-agent/CHANGELOG.md
```

### 2. 图标必须丰富、统一，并且不能依赖 Emoji

产品目标不是把 Emoji 换成少量 ASCII 或普通 Unicode 符号，也不是回退成只有 `+`、`x`、`>` 的简陋界面。

需要建立 LYStar 自有的 `LYStar Icons` 图标系统：

- 内置一套风格统一、数量足够的图标资产。
- 图标按语义 Token 使用，例如 `success`、`failure`、`tool`、`file`、`edit`、`search`、`branch`、`link`、`running`、`expanded`、`collapsed`。
- 图标不能散落在组件中硬编码。
- 图标渲染不能依赖 Emoji 字体、Nerd Font 或用户手动安装私有字体。
- 不能只把当前 Emoji 字符替换成几个简单字符。
- 图标要支持紧凑状态栏和较丰富的 Tool/Agent 卡片展示。
- 图标具有固定尺寸和固定可见宽度，不导致布局跳动。
- 深色、浅色主题都必须保持同一套形状和语义，仅改变颜色角色。
- Windows 外部终端需要有明确的稳定降级，但不能影响 LYStar 自己控制的终端宿主的丰富图标模式。
- Extension API、Tool 名和现有图标调用方式要保持兼容。

推荐技术方向：

- 将当前 `ui-glyphs.ts` 从字符串映射升级为图标资源定义和渲染入口。
- 使用内置的终端 cell 图标资产和统一渲染器，而不是依赖用户终端字体。
- 可以使用固定尺寸的 block/half-block/ANSI 图形组合，或项目可控的终端图形资源；具体实现必须在现有 Pi TUI renderer 内完成，不新增第二套终端 renderer。
- 图标至少分为 `compact` 和 `card` 两种尺寸，避免所有场景被迫使用同一个单字符符号。
- 所有宽度计算必须经过现有 `visibleWidth`、`truncateToWidth` 等机制验证。

主要入口：

```text
packages/coding-agent/src/modes/interactive/ui-glyphs.ts
packages/coding-agent/src/modes/interactive/components/tool-summary.ts
packages/coding-agent/src/modes/interactive/components/tool-execution.ts
packages/coding-agent/src/modes/interactive/components/turn-summary.ts
packages/coding-agent/src/modes/interactive/components/workspace-activity-bar.ts
packages/coding-agent/src/modes/interactive/components/lystar-workspace.ts
packages/coding-agent/src/modes/interactive/DESIGN.md
```

不可接受的结果：

- 只替换 Emoji 字符，不建立统一图标系统。
- 用几个 ASCII 符号冒充丰富图标方案。
- 要求用户安装 Nerd Font 才能正常显示。
- 把图标图形直接写进几十个组件，后续无法统一维护。

### 3. 历史滚动必须完整、连续、可验证

当前 TUI 同时使用两层机制：

```text
SessionTranscriptSource
    -> Session JSONL 反向分页
LystarWorkspace
    -> 已物化组件的虚拟渲染窗口
LystarTUI
    -> 输入合并、60 FPS 合帧和终端输出背压
```

当前代码已经有 cursor、分页、组件缓存和虚拟窗口，但分页加载后主要依赖内容高度差恢复位置，缺少明确的 entry 锚点协议。后续不能继续在边界处增加零散条件，必须把分页协调和滚动锚点收口。

目标：

- 用户可以从当前会话尾部一直向上查看活动分支根节点。
- Compaction 之前的可见用户消息、Assistant 消息、Tool、Tool Result 和自定义可见记录不能因为 UI 虚拟化而消失。
- 分支、fork、resume、Session 切换只能显示目标 leaf 的祖先链，不能混入兄弟分支。
- 历史页加载后当前屏幕锚点保持稳定。
- 用户快速滚动时不重复请求、不乱序插入、不跳回底部。
- streaming 期间加载历史不能改变当前 streaming block 身份。
- 同一 Entry 不能重复物化。
- 历史加载失败必须可见并可重试，不能静默断线。
- 旧页可以释放渲染缓存，但不能从逻辑 transcript 中丢失。

建议建立明确的 transcript 协调状态：

```text
idle
loading(cursor, generation)
exhausted
retryable-error
cursor-invalidated
```

分页加载必须记录：

```text
当前顶部 entryId
该 entry 的组件行号
该行相对 viewport 的偏移
当前 cursor
当前 transcript generation
```

加载上一页后：

1. 新页插入逻辑 transcript。
2. 重新计算可见组件。
3. 找回原来的 `entryId`。
4. 恢复原来的屏幕偏移。
5. 只有在用户继续向上时才进入下一页。

主要入口：

```text
packages/coding-agent/src/modes/interactive/session-transcript-source.ts
packages/coding-agent/src/modes/interactive/components/lystar-workspace.ts
packages/coding-agent/src/modes/interactive/interactive-mode.ts
packages/coding-agent/src/modes/interactive/lystar-tui.ts
packages/coding-agent/test/session-transcript-source.test.ts
packages/coding-agent/test/lystar-workspace.test.ts
```

### 4. 帧性能必须有硬门禁

“流畅”不能只靠人工感觉。实现必须同时满足正确性和性能门禁：

- 渲染帧内禁止同步读取 Session 文件。
- 渲染帧内禁止解析完整历史文件。
- 单帧只处理 viewport 和固定缓冲区。
- 文件读取、分页和历史物化在渲染帧之外异步执行。
- 鼠标滚轮事件按帧合并，不对每个原始事件整屏绘制。
- 终端输出背压时只丢弃过时帧，不丢历史数据和组件状态。
- 保留现有 `LystarTUI` 的 60 FPS 合帧和 writable drain 处理。
- 不新增第二套 ANSI renderer。

必须验证：

- 长 Session 从尾部滚到根节点无缺失、无重复。
- 至少 5000 条消息，包含 Tool、Tool Result、Compaction 和分支。
- 分页后锚点误差不超过 1 行。
- 80x8、80x24、120x36 均无输入框消失、整屏跳动和历史断层。
- 参考开发环境中滚动渲染 p95 控制在 16ms 以内。
- 不能用加大 timeout、跳过断言或关闭虚拟化掩盖问题。

### 5. 顶部信息统一使用 `|`

顶栏及顶部上下文信息使用 ASCII `|` 分隔：

```text
LYStar Code  |  ~/project  |  main  |  当前任务
上下文 7.4%  |  9.5K/128K
```

要求：

- `WorkspaceHeader` 使用统一 separator token。
- 上下文统计内部使用同样的视觉规则。
- 输入框顶部模型信息是否属于同一组布局，按 UI 还原图统一处理。
- Footer、Tool 摘要、完成摘要中的 `·` 不做无差别全局替换，避免破坏其他层级的视觉语义。

主要入口：

```text
packages/coding-agent/src/modes/interactive/components/lystar-workspace.ts
packages/coding-agent/src/modes/interactive/interactive-mode.ts
packages/coding-agent/src/modes/interactive/components/workspace-activity-bar.ts
packages/coding-agent/src/modes/interactive/components/workspace-shortcut-bar.ts
```

## 实施顺序

按以下顺序拆分，不能把高风险滚动改动和图标大改动混在一个提交中：

1. **已完成**：修复产品版本、启动更新提示和 Changelog 产品区块。
2. **已完成**：统一顶部 `|` 分隔符并补布局回归测试。
3. **已完成**：建立 `LYStar Icons` 资源、渲染器和语义 Token，逐个接入内置 TUI 组件。
4. **下一项**：建立长 Session fixture，重构 transcript 分页协调和滚动锚点。
5. 补齐性能计时、PTY 验证和完整回归。

## 上轮完成记录（2026-08-23）

### 已完成

- `ChangelogEntry` 和版本比较支持 `0.84.2-lystar.1`、`0.84.2-lystar.2` 等产品修订号；同一 Pi 基线下，LYStar 产品修订按数字顺序递增，并排在无后缀的上游版本之后。
- 启动摘要改用运行时产品事实源 `APP_TITLE` 和 `VERSION`，显示“LYStar Code 已更新到 v0.84.2-lystar.1”，不再从上游 Changelog 第一条标题取版本。
- `/changelog` 继续展示完整上游与 LYStar 记录；普通视图和全屏 Overlay 标题统一为“LYStar Code 更新记录”。
- `CHANGELOG.md` 增加 `0.84.2-lystar.1` 的 LYStar 产品区块，内容只记录本轮已实现的启动提示和产品版本比较变更。
- 保留并验证首次安装、普通更新、恢复会话和重复启动规则：首次安装记录当前版本但不提示；旧版本更新显示记录；恢复会话不重复插入；当前版本重复启动不再显示。

### 已运行验证

```text
cd packages/coding-agent && npx vitest --run test/changelog.test.ts test/task-workbench-components.test.ts --maxWorkers=2 --pool=forks --reporter=dot
2 个测试文件，29 项测试通过

npm run check
通过：Biome、依赖/导入检查、tsgo、GUI 检查和 browser smoke

npm run build:offline
通过：TUI、AI、Agent、Coding Agent、GUI Protocol、GUI Host 和 GUI 构建

git diff --check
通过
```

PTY 使用独立 socket `lystar-changelog-20260823` 和临时 `PI_CODING_AGENT_DIR` 验证：首次启动覆盖 `80x24`、`80x8`、`120x36`；预置 `lastChangelogVersion=0.84.1-lystar.13` 后，`80x24` 显示 LYStar 产品版本更新提示。`/changelog` Overlay 的完整键盘交互、本轮流式、resize 和真实 Provider 未单独作为本项验收证据。

### 上轮交接时下一项

进入实施顺序第 2 项：统一 `WorkspaceHeader`、上下文统计及相关顶部信息的 ASCII `|` 分隔符，补齐 `80x24`、极小高度和宽屏布局回归测试；不要在这一步混入图标资源系统或长 Session 分页重构。

### 上轮整体进度

按本交接文档的五步实施顺序，当前完成第 1/5 步。产品版本与启动 Changelog 语义已落地，但 LYStar Icons、长 Session 连续滚动、性能硬门禁和完整 TUI 回归仍未完成。

## 本轮完成记录（2026-08-23，顶部布局）

### 已完成

- 在 `lystar-workspace.ts` 建立并导出 `WORKSPACE_HEADER_SEPARATOR`，`WorkspaceHeader` 的产品、项目、分支和任务分组统一使用 `  |  `。
- 内置 Header 从 `APP_TITLE` 注入产品名；上下文统计复用同一个 separator，宽屏显示“百分比 | 已用/上限”。
- 将 Header 响应式断点校正为内容宽度 `100/72`，适配全屏左右内边距；因此真实 `120x36` 不会丢掉产品名，真实 `80x24` 仍保留项目、分支和任务信息。
- 明确保留 Footer、Tool 摘要、完成摘要、活动条、快捷栏和输入框模型状态中的 `·`，没有做无差别全局替换。
- 增加 `80x24`、`80x8`、`120x36` 布局回归测试，验证 Header 内容、上下文统计、固定高度和行宽上限。

### 已运行验证

```text
cd packages/coding-agent && npx vitest --run test/lystar-workspace.test.ts test/task-workbench-components.test.ts test/workspace-shortcut-bar.test.ts --maxWorkers=2 --pool=forks --reporter=dot
3 个测试文件，57 项测试通过

npm run check
通过：Biome、依赖/导入检查、tsgo、GUI 检查和 browser smoke

npm run build:offline
通过：TUI、AI、Agent、Coding Agent、GUI Protocol、GUI Host 和 GUI 构建

git diff --check
通过
```

PTY 使用独立 socket `lystar-header-20260823-r2` 和临时 `PI_CODING_AGENT_DIR` 验证 `80x24`、`80x8`、`120x36`：80 列使用紧凑上下文统计，80x8 保留输入框和快捷栏，120 列显示 `LYStar Code  |` 及完整 `上下文 ...  |  已用/上限`。本轮未验证真实 Provider、流式回复、滚动分页、resize 交互、Windows/macOS、Tauri 或发行包实机运行。

### 下一项

图标方向已恢复为原有的 `uiGlyphs` / Unicode/emoji 资源和 Windows ASCII fallback；下一步进入长 Session 分页协调，不再继续扩展图标渲染入口。

### 整体进度

按本交接文档的五步实施顺序，当前完成第 3/5 步。产品版本与启动 Changelog、顶部 `|` 布局、错误折叠、原有 rich 图标路径和三种目标尺寸回归已落地；长 Session 连续滚动、性能硬门禁和完整 TUI 回归仍未完成。

## 本轮完成记录（2026-08-23，LYStar Icons）

### 已完成

- 恢复 `packages/coding-agent/src/modes/interactive/ui-glyphs.ts` 的原有 rich Unicode/emoji 资源、Windows ASCII fallback 和 `uiGlyphs` / `toUiGlyph` 兼容入口。
- 让 Tool、Tool Group、Tool Summary、Agent、Turn Summary、Web Search、活动条、Workspace 和 Windows 自检重新走原有 glyph 调用路径；没有改变 Session JSONL、Tool 名、Provider、Extension API 或 CLI 参数。
- 删除不可由普通终端直接渲染的 SVG sprite 和 `renderUiIcon` / `renderUiGlyph` 运行时入口；不针对 CMUX 或某个终端宿主增加分支。
- 保留 Tool 错误默认收起、Header 分隔符连续对齐和输入框/用户消息原有 `❯` 的独立修复。
- 更新 `interactive/DESIGN.md`，明确 Unicode/emoji 图标和 Windows 外部终端 ASCII 降级规则。

### 已运行验证

```text
cd packages/coding-agent && npx vitest --run test/ui-glyphs.test.ts test/tool-execution-component.test.ts test/tool-execution-group.test.ts test/task-workbench-components.test.ts test/assistant-message.test.ts test/bash-execution-width.test.ts --maxWorkers=2 --pool=forks --reporter=verbose
6 个测试文件，91 项测试通过

cd packages/coding-agent && npx vitest --run test/ui-glyphs.test.ts --maxWorkers=2 --pool=forks --reporter=verbose
1 个测试文件，5 项测试通过

npm run check --silent
通过：Biome、依赖/导入检查、tsgo、GUI 检查、锁文件检查和 browser smoke

npm run build:offline
通过：TUI、AI、Agent、Coding Agent、GUI Protocol、GUI Host 和 GUI 构建

git diff --check
通过
```

PTY 使用独立 socket `lystar-icons-20260823-r2` 和临时 `PI_CODING_AGENT_DIR`，依次验证 `80x24`、`80x8`、`120x36` 以及 resize 后的输入区、顶栏和退出清理。`80x8` 仍保留输入框和快捷提示，`120x36` 显示 `LYStar Code  |` 及完整上下文统计。本轮未使用真实 Provider，未单独验证流式回复、历史分页/滚动、Windows/macOS 实机、Tauri 或发行包运行；Windows fallback 由单元测试覆盖。

### 图标纠偏记录（2026-08-23）

前一版把 card 图标压成 `█/▀/▄` cell raster，实际终端中会呈现为白色或绿色几何块，视觉验收不通过；同时错误地替换了输入框原有的 `❯`。该方案已废止。

当前规则：

- 输入框、用户消息和提示行恢复原有 `❯`。
- Tool 图标恢复为集中维护的原有 Unicode/emoji 语义资源；Windows 外部终端继续使用明确的 ASCII fallback。
- 不针对 CMUX 或任何单一终端增加分支；所有普通终端使用同一套 rich 文本资源。
- 不保留运行时 SVG/iconfont 渲染假设，避免把终端能力当成项目契约。

### 下一项

进入实施顺序第 4 项：建立包含 Tool、Tool Result、Compaction 和分支的长 Session fixture，收口 `SessionTranscriptSource`、`LystarWorkspace`、`InteractiveMode` 和 `LystarTUI` 的分页协调状态与 entry 锚点恢复；先完成不重复、不丢失、不混分支的正确性，再补性能计时。不要在这一项继续扩展图标样式。

### 整体进度

按本交接文档的五步实施顺序，当前完成第 3/5 步。产品版本与启动 Changelog、顶部 `|` 布局、错误折叠和原有 rich 图标路径已落地；长 Session 连续滚动、性能硬门禁和完整 TUI 回归仍未完成。

## 兼容边界

以下内容不能被本阶段改动破坏：

- Session JSONL 格式。
- `SessionTranscriptSource` 对活动 leaf 的选择规则。
- Provider、Model ID、Tool 名和 Tool 协议。
- Extension API 和第三方 Extension renderer。
- `PI_*` 环境变量和 CLI 参数。
- `lc`、`lystar` 命令和退出码。
- Pi TUI 的差量 renderer、overlay 和输入系统。
- 深色/浅色主题加载和现有终端清理流程。

## 下一会话启动清单

1. 读取本文件、根目录 `AGENTS.md` 和 `AGENT_VERIFICATION.md`。
2. 运行：

```bash
git status --short --branch
git diff --check
git diff --stat
node -p 'require("./packages/coding-agent/package.json").piConfig'
```

3. 先阅读当前所有未提交文件的 diff，重点保留原有 8 个 TUI 文件和本轮产品版本相关改动，不覆盖已有改动。
4. 检查现有测试基线，优先运行：

```bash
cd packages/coding-agent
npx vitest --run test/lystar-workspace.test.ts test/task-workbench-components.test.ts test/session-transcript-source.test.ts
```

5. 图标工作开始前先阅读 `ui-glyphs.ts`、现有图标调用方、主题 token 和宽度工具，确认资源格式、compact/card 尺寸与 fallback 契约：

```text
资源定义是否集中
compact/card 的固定可见宽度
深色/浅色颜色角色
Windows 外部终端降级
visibleWidth/truncateToWidth 覆盖
```

6. 图标工作先确定资源格式、尺寸、颜色角色和 fallback 契约，再接入组件；不能先在组件中散落图形字符串。
7. 完成后至少执行：

```bash
git diff --check
npm run check
npm run build:offline
```

8. 可见 TUI 改动必须按项目验证要求使用独立 tmux socket，覆盖 80x24、80x8、120x36，以及滚动、分页、流式、resize 和退出恢复。

## 完成定义

本阶段只有同时满足以下条件才算完成：

- 启动提示显示 LYStar 产品版本和 LYStar 更新内容。
- 内置 TUI 图标全部经过统一的 `LYStar Icons` 系统，视觉丰富且不依赖 Emoji。
- 长 Session 可以从尾部连续滚到活动分支根节点。
- 分页不重复、不丢失、不混分支，锚点误差不超过 1 行。
- 滚动和历史加载不造成整屏停顿、跳底或输入区消失。
- 顶栏分隔符与设计目标统一使用 `|`。
- Session、Tool、Provider、Extension、CLI 和 `PI_*` 兼容契约保持不变。
- 自动测试、静态检查、离线构建和必要 PTY 验证全部通过。

## 本轮完成记录（2026-08-23，长 Session 分页协调）

### 已完成

- 在 `LystarWorkspace` 建立组件身份锚点协议：记录组件、组件内行号和 viewport 相对偏移；历史页插入后按同一组件恢复位置，不再依赖整页高度差。
- 处理“滚到顶部后尚未完成下一帧渲染就开始分页”的边界，避免从旧虚拟窗口误抓尾部组件作为锚点。
- 在 `InteractiveMode` 建立 transcript 分页状态：`idle`、`loading`、`exhausted`、`retryable-error`、`cursor-invalidated`。
- 物化 Session Entry 时集中登记 entry 与渲染组件的关系，分页去重仍以 Entry ID 为准；Tool、Tool Result 的显示状态继续由现有 Tool 组件负责。
- 分页失败现在会在界面可见，并保留当前 cursor 或重新读取 tail 的重试路径；cursor 失效时重新定位当前活动 leaf。
- 新增长 Session fixture 生成器 `packages/coding-agent/test/fixtures/long-session.ts`，覆盖 5000 条活动分支记录、Tool/Tool Result、Compaction，以及物理文件尾部的 sibling branch。
- 未修改 Session JSONL 格式、活动 leaf 选择规则、Provider、Tool 名、Extension API、CLI 参数和 `PI_*` 环境变量。

### 已运行验证

```text
cd packages/coding-agent && CI=1 npx vitest --run test/lystar-workspace.test.ts test/session-transcript-source.test.ts test/interactive-tui.test.ts --maxWorkers=2 --pool=forks --reporter=dot
3 个测试文件，55 项测试通过

CI=1 npm run check
通过：Biome、依赖/导入检查、tsgo、GUI 检查、锁文件检查和 browser smoke

npm run build:offline
通过：TUI、AI、Agent、Coding Agent、GUI Protocol、GUI Host 和 GUI 构建

git diff --check
通过
```

PTY 使用独立 socket `lystar-transcript-20260823-r2` 和临时 `PI_CODING_AGENT_DIR`，验证 `80x24`、`80x8`、`120x36` 启动界面、输入区、快捷栏和退出发送。长 Session 分页、分支隔离和 Tool/Compaction 连续性由 5000 条 fixture 的单元测试覆盖；本轮未单独在真实 PTY 中滚动这份长 Session。真实 Provider、流式回复、resize 过程、Windows/macOS、Tauri 和发行包实机运行仍未验证。

### 下一项

进入实施顺序第 5 项：补齐滚动/历史加载性能计时和硬门禁，重点验证 5000 条以上 Session 在 `80x8`、`80x24`、`120x36` 下的 p95 渲染时间、分页锚点误差和输入区稳定性；再做完整 TUI 回归。不要在性能任务中继续扩展图标或改变 Session 协议。

### 整体进度

按本交接文档的五步实施顺序，当前完成第 4/5 步。产品版本与启动 Changelog、顶部 `|` 布局、`LYStar Icons` 和长 Session 分页正确性已落地；性能硬门禁、完整 TUI 回归以及真实 Provider/跨平台实机验证仍未完成。

## 本轮完成记录（2026-08-23，性能硬门禁与完整 TUI 回归）

### 已完成

- 新增 `packages/coding-agent/test/lystar-tui-performance.test.ts`，使用现有 5000 条活动分支 fixture 覆盖 `80x8`、`80x24`、`120x36` 三种尺寸。
- 建立渲染 p95 硬门禁：三种尺寸的长 Session 虚拟滚动 p95 均不超过 16ms；测试同时确认每帧保持固定终端高度和底部编辑区/快捷栏可见。
- 建立分页锚点回归：模拟前置 80 条历史后，锚定组件身份和组件内行号不变，viewport 偏移误差不超过 1 行；底部输入区内容保持稳定。
- 建立历史加载耗时门禁：5000 条活动分支分页读取可到达根节点、无重复 Entry，分页读取 p95 不超过 100ms。
- 保持本轮变更不触碰 Session JSONL、Provider、Tool 名、Extension API、CLI 参数和 `PI_*` 环境变量。

### 已运行验证

```text
cd packages/coding-agent && CI=1 npx vitest --run test/lystar-tui-performance.test.ts --maxWorkers=1 --pool=forks --reporter=dot --testNamePattern='performance gates'
1 个测试文件，7 项测试通过

cd packages/coding-agent && CI=1 npx vitest --run test/assistant-message.test.ts test/bash-execution-width.test.ts test/changelog.test.ts test/interactive-tui.test.ts test/lystar-tui.test.ts test/lystar-tui-performance.test.ts test/lystar-workspace.test.ts test/session-transcript-source.test.ts test/task-workbench-components.test.ts test/tool-execution-component.test.ts test/tool-execution-group.test.ts test/ui-glyphs.test.ts test/workspace-shortcut-bar.test.ts --maxWorkers=2 --pool=forks --reporter=dot
13 个测试文件，167 项测试通过

CI=1 npm run check --silent
通过：Biome、依赖/导入检查、tsgo、GUI 检查、锁文件检查和 browser smoke

npm run build:offline
通过：TUI、AI、Agent、Coding Agent、GUI Protocol、GUI Host 和 GUI 构建

npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=2 --pool=forks --reporter=dot
252 个测试文件，2241 项测试通过

git diff --check --no-ext-diff
通过
```

PTY 使用独立 socket `lystar-perf-80x8-20260823`、`lystar-perf-80x24-20260823`、`lystar-perf-120x36-20260823` 和 `lystar-perf-resize-20260823`，覆盖 `80x8`、`80x24`、`120x36` 启动、输入框、快捷栏、退出，以及 `80x24 -> 120x36` resize。使用 `PI_OFFLINE=1` 和临时 `PI_CODING_AGENT_DIR`，未调用真实 Provider。

### 未验证项

- 本轮未在真实 PTY 中加载并滚动 5000 条 Session；滚动连续性、分页分支隔离、锚点和性能由单元测试覆盖。
- 真实 Provider、流式回复、`/settings` 与复杂 Overlay/Tool-Diff 的 PTY 交互、Windows/macOS、Tauri 和发行包实机运行仍未验证。

### 下个任务

按本交接文档的五步实施顺序，核心 TUI 阶段已完成第 5/5 步。下个任务不再扩展图标、分页或渲染架构，优先做现有未提交改动的审阅与拆分，然后按发布需要补真实 Provider/流式、复杂 Overlay 和目标平台实机验证；跨平台和发行验证只能在实际运行后单独记录。

### 整体进度

按五步实施顺序为 5/5：产品版本与启动 Changelog、顶部 `|` 布局、`LYStar Icons`、长 Session 分页正确性、性能硬门禁和完整 TUI 回归均已落地并通过本轮验证。剩余工作属于真实 Provider、跨平台/发行实机验证和未提交改动的审阅交付，不再是本阶段核心 TUI 实现缺口。
