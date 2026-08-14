# LYStar Code GUI 设计图生成提示词

> 日期：2026-08-13
>
> 用途：复现 `screens/` 与 `components/` 下的设计图。图片只承担结构和视觉参考，精确文案、颜色和尺寸以 `DESIGN.md`、`tokens.json`、`COLORS.md` 和 `COMPONENTS.md` 为准。

## 使用方式

每张图的最终提示词由三部分顺序拼接：

```text
全局基线
+ 对应页面块
+ 对应主题块
```

将页面块列出的参考图片作为 `referenced_image_paths` 传入。深色同构稿必须同时传入对应浅色稿，要求只校准主题，不改结构。

## 全局基线

```text
Use case: production desktop application UI design specification.
Asset type: high-fidelity LYStar Code GUI desktop application mockup.
Primary request: Design a mature, production-grade Chinese coding Agent workspace. Learn only information architecture, proportions, density, typography, surface hierarchy and interaction restraint from the supplied Codex App references. Product functions must come exclusively from the LYStar Code GUI development plan.
Scene: one complete native desktop app window, no browser frame, no external poster canvas, no marketing page.
Language: all visible user-facing text uses Simplified Chinese except project names, paths, model names, Git branches, SSH targets, versions, Protocol identifiers and environment variables.
Project rule: use one continuous project list. Never create separate local and SSH project groups. Local projects show folder and project name only, with no host label and no status dot. SSH projects show project name, right-aligned saved connection name and a small connection status dot. The current project's Sessions expand directly below the project row.
Conversation rule: Assistant prose is unframed and continuous. User messages, Tool, Diff, Composer and Inspector use a surface only when a boundary is necessary. Tool and file changes are flat bordered components, not decorative cards.
Composer rule: preserve a large clean input surface. Bottom-left contains attachment and only a currently relevant permission or trust state. Bottom-right contains compact model/thinking text and one circular send/stop action. No connection selector, no row of large Select boxes and no separate rectangular Send button.
Brand rule: use supplied LYStar brand assets only for placement and identity. Do not creatively reinterpret the mark. Implementation must use original assets, not the generated rendering.
Style: quiet, neutral, high-density operational desktop tool; crisp vector-like raster; Chinese system UI typography; thin borders; stable alignment; 4px spacing grid; radius 4/6/8px, Composer maximum 12px.
Avoid: Codex/OpenAI branding, unsupported LYStar features, gradients, glass, glow, purple palette, blue-black cast, nested cards, marketing composition, oversized headings, excessive whitespace, giant shadows, bento layout, fake charts, watermark, distorted proportions, overlapping UI and illegible text.
```

## 主题块

### 浅色

```text
Theme: calibrated neutral light theme.
Colors: canvas #FFFFFF, sidebar #F6F6F6, surface #FFFFFF, subtle #F3F3F3, selected #E8E8E8, border #E3E3E3, primary text #0D0D0D, secondary #6F6F6F, accent #0169CC, success #0A9F4A, warning #C76A00, error #D92D20. Diff additions use #E8F7EE / #08783A; deletions use #FDECEA / #B42318.
```

### 深色

```text
Theme: calibrated neutral dark theme. Preserve the corresponding light screen geometry exactly; this is theme calibration, not a redesign.
Colors: canvas #151515, sidebar #242424, surface #1D1D1D, subtle #2B2B2B, selected #333333, border #3D3D3D, primary text #F5F5F5, secondary #A6A6A6, accent #4DA3FF, success #39D27D, warning #F59E42, error #FF6259. Diff additions use #173D29 / #61E39A; deletions use #4B211E / #FF8A83.
```

## 页面块

### 主工作台

输出：

- `screens/main-workspace-light.png`
- `screens/main-workspace-dark.png`

参考资产：

