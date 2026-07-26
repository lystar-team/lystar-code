# 交互界面与快捷键

[返回文档首页](../README.md)

LYStar 在普通终端中默认进入全屏工作区。顶部显示项目、分支、Session 和上下文，中间是独立滚动的对话区，底部固定输入区、快捷栏和用量状态。

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
la --alt-screen auto
la --alt-screen always
la --alt-screen never
la --no-alt-screen
```

- `auto`：普通终端和常规 tmux 使用全屏；Zellij、tmux control mode、非 TTY 和 `TERM=dumb` 回退 inline。
- `always`：强制 alternate screen。
- `never`：保留终端历史滚动区。

鼠标覆盖：

```bash
la --mouse
la --no-mouse
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

终端高度很小时，状态、Extension Widget 和排队消息会优先让位给输入框与快捷栏。宽度不足时隐藏次要状态。若出现重叠或退出后终端没有恢复，记录终端名称、`TERM`、是否在 tmux/Zellij 中以及终端尺寸，再按[安装问题](../troubleshooting/installation.md)提交复现。

下一步：[Session 与项目规则](sessions-and-project-instructions.md)。
