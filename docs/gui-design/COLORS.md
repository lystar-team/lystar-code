# LYStar Code GUI 配色规范

> 日期：2026-08-13

## 原则

- 主题模式为跟随系统、浅色、深色，首次启动默认跟随系统。
- 两套主题共用语义角色，不共用未经校准的 RGB 值。
- 中性灰承担主要界面，蓝色只标交互与焦点，绿黄红只标状态。
- 状态色不铺满大区域；Diff 行底色是少数必要例外。
- 实现只消费语义 Token，不在组件内直接写颜色值。

## 核心色

| 角色 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| Canvas | `#FFFFFF` | `#151515` | 主内容背景 |
| Sidebar | `#F6F6F6` | `#242424` | 侧栏与设置导航 |
| Surface | `#FFFFFF` | `#1D1D1D` | 输入、菜单、Tool、设置组 |
| Subtle | `#F3F3F3` | `#2B2B2B` | 用户消息、次级表面 |
| Selected | `#E8E8E8` | `#333333` | 当前项目、Session、文件 |
| Border | `#E3E3E3` | `#3D3D3D` | 普通边框与分隔 |
| Text | `#0D0D0D` | `#F5F5F5` | 正文与主要动作 |
| Secondary | `#6F6F6F` | `#A6A6A6` | 连接名、时间、路径辅助信息 |
| Accent | `#0169CC` | `#4DA3FF` | 链接、焦点、选中 Tab |
| Success | `#0A9F4A` | `#39D27D` | 在线、完成、增加 |
| Warning | `#C76A00` | `#F59E42` | 重连、权限、等待 |
| Error | `#D92D20` | `#FF6259` | 连接失败、删除、Tool 错误 |

## 对比度

核心组合的 WCAG 对比度：

| 组合 | 对比度 |
|---|---:|
| 浅色正文 / Canvas | `19.44:1` |
| 浅色次要文字 / Canvas | `5.02:1` |
| 浅色 Accent / Canvas | `5.39:1` |
| 深色正文 / Canvas | `16.75:1` |
| 深色次要文字 / Canvas | `7.50:1` |
| 深色 Accent / Canvas | `6.96:1` |

正文、控件标签和链接满足普通文字 `4.5:1`。禁用状态不承担关键说明或唯一操作入口。

## 项目与连接

- 本机项目没有状态点，也不使用“本机”颜色标签。
- SSH 在线使用 Success，重连使用 Warning，失败使用 Error，离线使用 `textMuted`。
- 状态点直径 `8px`，颜色不是唯一信息：Hover、Tooltip 和可访问名称同时说明状态。
- 连接名称使用 `textSecondary`，不能比项目名称更醒目。

## Diff

| 角色 | 浅色 | 深色 |
|---|---|---|
| Added text | `#08783A` | `#61E39A` |
| Added surface | `#E8F7EE` | `#173D29` |
| Deleted text | `#B42318` | `#FF8A83` |
| Deleted surface | `#FDECEA` | `#4B211E` |

- `+/-`、行号和左右标记必须同时存在，不能只靠红绿区分。
- 未变化代码使用 Canvas 或 Surface，不添加彩色背景。
- 大面积 Diff 颜色降低饱和度，保证长时间阅读。

## 品牌色

- LYStar 星芒保持原始蓝色，不从 UI Accent 自动换色。
- 浅色 Logo 使用 `brand/lystar-mark-light.png`。
- 深色 Logo 使用 `brand/lystar-mark-dark.png`。
- UI 生成图中的 Logo 只表示位置，实现必须使用原始品牌资产。

## 禁止

- 紫蓝渐变、玻璃、发光、彩色阴影和大面积蓝色背景。
- 用 Success 作为普通选中状态。
- 用 Warning 或 Error 铺满整张 Tool 卡片。
- 把浅色 Token 机械反相生成深色 Token。