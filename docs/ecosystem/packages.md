# Pi Package

[返回文档首页](../README.md)

Pi Package 可以同时携带 Extension、Skill、Prompt Template 和 Theme。LYStar 继续使用 `lc install` 和 Pi 的 Package 格式。

> Package 中的 Extension 可以执行任意代码。先阅读源码、依赖和安装脚本，再安装第三方 Package。

## 安装

npm：

```bash
lc install npm:@scope/package@1.2.3
```

Git：

```bash
lc install git:github.com/owner/repo@v1.2.3
lc install git:github.com/owner/repo@<commit>
```

本地目录：

```bash
lc install /absolute/path/to/package
lc install ./relative/path/to/package
```

默认写入用户设置 `~/.pi/agent/settings.json`。项目级安装增加 `-l`：

```bash
lc install -l ./tools/project-package
```

项目级 Package 写入 `.pi/settings.json`，需要信任项目。团队提交项目设置前应锁定版本，并确保新成员能访问来源。

## 依赖

`npm:` 来源会运行 npm。没有 Node.js/npm 时会失败。

Git 来源会运行 `git clone`。仓库根目录存在 `package.json` 时还会执行 npm 依赖安装。中国大陆 registry 和 Git 网络配置见[中国大陆网络配置](../getting-started/mainland-china.md)。

需要替换 npm 命令时：

```json
{
  "npmCommand": ["mise", "exec", "node@22", "--", "npm"]
}
```

## 查看和启停

```bash
lc list
lc config
```

`lc config` 可以启用或禁用已安装 Package 中的 Extension、Skill、Prompt 和 Theme。按 `Tab` 切换全局与项目设置。

## 更新

```bash
lc update --extensions
lc update npm:@scope/package
lc update --extension git:github.com/owner/repo
```

带精确 npm 版本的 Package 会保持固定版本。带 tag 或 commit 的 Git Package 只会回到指定 ref，不会自动移动到新 tag。升级固定 ref 时重新安装新来源：

```bash
lc install git:github.com/owner/repo@v1.3.0
```

## 删除

```bash
lc remove npm:@scope/package
lc remove git:github.com/owner/repo
lc remove -l ./tools/project-package
```

删除 Package 设置和受管安装目录，不保证删除 Package 自己写入的缓存、凭据或外部程序。残留位置以该 Package 文档为准。

## 临时试用

```bash
lc -e npm:@scope/package
lc -e git:github.com/owner/repo@<commit>
```

临时来源只用于当前运行，适合先检查 UI 和命令。高风险 Extension 仍应在容器、虚拟机或无敏感数据的用户环境中验证。

## Package 作者

最小 `package.json`：

```json
{
  "name": "my-lystar-package",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

运行时依赖放入 `dependencies`。Pi 公共包放入 `peerDependencies`，不要把另一份 Pi Runtime 打进 Package。

完整来源解析、过滤、依赖和 manifest 规则见 [Pi Packages](../../packages/coding-agent/docs/packages.md)。