```text
references/codex-project-list-annotated.png
references/codex-gui-light.png or references/codex-gui-dark.png
references/codex-review-workspace.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Canvas: complete wide window, approximately 2816x1640, undistorted. Left sidebar approximately 25 percent and main conversation approximately 75 percent. Inspector is closed.
Sidebar: small LYStar mark and text "LYStar Code", search and notifications icons, "新会话", "会话搜索", one section "项目". Local rows: "Scripts", "湘潭市本级信息化集中运维第一批项目". SSH rows: "lystar-agent", "guotou-platform", "lystar-magic-agent", "xtdx-yzt-wechat", "yean-research" with connection names "Yean-Debian-PC" or "开发服务器" and status dots. Selected "lystar-agent" expands Sessions "完善 GUI 设计规范", "GUI 开发方案", "修复 Session 并发写入". Bottom action "设置".
Top bar: "lystar-agent / 完善 GUI 设计规范", "Yean-Debian-PC", Git branch "main", command "变更" and minimal icon actions.
Conversation: user message "请按照开发方案完善 LYStar Code GUI 的设计规范，项目列表不要区分本机和 SSH 分组。" Assistant text "已按开发方案调整项目列表和双主题规范。" Bullets "本机和 SSH 项目使用同一列表。", "远程项目显示连接名称和状态。", "Composer 保持简洁。" Thinking row "已处理 8 分 24 秒". Tool rows "读取开发方案" and "更新设计规范". File change summary "已编辑 3 个文件" with +126 and -34.
Composer: 140-190px clean input surface, placeholder "输入任务或继续说明", plus attachment, optional amber "完整访问", compact "GPT-5.4 中" and one circular send arrow.
```

### 变更审阅工作区

输出：

- `screens/review-workspace-light.png`
- `screens/review-workspace-dark.png`

参考资产：

```text
screens/main-workspace-light.png or screens/main-workspace-dark.png
references/codex-review-workspace.png
references/codex-project-list-annotated.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Canvas: complete wide window around 2816x1640. Preserve the unified project sidebar. Middle conversation is around 25 percent. Right review workspace is around 50 percent and opens from "变更".
Review top: lightweight title "审阅", close icon, tabs "本轮文件" and "工作区变更", total +126 -34, previous/next arrows, overflow and filter.
Diff: file "docs/gui-design/DESIGN.md", readable line numbers, unchanged rows, subtle added and deleted rows. Delete "本机项目和 SSH 项目分别分组" and add "本机和 SSH 项目使用同一连续列表". Delete "Composer 显示多个选择器" and add "Composer 只保留必要控制".
File tree: search "筛选文件...", root "liteasy-pi-agent", folders "docs / gui-design", files "DESIGN.md", "tokens.json", "COMPONENTS.md" with modification indicators.
Conversation remains usable and includes a compact Composer. Do not add pull request, Worktree, terminal or branch-management features.
```

### Session 搜索与恢复

输出：

- `screens/session-search-light.png`
- `screens/session-search-dark.png`

参考资产：

```text
screens/main-workspace-light.png or screens/main-workspace-dark.png
references/codex-gui-light.png or references/codex-gui-dark.png
references/codex-project-list-annotated.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Sidebar: approved unified project list with selected "会话搜索".
Main title "会话搜索". Search input "搜索标题、项目或 Session ID". Filters "全部项目", "全部连接", "最近 30 天" and "仅显示可恢复".
Group results by date headings "今天", "昨天", "更早", never by local/SSH type. Results include "完善 GUI 设计规范" and "GUI 开发方案" under SSH project "lystar-agent" with connection "Yean-Debian-PC" and green dot; local "整理自动更新脚本" under "Scripts" with no connection and no dot; offline "修复远端 Host 恢复" under "guotou-platform" with connection "Yean-Debian-PC", gray dot and "离线可定位".
Selected offline row shows actions open/recover, rename and more; inline notice "连接后将恢复该 Session" and command "连接并打开".
Show a modest confirmation modal "删除 Session？" with text "只删除 Session 记录，不删除项目文件。此操作无法撤销。" and buttons "取消" and red "删除".
Do not add tags, cloud sync, team sharing or unsupported bulk operations.
```

### 外观设置

输出：

- `screens/settings-appearance-light.png`
- `screens/settings-appearance-dark.png`

参考资产：

```text
references/codex-settings-general.png
references/codex-settings-appearance.png
references/codex-settings-personalization.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Settings layout: left navigation about 25 percent and main content about 75 percent. Left has LYStar mark, "返回应用", search "搜索设置...", categories "通用", "外观", "连接", "模型与认证", section heading "能力" with "Skill", then "自动更新", "诊断", "关于". Select "外观".
Main title "外观". Theme choices "跟随系统", "浅色", "深色" with "跟随系统" selected. Section "界面": "界面语言 简体中文", "字体缩放 100%", "代码字体 系统等宽字体", "减少动态效果" off. Section "对话": "Tool 默认折叠", "Diff 默认折叠", "长输出按需展开" on. Section "侧栏": "项目列表密度 紧凑", "只展开当前项目会话" on, note "本机和 SSH 项目使用同一列表；远程项目显示连接名称和状态。"
Use toggles for booleans and Select for enums. Do not copy voice, pet, browser, computer-control, Worktree, Hook, memory or custom-instruction settings.
```

