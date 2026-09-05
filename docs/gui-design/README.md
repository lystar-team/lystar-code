# LYStar Code GUI 设计素材

本目录是 LYStar Code GUI 视觉与组件实现的事实源。开发顺序以 `DESIGN.md`、`tokens.json`、`COLORS.md` 和 `COMPONENTS.md` 为准，PNG 只用于结构和视觉参考。

## 规范

| 文件 | 用途 |
|---|---|
| `DESIGN.md` | 产品视觉方向、布局、主题、项目列表和品牌规则 |
| `tokens.json` | Design Token 结构化事实源 |
| `tokens.css` | 前端 CSS 变量参考实现 |
| `COLORS.md` | 配色角色、对比度、Diff 与状态色规范 |
| `COMPONENTS.md` | 组件尺寸、状态、交互与可访问性规范 |
| `PROMPTS.md` | 本轮设计图生成提示词和限制 |

## 正式页面设计图

| 图片 | 用途 |
|---|---|
| `screens/main-workspace-light.png` | 浅色主工作台 |
| `screens/main-workspace-dark.png` | 深色主工作台 |
| `screens/review-workspace-light.png` | 浅色变更审阅工作区 |
| `screens/review-workspace-dark.png` | 深色变更审阅工作区 |
| `screens/session-search-light.png` | 浅色 Session 搜索、恢复与删除确认 |
| `screens/session-search-dark.png` | 深色 Session 搜索、恢复与删除确认 |
| `screens/settings-appearance-light.png` | 浅色外观设置 |
| `screens/settings-appearance-dark.png` | 深色外观设置 |
| `screens/settings-connections-light.png` | 浅色 SSH 连接管理 |
| `screens/settings-connections-dark.png` | 深色 SSH 连接管理 |
| `screens/settings-models-auth-light.png` | 浅色模型与 Provider 认证管理 |
| `screens/settings-models-auth-dark.png` | 深色模型与 Provider 认证管理 |
| `screens/settings-skills-light.png` | 浅色 Skill 搜索、作用域、启停与诊断 |
| `screens/settings-skills-dark.png` | 深色 Skill 搜索、作用域、启停与诊断 |
| `screens/settings-update-light.png` | 浅色自动更新结果、进度与详情 |
| `screens/settings-update-dark.png` | 深色自动更新结果、进度与详情 |
| `screens/settings-diagnostics-light.png` | 浅色异常优先诊断页 |
| `screens/settings-diagnostics-dark.png` | 深色异常优先诊断页 |
| `screens/settings-about-light.png` | 浅色关于与组件版本信息 |
| `screens/settings-about-dark.png` | 深色关于与组件版本信息 |
| `screens/narrow-workspace-light.png` | `800×600` 逻辑窄窗口默认工作态，`1600×1200 @2x` 交付 |
| `screens/narrow-workspace-dark.png` | `800×600` 逻辑窄窗口默认工作态，`1600×1200 @2x` 交付 |
| `components/component-states-light-dark.png` | 浅/深组件与状态总览 |
| `palettes/color-system.png` | 精确浅/深色板、状态、Diff、焦点和对比度 |

宽屏页面统一交付为 `2816×1640`，组件状态板为 `3072×2048`。图片是视觉参考，精确值以 Token 和规范文档为准。

## 品牌资产

| 文件 | 用途 |
|---|---|
| `brand/lystar-mark-light.png` | 浅色表面的原始黑色 Mark 母版 |
| `brand/lystar-mark-dark.png` | 深色表面的原始白色 Mark 母版 |
| `brand/lystar-mark-on-light.png` | 从浅色母版导出的透明底实装资产 |
| `brand/lystar-mark-on-dark.png` | 从深色母版导出的透明底实装资产 |
| `brand/lystar-wordmark.png` | 完整 LYStar 字标 |

生成图中的 Logo 可能存在模型重绘误差。实现必须直接使用 `brand/` 下的资产，不能从页面设计图裁切 Logo，也不能自行重绘。母版是品牌事实源，透明底资产是当前实现入口；实装前必须分别在浅色和深色真实表面检查 Alpha 边缘。

## 事实源顺序

1. `DESIGN.md`：布局和视觉方向。
2. `tokens.json`、`COLORS.md`、`COMPONENTS.md`：精确开发值。
3. `brand/`：品牌资产。
4. PNG：页面结构和视觉参考。

图片中的细小中文、路径和数值可能受生成模型影响，不能覆盖 Markdown 和 JSON 中的精确定义。

## 核心约束

- 项目只有一个连续列表。本机项目不显示连接名和状态点；SSH 项目右侧显示连接名和状态点。
- 当前项目的 Session 直接在项目下展开。
- Composer 保持干净，只保留附件、必要状态、模型/思考强度文字和一个发送/停止按钮。
- 浅色、深色和跟随系统共用组件几何，分别使用语义 Token。
- Inspector 默认关闭，审阅时从右侧打开。
- `800×600` 正式稿展示侧栏关闭的工作态；抽屉打开态是单独交互状态。
- 模型与认证、Skill、自动更新、诊断和关于页只展示 Host 可回查的真实状态。
- 设计只覆盖当前已确认的 GUI 能力。

## 参考图

`references/` 保存用户提供的 Codex App 截图，只用于学习信息结构、密度、排版、表面层级和交互关系，不复制 Codex 品牌或未规划功能。`references/codex-skills-settings.png` 专门用于 Skill 页的 Tab、搜索、连续列表和行级启停关系。

## 废弃稿

早期双主题并排缩略稿因压缩窗口比例、项目分组错误和 Composer 过重，已删除。后续评审只使用本 README 列出的页面设计图。