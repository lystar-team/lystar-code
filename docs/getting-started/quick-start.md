# 5 分钟快速开始

[返回文档首页](../README.md)

完成[安装](installation.md)后，可以使用浏览器工作台或终端界面。`lc` 与 `lystar` 完全等价，以下示例使用 `lc`。

## 使用 WebUI

在终端执行：

```bash
lc web
```

1. 按提示设置白名单、Web 端口、Runtime 端口和连接密码，两个默认端口分别为 `1420`、`1422`。
2. 在本机浏览器打开 `http://127.0.0.1:1420`，输入连接密码；改过端口时使用终端输出的地址。
3. 打开“模型与认证”，配置供应商 API Key。使用订阅登录时，先在终端运行 `lc` 并执行 `/login`。
4. 点击“添加项目”，选择运行 LYStar 的电脑上的目录，再新建对话、选择模型并发送任务。

```text
阅读这个项目，告诉我使用了什么技术栈、如何启动、如何运行测试。先不要修改文件。
```

WebUI 默认在后台运行。手机或另一台电脑可通过 `http://<运行 LYStar 的电脑 IP>:1420` 连接；设备需要网络互通，访问地址须在白名单内。更多操作见 [WebUI 使用指南](../usage/webui.md)。

## 使用终端

进入准备处理的项目目录：

```bash
cd /path/to/project
lc
```

LYStar 默认拥有读取、写入、编辑文件和执行 Bash 命令的能力。建议在 Git 仓库中使用，并在较大修改前保留提交。

### 1. 登录 Provider

在输入区执行：

```text
/login
```

可选择 ChatGPT Plus/Pro、Claude Pro/Max、GitHub Copilot 等订阅登录，也可以选择 API Key Provider。凭据保存在 `~/.pi/agent/auth.json`，该文件只允许当前用户读写。

Provider 和国内模型服务配置见 [Provider 与 API Key](providers.md)。

### 2. 选择模型

```text
/model
```

也可以按 `Ctrl+L` 打开模型选择器。`Shift+Tab` 切换当前模型支持的思考强度。

### 3. 发送第一条任务

输入一条范围明确、结果可验证的任务：

```text
阅读这个项目，告诉我使用了什么技术栈、如何启动、如何运行测试。先不要修改文件。
```

需要引用文件时输入 `@` 搜索，或在启动命令中传入：

```bash
lc @README.md "检查这份安装说明有没有遗漏"
```

### 终端常用动作

| 动作 | 操作 |
|---|---|
| 打开命令列表 | 输入 `/` |
| 选择模型 | `/model` 或 `Ctrl+L` |
| 查看设置 | `/settings` |
| 中止当前运行 | `Esc` |
| 展开 Tool 输出 | `Ctrl+O` |
| 继续最近 Session | `lc -c` |
| 浏览历史 Session | `lc -r` |
| 重新加载资源 | `/reload` |
| 退出 | `/quit` |

## 项目规则

在项目根目录创建 `AGENTS.md`，告诉 LYStar 如何工作：

```markdown
# 项目规则

- 修改代码后运行 npm test。
- 不执行生产数据库迁移。
- 不提交密钥、token 或 .env。
```

修改后执行 `/reload`，或重新启动 LYStar。全局规则放在 `~/.pi/agent/AGENTS.md`。

## Session

Session 自动保存在 `~/.pi/agent/sessions/`：

```bash
lc -c
lc -r
lc --name "修复登录问题"
```

Pi 与 LYStar 可以读取同一数据目录，但不要同时写同一个 Session 文件。

下一步阅读 [WebUI 使用指南](../usage/webui.md)、[终端界面与快捷键](../usage/interactive-tui.md)或[安装 Skill 与 Extension](../ecosystem/overview.md)。
