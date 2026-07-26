# 开发环境

[返回文档首页](../README.md)

普通用户安装独立发行包无需 Node.js。本页只面向源码贡献者和发行维护者。

## 工具

```text
Node.js >= 22.19.0
npm
Bun 1.3.9
Bash
Git
ripgrep
fd
```

Windows 建议使用 Git for Windows 提供 Bash。发行脚本固定 Bun `1.3.9`，不要使用浮动版本替代发行验证。

## 获取源码

```bash
git clone https://github.com/octyean/lystar-agent.git
cd lystar-agent
npm ci --ignore-scripts
```

`--ignore-scripts` 避免依赖安装时执行未审查的 lifecycle script。

## 构建

```bash
npm run build:offline
node packages/coding-agent/dist/cli.js --version
node packages/coding-agent/dist/cli.js --help
```

离线模型数据位于 `packages/ai/src/providers/data/`，是干净 checkout 构建的一部分，不要删除或手工编辑生成文件。

## 本地运行

```bash
PI_OFFLINE=1 node packages/coding-agent/dist/cli.js --approve
```

需要独立临时配置时：

```bash
PI_CODING_AGENT_DIR=/tmp/lystar-dev-agent \
PI_OFFLINE=1 \
node packages/coding-agent/dist/cli.js --approve
```

这样不会改动真实 `~/.pi/agent`。

## 代码边界

- Provider、Session、Tool、Extension、Skill、Package 和基础 TUI 尽量跟随 Pi。
- 产品常量、中文 locale、LYStar workspace、安装器、更新器和 Release workflow 由 LYStar 维护。
- 用户命令固定为 `la`，配置目录继续使用 `.pi`，环境变量继续使用 `PI_*`。
- 不创建第二套 Session、Package、Skill 或 MCP 协议。
- 直接外部依赖固定精确版本，新增发行依赖时检查许可证。

## 修改前

```bash
git status --short --branch
node -p 'require("./packages/coding-agent/package.json").piConfig'
```

工作区可能有其他改动，只修改当前任务文件，不清理、不回退无关内容。完成后按[测试与验证](verification.md)执行对应 gate。
