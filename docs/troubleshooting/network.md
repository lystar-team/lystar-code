# 网络问题

[返回文档首页](../README.md)

先确认失败链路：安装应用、安装 Package、克隆 Git 仓库，还是调用模型。

## GitHub Release

```bash
curl -I https://github.com/octyean/lystar-agent/releases/latest
```

能打开仓库但资产下载超时，设置当前终端代理后重试。完整命令见[中国大陆网络配置](../getting-started/mainland-china.md)。

## npm Package

确认 npm 存在：

```bash
node --version
npm --version
npm config get registry
```

测试 registry：

```bash
npm view @tintinweb/pi-tasks version
```

中国大陆可以临时使用：

```bash
npm_config_registry=https://registry.npmmirror.com la install npm:<package>
```

出现证书错误时不要设置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。检查系统时间、企业代理证书和 npm CA 配置。

## Git Package

```bash
git ls-remote https://github.com/<owner>/<repo>.git HEAD
```

失败时先解决 Git 自身访问，再运行 `la install git:...`。SSH 来源还要检查 SSH Key 和 `~/.ssh/config`。

## Provider

- `/login` 失败：确认浏览器回调、账户区域和系统时间。
- API Key 无效：确认 Provider、Key 环境变量和账户余额。
- 模型不存在：运行 `la --list-models <keyword>`，不要依赖旧文档中的模型 ID。
- 请求超时：确认 Provider 官方端点在当前网络可达，再考虑 `httpProxy`。

查看当前代理环境：

```bash
env | grep -i proxy
```

Windows PowerShell：

```powershell
Get-ChildItem Env: | Where-Object Name -Match 'PROXY'
```

## 离线确认

怀疑启动阶段网络请求时：

```bash
PI_OFFLINE=1 la
```

离线模式能启动说明本地程序和配置基本可读，剩余问题在远程更新、模型目录、Package 或 Provider 链路。离线模式不能让需要网络的模型正常回复。
