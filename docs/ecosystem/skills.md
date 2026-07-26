# Skill

[返回文档首页](../README.md)

Skill 是按需加载的能力说明，可以携带脚本、参考资料和资源。LYStar 支持 Agent Skills 规范，并继续使用 Pi 的发现目录。

> Skill 会进入 Agent 上下文，也可能要求执行脚本或访问外部服务。安装前阅读 `SKILL.md` 和脚本。

## 安装已打包 Skill

```bash
la install npm:<package>
la install git:github.com/<owner>/<repo>@<tag-or-commit>
la config
```

用 `la config` 确认 Package 中需要的 Skill 已启用。

## 安装纯 Skill 仓库

全局安装，对所有项目可见：

```bash
mkdir -p ~/.pi/agent/skills
git clone https://github.com/badlogic/pi-skills ~/.pi/agent/skills/pi-skills
```

项目安装，只对当前项目可见：

```bash
mkdir -p .pi/skills
git clone https://github.com/badlogic/pi-skills .pi/skills/pi-skills
```

项目目录需要信任后才会加载。安装后启动 LYStar 或执行 `/reload`。

`badlogic/pi-skills` 中不同 Skill 有各自依赖：部分需要 Node.js，部分需要浏览器、外部 CLI 或 API Key。只使用某个 Skill 前先阅读对应 `SKILL.md`。

更新：

```bash
git -C ~/.pi/agent/skills/pi-skills pull --ff-only
```

删除：

```bash
rm -rf ~/.pi/agent/skills/pi-skills
```

删除前确认路径，项目级安装则删除对应 `.pi/skills/` 子目录。

## Skill 目录

```text
my-skill/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

最小 `SKILL.md`：

```markdown
---
name: my-skill
description: 说明这个 Skill 做什么，以及什么任务应该使用它。
---

# My Skill

## 使用

写清输入、步骤、输出和失败处理。
```

规则：

- `name` 使用小写字母、数字和连字符，长度不超过 64。
- `description` 具体写触发场景，缺失时 Skill 不会加载。
- 相对路径以 Skill 目录为基准。
- 脚本写清运行环境和依赖。
- 不在 Skill 中保存真实 Key、cookie 或用户数据。

## 在 Prompt 中引用

在输入框中键入 `$` 会只显示 Skill；键入 `@` 会同时显示 Skill 和文件，Skill 候选带有 `[Skill]` 标记。输入名称或描述片段后选择候选即可，不用手动补方括号：

```text
$shuo   -> $[shuorenhua]
@ui     -> @[ui-design]
```

同一条 Prompt 可以引用多个 Skill，也可以继续夹带文件引用：

```text
请结合 @[ui-design] 和 $[shuorenhua] 检查 @src/App.vue
```

提交时按引用出现顺序加载全部 Skill，重复引用只加载一次。普通 `$PATH`、`${HOME}` 和金额不会被当成 Skill。

## 验证

执行 `/reload` 后，可输入 `$` 或 `@` 查看候选，也可以继续使用原有命令：

```text
/skill:my-skill
```

也可以直接提出匹配 `description` 的任务，观察 Agent 是否读取该 Skill。若没有加载，检查启动日志中的 Skill warning、目录层级和 frontmatter。

## 发现位置

```text
~/.pi/agent/skills/
~/.agents/skills/
.pi/skills/
.agents/skills/
```

还可以通过 `settings.json` 的 `skills` 数组或 `--skill <path>` 加载。完整规范和发现优先级见 [Pi Skills](../../packages/coding-agent/docs/skills.md)。