### SSH 连接管理

输出：

- `screens/settings-connections-light.png`
- `screens/settings-connections-dark.png`

参考资产：

```text
screens/settings-appearance-light.png or screens/settings-appearance-dark.png
screens/main-workspace-light.png or screens/main-workspace-dark.png
references/codex-settings-general.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Select navigation "连接". Title "连接" and text "管理用于远程项目的 SSH 连接。项目仍显示在主界面的统一项目列表中。" Top-right "添加连接".
Connection rows: "Yean-Debian-PC", target "yean@192.168.1.10", status "已连接", Host version "0.84.1-lystar-gui.1", "12 个项目"; "开发服务器", target "deploy@10.0.0.25", status "未连接", Host "等待连接", "3 个项目". Include test, edit and more icon actions.
Selected connection detail: "连接名称", "SSH 目标", "默认目录 /home/yean/projects", "认证方式 系统 SSH / ssh-agent", note "LYStar 不保存 SSH 密码", "测试连接" with result "连接正常 · Linux x64 · Host 已就绪", "自动重连" on.
Bottom destructive action "移除连接" with note "只移除本机配置，不删除远端项目、Session 或 Host 数据。"
Do not show password storage, SFTP, terminal, cloud sync or public TCP port options.
```

### 模型与认证

输出：

- `screens/settings-models-auth-light.png`
- `screens/settings-models-auth-dark.png`

参考资产：

```text
screens/settings-appearance-light.png or screens/settings-appearance-dark.png
screens/settings-connections-light.png or screens/settings-connections-dark.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Use the approved settings shell. Left navigation categories are "通用", "外观", "连接", selected "模型与认证", section heading "能力" with "Skill", then "自动更新", "诊断", "关于".
Main title "模型与认证" and text "管理模型提供方与认证。凭据只保存在 LYStar 后台。" Page-level search "搜索 Provider 或模型".
Provider summary is a continuous list, not cards. Rows: "OpenAI" with status "已连接 · OAuth", action "重新认证", "18 个可用模型"; "Anthropic" with status "环境变量 · ANTHROPIC_API_KEY", action "查看模型", "12 个可用模型"; "Google" with status "需要认证", primary action "登录", "9 个模型"; "OpenRouter" with status "已连接 · auth.json", action "退出", "312 个可用模型". Use familiar provider-neutral key or link icons, no external brand logos required.
Selected OpenAI row expands a modest detail area: authentication source "OAuth", status "有效", command "退出"; model filter tabs "全部", "文本", "图像"; model rows "gpt-5.4", "gpt-5.4-mini", "o4-mini" with model IDs in monospace, capability text and availability. Mark "gpt-5.4" as "默认".
Include a quiet note "OAuth 将在系统浏览器中打开；API key 提交后不会回显。" Never show an API key, token, auth.json content, copied credentials, billing, usage charts or unsupported account management.
```

### Skill

输出：

- `screens/settings-skills-light.png`
- `screens/settings-skills-dark.png`

参考资产：

```text
references/codex-skills-settings.png
screens/settings-appearance-light.png or screens/settings-appearance-dark.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Use the approved LYStar settings shell, not the Codex sidebar. Select navigation "Skill" under section heading "能力". Main title "Skill" and text "管理当前 Runtime 已发现的 Skill。" Top-right secondary action "重新加载".
Page tabs "全部 42", "用户 34", "项目 8" with "全部 42" selected. Search field "搜索 Skill" aligned to the right of tabs. Do not add Plugin, MCP or Marketplace tabs.
Use a high-density continuous list with generous readable row height, learned from the supplied Codex Skill reference. Rows include: "Agent Reach" description "搜索网页、社交平台与视频内容", scope "用户", enabled; "CodeGraph Workflow" description "分析代码链路、调用关系和影响面", scope "用户", enabled; "UI Design" description "设计、修改与评审前端可见界面", scope "用户", enabled; "LYStar GUI Review" description "检查 GUI 设计规范与页面一致性", scope "lystar-agent", enabled; "Release Checklist" description "核对 LYStar 发布与更新链路", scope "lystar-agent", disabled; "Legacy Skill" description "SKILL.md 缺少 description", scope "用户", error state and disabled toggle.
Each row: one restrained cube/package icon, name, maximum two-line description, right-aligned scope and Toggle. Selected/error row may reveal one inline diagnostic line and actions "打开所在目录" and "查看诊断". Add a project trust notice only for project resources: "项目 Skill 仅在信任当前项目后加载。"
Do not show ratings, downloads, author avatars, remote marketplace, install buttons, Plugin/MCP counts, fake packages or Codex branding.
```

