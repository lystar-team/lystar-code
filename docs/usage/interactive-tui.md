# 交互界面与快捷键

[返回文档首页](../README.md)

LYStar 在普通终端中默认进入全屏工作区。顶部显示项目、分支、当前任务和上下文，中间是独立滚动的对话区，底部固定输入区、快捷栏和用量状态。Session 有名称时使用名称作为任务标题；没有名称时使用第一条用户消息的首行。

Agent 运行时，顶栏下方会出现一行活动状态，显示当前 Tool、已完成数量、排队消息和耗时。活动结束后该行自动消失。使用 Tool 的一轮结束后，对话区会增加一条完成摘要，显示修改文件数、真实增删行、命令成功数和耗时；`Ctrl+O` 或点击摘要可展开文件和失败项。纯文本回答不会增加摘要。

## 对话滚动

| 动作 | 默认操作 |
|---|---|
| 上下滚动 | 鼠标滚轮 |
| 按页滚动 | `Shift+PageUp` / `Shift+PageDown` |
| 跳到开头或末尾 | `Ctrl+Home` / `Ctrl+End` |
| 展开或折叠 Tool 输出 | `Ctrl+O` 或点击 Tool 摘要 |
| 回到底部 | 点击“有新内容”提示 |

向上滚动后，新输出不会抢回底部；回到底部或发送新消息后恢复自动跟随。

## 输入与任务控制

| 动作 | 默认操作 |
|---|---|
| 发送 | `Enter` |
| 换行 | `Shift+Enter` 或 `Ctrl+J` |
| 中止当前运行 | `Esc` |
| 文件与 Skill 搜索 | 输入 `@`；Skill 也可输入 `$` |
| 只搜索 Skill | 输入 `$` 或 `@[` |
| 命令补全 | 输入 `/` |
| Shell 命令并发送结果 | `!command` |
| Shell 命令但不发送结果 | `!!command` |
| 打开外部编辑器 | `Ctrl+G` |
| 粘贴图片 | `Ctrl+V`，Windows 使用 `Alt+V` |

Agent 运行中按 `Enter` 提交的消息会进入 steering 队列，`Alt+Enter` 提交 follow-up。`Alt+Up` 可把排队消息取回输入框。

## 变更审阅

运行 `/changes` 打开变更审阅器：

- `本轮触及` 来自当前运行中 Edit、Write Tool 的真实结果。
- `工作区全部` 来自当前目录的 Git 状态，包含运行前已经存在的未提交改动。
- `Tab` 切换范围，`↑` / `↓` 选择文件，`Enter` 切换完整 Diff，`PageUp` / `PageDown` 滚动，`Esc` 返回输入区。
- 非 Git 目录仍可查看本轮文件和已有结构化 Diff，不显示 Git 错误。

`/changes` 只负责查看，不会修改、回退、暂存或提交文件。

## 更新记录

全屏启动时，新版本提示只占一行。运行 `/changelog` 可在 Overlay 中查看完整更新记录；普通兼容模式继续按原设置显示更新内容。

## 模型和显示

| 动作 | 默认操作 |
|---|---|
| 选择模型 | `Ctrl+L` 或 `/model` |
| 下一个模型 | `Ctrl+P` |
| 上一个模型 | `Shift+Ctrl+P` |
| 切换思考强度 | `Shift+Tab` |
| 展开或折叠思考 | `Ctrl+T` |
| 显示全部快捷键 | `/hotkeys` |

快捷键可在 `~/.pi/agent/keybindings.json` 修改，保存后执行 `/reload`。完整 action id 见 [Pi Keybindings](../../packages/coding-agent/docs/keybindings.md)。

## 全屏与兼容模式

```bash
lc --alt-screen auto
lc --alt-screen always
lc --alt-screen never
lc --no-alt-screen
```

- `auto`：普通终端和常规 tmux 使用全屏；Zellij、tmux control mode、非 TTY 和 `TERM=dumb` 回退 inline。
- `always`：强制 alternate screen。
- `never`：保留终端历史滚动区。

鼠标覆盖：

```bash
lc --mouse
lc --no-mouse
```

LYStar UI 偏好保存在 `~/.pi/agent/lystar.json`：

```json
{
  "altScreen": "auto",
  "mouse": true,
  "reduceMotion": false
}
```

`reduceMotion` 会减少动画，不影响流式输出。配置读取失败时 LYStar 会指出具体文件和字段，不会静默覆盖。

## 小终端

终端高度很小时，状态、Extension Widget 和排队消息会优先让位给输入框与快捷栏。Agent 运行时，单行活动状态优先于顶栏次要信息保留。宽度不足时依次省略产品名、Provider 和详细 Token，只保留任务、模型和上下文百分比。可信项目不常驻提示；项目资源未加载时显示“项目资源受限”。若出现重叠或退出后终端没有恢复，记录终端名称、`TERM`、是否在 tmux/Zellij 中以及终端尺寸，再按[安装问题](../troubleshooting/installation.md)提交复现。

下一步：[Session 与项目规则](sessions-and-project-instructions.md)。
