# WebUI 使用指南

[返回文档首页](../README.md)

WebUI 是 LYStar Code 的浏览器工作台。你可以在其中管理项目和会话、向 Agent 发送任务、查看文件与 Git 变更，以及配置模型、Skill 和智能体。

## 启动与连接

完成[安装](../getting-started/installation.md)后，在终端执行：

```bash
lc web
```

首次运行会依次询问：

| 配置 | 用途 | 默认值或要求 |
| --- | --- | --- |
| 白名单 IP 地址 | 允许访问的地址；多个地址用英文逗号分隔 | `*` 表示不限制访问来源 |
| Web 监听端口 | 浏览器连接工作台的端口 | `1420` |
| Runtime 监听端口 | Web 服务连接任务运行进程的端口 | `1422`，与 Web 端口不同 |
| 连接密码 | 进入 WebUI 时使用 | 8–256 个字符 |

启动完成后，终端会输出访问地址和日志目录。在本机浏览器打开 `http://127.0.0.1:1420`，输入连接密码进入工作台。自定义端口时使用终端输出的地址。

Web 连接配置保存在 `~/.pi/agent/web-config.json`。进入工作台后，可在“设置 → 安全与访问”调整白名单、端口和连接密码。

## 配置模型并添加项目

1. 点击左侧“模型与认证”。使用 API Key 时，配置相应供应商；自定义供应商可填写 Base URL、API 类型和 API Key，再添加或同步模型。
2. 使用订阅登录时，在终端运行 `lc`，执行 `/login`。WebUI 与终端使用同一 LYStar 用户配置目录。模型服务的登录方式见 [Provider 与 API Key](../getting-started/providers.md)。
3. 点击“添加项目”，选择运行 LYStar 的电脑上的项目目录。
4. 在项目下新建对话，选择模型，输入任务后发送。输入区还可引用文件、选择 Skill 和上传附件。

第一次可以让 Agent 只读项目：

```text
阅读这个项目，说明目录结构、启动方式和测试入口。先不要修改文件。
```

## 工作台里有哪些入口

| 入口 | 可以做什么 |
| --- | --- |
| 会话 | 按项目和项目组管理对话，搜索会话，查看进行中的任务和结果，继续历史会话 |
| 审阅工作区 → 文件 | 浏览和搜索项目文件，打开文件预览，上传文件到项目 |
| 审阅工作区 → Git | 查看变更、Diff 和提交历史，暂存与提交改动，获取、拉取或推送代码 |
| 审阅工作区 → 运行 / 分支 | 查看运行记录和会话分支 |
| 智能体协作 | 创建协作空间，查看成员与消息，用任务看板安排工作 |
| 技能 / 智能体 | 管理当前项目的 Skill，配置个人或项目智能体的模型、工具和技能 |
| 模型与认证 | 管理模型供应商、认证和模型选项 |
| 设置 | 调整外观、全局提示词、访问配置，查看诊断和版本信息 |

## 从手机或另一台电脑访问

在另一台设备的浏览器中打开 `http://<运行 LYStar 的电脑 IP>:1420`，使用同一个连接密码登录。自定义端口时替换 `1420`。

两台设备需要网络互通；浏览器使用的访问地址须在白名单内，运行 LYStar 的电脑也需要允许连接 Web 端口。白名单和访问地址可在“设置 → 安全与访问”查看或修改。

项目目录、文件操作和命令执行都位于运行 LYStar 的电脑上。关闭浏览器后，可再次连接工作台查看会话。

## 后台与前台运行

`lc web` 默认启动后台服务，后续直接访问浏览器地址即可。需要在当前终端观察服务输出时，使用：

```bash
lc web --foreground
```

后台服务命令如下：

| 操作 | 命令 |
| --- | --- |
| 安装服务 | `lc web service install` |
| 启动 | `lc web service start` |
| 停止 | `lc web service stop` |
| 重启 | `lc web service restart` |
| 查看状态 | `lc web service status` |
| 重新对齐服务配置与运行状态 | `lc web service reconcile` |
| 卸载服务 | `lc web service uninstall` |

macOS 首次安装 Web 服务时，终端会引导完成管理员授权，以及钥匙串、辅助功能、自动化和屏幕录制等系统授权。检查状态或补做授权：

```bash
lc web permissions status
lc web permissions setup
```

详见[安装说明](../getting-started/installation.md)与[更新说明](update-rollback-uninstall.md)。

### 分别管理 Gateway 与 Runtime

Gateway 负责浏览器连接，Runtime 负责会话与任务运行。排查连接或任务执行问题时，可分别查看状态和控制进程：

```bash
lc web gateway status
lc web gateway start
lc web gateway stop
lc web gateway restart

lc web runtime status
lc web runtime start
lc web runtime stop
lc web runtime restart
```

`stop` 和 `restart` 支持 `--force`。强制操作可能中断正在运行的任务。只需停止某一个会话中的任务时，使用准确的会话 ID：

```bash
lc session stop <sessionId>
```

## 更新与排查

```bash
lc update
lc web service status
```

需要回退时执行 `lc update --rollback`。更新后的 Web 服务状态异常，可执行 `lc web service reconcile`，再查看状态。完整流程见[更新、回退与卸载](update-rollback-uninstall.md)。

| 问题 | 检查方式 |
| --- | --- |
| 忘记访问端口，或浏览器无法打开 | 查看 `lc web service status` 和启动输出，核对访问地址、白名单与端口 |
| 浏览器提示需要密码 | 输入首次执行 `lc web` 时设置的连接密码 |
| 可以进入页面，但模型不可用 | 在“模型与认证”检查供应商和认证配置；订阅登录使用终端 `/login` |
| 页面能打开，任务无法运行 | 查看 `lc web runtime status`，在“设置 → 诊断”查看连接状态 |
| macOS 后台任务提示缺少系统权限 | 在本机终端运行 `lc web permissions setup` |

更多信息见[安装与启动故障排查](../troubleshooting/installation.md)、[网络问题](../troubleshooting/network.md)。