### 自动更新

输出：

- `screens/settings-update-light.png`
- `screens/settings-update-dark.png`

参考资产：

```text
screens/settings-appearance-light.png or screens/settings-appearance-dark.png
screens/settings-connections-light.png or screens/settings-connections-dark.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Use the approved settings shell and select "自动更新". Main title "自动更新". The first viewport must answer current result, current action and target version without exposing the whole internal state machine.
Top status row: amber clock icon, title "等待任务结束后更新", text "已下载并验签新版本。1 个本机 Tool 运行中，任务结束后自动安装。" Current primary action "立即查看任务" and secondary "取消本次安装". Do not use a large green verified banner.
Version summary is one continuous comparison row: current "LYStar Code GUI 0.84.1-lystar-gui.1" arrow to target "0.84.1-lystar-gui.2"; secondary text "Bundled Runtime 0.84.1 · 受管 TUI 0.84.1-lystar.13 → .14" and badge "兼容路径已验证".
Progress block: one progress bar 42%, label "已下载 186 MB / 442 MB", current step "等待本机任务安全点", following text "随后安装 GUI，并更新受管 TUI". Show one compact system notice "macOS 可能需要确认，完成系统操作后将自动继续。"
Settings rows: "自动检查" on, "自动下载" on, "自动安装" on, "上次检查 2026-08-13 14:32". Bottom disclosure row "更新详情" collapsed; its summary says "signature 有效 · setVersion 18 · 2 台远端 Host 已就绪". Link "查看更新诊断".
Do not simultaneously expand current combination, target combination and three upgrade columns. Do not provide a signature toggle, replay-protection toggle, arbitrary version picker, beta/nightly channel or unsupported automatic rollback promise.
```

### 诊断

输出：

- `screens/settings-diagnostics-light.png`
- `screens/settings-diagnostics-dark.png`

参考资产：

```text
screens/settings-appearance-light.png or screens/settings-appearance-dark.png
screens/settings-connections-light.png or screens/settings-connections-dark.png
screens/settings-update-light.png or screens/settings-update-dark.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Use the approved settings shell and select "诊断". Main title "诊断" and text "检查本机、连接、Session 与更新链路。诊断信息不会包含凭据或完整 Prompt。" Page actions "重新检查" and icon-only export with tooltip.
First section "需要处理" contains two clear issue rows, ordered by impact. Issue 1 amber: "开发服务器正在重连", detail "尝试 2/5 · 远程项目暂时只读", action "立即重试". Issue 2 amber: "1 个任务上次异常中断", detail "operation 已标记 interrupted，不会自动重跑", action "查看任务". Each issue uses a single flat bordered row, not a dashboard card.
Second section "检查项目" uses collapsed disclosure rows: "本机" status "5 项正常"; "连接与远端" status "1 项需处理 · 1 项正常" expanded enough to show Yean-Debian-PC connected and 开发服务器 reconnecting; "Session 与任务" status "1 项需处理 · writer lock 正常"; "更新安全" status "4 项正常". Normal technical details stay collapsed.
One selected detail panel at the bottom may show "开发服务器" with target, Linux x64, Host version, last successful connection, current retry and copyable error summary. Do not display every GUI/Host/Runtime/Protocol row at once.
Footer actions "导出诊断包" and "打开日志目录", note "自动移除 token、Authorization、图片原始数据和完整 Prompt".
Do not add credentials, Prompt content, public port controls, telemetry charts, reset-all or destructive repair.
```

### 关于

输出：

- `screens/settings-about-light.png`
- `screens/settings-about-dark.png`

参考资产：

```text
screens/settings-appearance-light.png or screens/settings-appearance-dark.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
brand/lystar-wordmark.png
```

