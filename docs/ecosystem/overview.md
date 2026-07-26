# Skill、Extension 与 Package

[返回文档首页](../README.md)

LYStar 继承 Pi 的资源系统，没有单独的插件商店或 manifest。

| 类型 | 用途 | 风险 | 推荐入口 |
|---|---|---|---|
| Skill | 给 Agent 增加工作方法、脚本和参考资料 | 可能引导 Agent 执行命令 | Pi Package 或 `skills/` 目录 |
| Extension | 注册 Tool、命令、事件、Provider 和 TUI | 直接以当前用户权限执行代码 | 经过审查的 Pi Package |
| Pi Package | 打包 Skill、Extension、Prompt 和 Theme | 取决于包内资源 | `la install <source>` |
| MCP | 连接外部工具与服务 | 取决于对应进程和 Extension | 已验证的 MCP Extension |

## 选择安装方式

资源已经发布为 Pi Package：

```bash
la install npm:<package>
la install git:github.com/<owner>/<repo>@<tag-or-commit>
```

纯 Skill 仓库没有 Pi Package manifest 时，放入 Skill 发现目录：

```bash
git clone <repo> ~/.pi/agent/skills/<name>
```

自己开发单文件 Extension 时，先临时加载：

```bash
la -e ./my-extension.ts
```

## 依赖判断

- `npm:` Package 需要 Node.js/npm，或 `settings.json` 中可用的 `npmCommand`。
- `git:` Package 需要 Git。
- git 仓库根目录存在 `package.json` 时，LYStar 会调用 npm 安装依赖。
- 不含第三方依赖的单文件 Extension 可由 LYStar 直接加载，无需单独编译。
- 某个 Skill 可能依赖 Node.js、Python、浏览器或 API Key，以该 Skill 文档为准。

安装 LYStar 本体无需 Node.js，这与生态资源的依赖是两件事。

## 安全

Extension 拥有当前用户权限，可以读写文件、访问网络和执行进程。Skill 会进入 Agent 上下文，也可能带可执行脚本。安装前至少检查：

1. 仓库所有者和许可证。
2. 锁定的 tag 或 commit。
3. `package.json` scripts 和依赖。
4. Extension 注册的 Tool、事件和 Shell 调用。
5. Skill 要求访问的凭据、文件和外部服务。

项目级资源只在项目信任后加载。不要信任来源不明的项目目录。

## 管理

```bash
la list
la config
la update --extensions
la remove <source>
```

- [Pi Package 教程](packages.md)
- [Skill 教程](skills.md)
- [Extension 教程](extensions.md)
- [已验证资源](verified-resources.md)