```text
Use the approved settings shell and select "关于". Main content is calm and left-aligned, not a centered marketing splash.
Brand header: use the supplied real LYStar mark, title "LYStar Code", subtitle "跨平台中文编码 Agent 工作台", version "GUI 0.84.1-lystar-gui.1" and primary action "检查更新".
Section "组件版本" is a continuous list: "Bundled Host 0.84.1-lystar-gui.1", "Bundled Runtime / Pi 基线 0.84.1", "GUI Protocol v1", "LYStar Code TUI 0.84.1-lystar.13 · 官方托管". Provide icon-only copy action for full version information.
Section "项目" rows: "发行仓库 lystar-team/lystar-code" action "打开", "许可证" action "查看", "第三方许可证" action "查看".
Section "本机数据" rows: "配置目录 ~/.pi/agent" action "打开", "日志目录" action "打开", "诊断" action "查看诊断". Add restrained note "卸载或回退不会删除 Session 与项目配置。"
Do not show donation, account, telemetry metrics, marketing feature lists, release roadmap, social links or fake copyright details.
```

### 窄窗口工作台

输出：

- `screens/narrow-workspace-light.png`
- `screens/narrow-workspace-dark.png`

参考资产：

```text
screens/main-workspace-light.png or screens/main-workspace-dark.png
references/codex-project-list-annotated.png
brand/lystar-mark-light.png or brand/lystar-mark-dark.png
```

```text
Responsive target: true 800x600 logical 4:3 window, delivered at 1600x1200 @2x. This is the default working state with the sidebar drawer CLOSED. Do not stretch or crop a wide desktop layout.
Top bar 48px: hamburger, truncated title "lystar-agent / 完善 GUI 设计规范", command "变更" and one overflow icon. Hide host, branch and secondary icons.
Main conversation uses 20-24px side padding and remains fully readable. Show one compact user message, one unframed Assistant response with three short bullets, two collapsed Tool rows and a file change summary. The viewport should suggest scrollable history without overcrowding.
Fixed Composer 112-132px high at the bottom, separated from the transcript. It has a two-to-four-line clean textarea with placeholder "输入任务或继续说明". Bottom row contains attachment at left, compact truncated "GPT-5.4 · 中" near the right and one circular send arrow. No connection selector and no extra tool grid.
Do not show a permanent sidebar, dim scrim or open drawer in this formal baseline. The drawer-open interaction is specified separately: a 288px overlay from the left, with background scrim and no simultaneous Inspector.
Inspector is closed. Do not use mobile bottom navigation, one-line Composer, squeezed desktop controls, oversized bubbles or hidden send action.
```

### 组件状态板

输出：

- `components/component-states-light-dark.png`

参考资产：

```text
screens/main-workspace-light.png
screens/main-workspace-dark.png
screens/settings-appearance-light.png
screens/review-workspace-light.png
brand/lystar-mark-light.png
brand/lystar-mark-dark.png
```

```text
Create a high-resolution component specification board split into equal "浅色主题" and "深色主题" areas. Both themes show identical component geometry.
Groups:
1. "品牌与导航": LYStar placement, icon button default/hover/pressed/focus/disabled, selected sidebar item.
2. "项目与会话": local "Scripts" without host/dot; SSH "lystar-agent" with connection and green dot; reconnecting amber, offline gray, failed red; selected project with indented Sessions.
3. "对话与过程": user bubble, unframed Assistant, thinking row, Tool running/completed/failed, file summary +126 -34.
4. "Composer": empty, focused, running and disabled; attachment, optional access state, model/thinking text, send/stop in one stable round action area.
5. "表单与命令": text input, search, Select, menu, Checkbox, Toggle, primary/secondary/danger commands, Tooltip and Toast states.
6. "审阅与 Diff": file row, counters, unchanged/added/deleted lines, selected file tree row, tabs "本轮文件" and "工作区变更".
7. "系统状态": loading, "暂无会话", "连接失败", "重新连接", "该会话正在其他进程中使用".
Keep labels outside components, use a 4px grid, thin borders and no decorative art.
```

## 后处理

- 宽屏页面统一输出 `2816×1640`。
- 窄窗口按逻辑 `800×600` 输出 `1600×1200 @2x`。
- 组件板输出 `3072×2048`。
- 使用 Lanczos 等比例缩放，不拉伸布局。
- 逐张检查：中文大标题、列表结构、控件重叠、项目状态点、禁用装饰、Logo 位置和最终尺寸。
- 图片模型中的细小中文、路径和数值只作示意；开发使用规范文件的精确内容。
