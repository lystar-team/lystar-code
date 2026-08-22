# LYStar Code GUI 建设方案

> 当前版本：GUI Host、GUI Protocol 和 React 工作台继续维护；本文件只记录仍有效的 GUI 责任边界。

## 1. 产品边界

LYStar Code GUI 是基于 React、GUI Protocol、GUI Host 和 Tauri 的编码工作台。它复用 Pi/LYStar 的 Agent Runtime、Provider、Session、Tool、Skill、Extension、Package、MCP、配置目录和 Session JSONL，不复制业务存储，也不建立第二套会话协议。

当前责任分工：

- React GUI 负责项目、会话、Transcript、模型、设置、资源、认证和连接状态展示。
- GUI Protocol 负责严格的 Client/Host 消息 schema、framing、请求响应、事件和版本协商。
- GUI Host 负责 Runtime 生命周期、Session lease、operation journal、Transcript 分页、内容引用、项目资源和通用 `ui_request`。
- Tauri 负责窗口、桌面状态、本机 Host、远端 Host 载荷、系统集成和更新入口。
- Coding Agent Core 继续负责 Agent、Session、Provider、Tool、Extension 和持久化语义。

## 2. 共享契约

必须保持以下兼容性：

- `~/.pi/agent`、项目 `.pi`、Session JSONL 和既有 Session entry 语义。
- `PI_*` 环境变量、CLI 参数、退出码、Provider/Model ID、Tool 名和 Extension API。
- GUI Protocol 的版本协商、严格 JsonValue、Session lease、operation journal 和 `ui_request`/`ui_response`。
- Transcript 的 generation、revision、cursor、分页、搜索和 content reference 规则。
- GUI 与 Host 断线重连后，旧 Session、operation 和 pending UI 请求不能被伪造提交。

GUI 不直接读取 Session JSONL，也不按自己的算法重算 Token、费用、分支或模型状态。需要的状态必须由 Core 或 Host 通过结构化结果提供。

## 3. 已保留能力

当前 GUI 继续依赖并维护：

- Session 创建、获取、释放、切换、恢复、删除、分支、导入、导出和共享。
- Transcript 尾页、分页、搜索、分支过滤、流式进度、Tool/Diff 摘要和内容引用。
- Prompt、steer、follow-up、clear queue、abort、compact、reload 和 operation 状态。
- Provider 模型目录、登录、退出、设置、项目可信状态、Skill、Package 和项目/本机指令。
- 标准 Extension UI RPC：`select`、`confirm`、`input`、`editor`、`notify` 等请求仍通过通用 `ui_request`/`ui_response` 处理。
- Git Inspector、项目图片、剪贴板、富文本渲染、远端 Host、SSH relay 和 Tauri 桌面状态。

终端专用的原始输入、连续组件帧、编辑器镜像、组件自定义结果和专用终端事件不属于 GUI 公共协议，已从 Host 和 schema 中移除。

## 4. 当前重点

1. 继续降低大 Session 的活动 Runtime 和 WebView 内存峰值，保持 JSONL 为唯一持久事实源。
2. 完善断线重连、远端 Host、Session lease 和 operation journal 的 exactly-once 测试。
3. 维护 Transcript 分页、搜索、内容引用和流式投影的一致性，避免重复或丢失记录。
4. 让项目切换、资源写入、项目可信状态和桌面恢复保持两阶段提交，不破坏旧工作区。
5. 继续补齐真实浏览器、Tauri、本机 Host、SSH 和五平台发行验证；没有实机证据时只报告构建和静态检查结果。
6. 更新公开 schema、安装器和 Release manifest 时，先改事实源，再运行生成和一致性检查。

## 5. 开发规则

- 共享行为优先修在 Core、Protocol 或 Host 的真实责任位置。
- GUI 只消费结构化能力，不把业务规则复制到 React store。
- 新增公共命令必须同步 schema、Host 转发、GUI client、测试和生成文件。
- 外部输入、文件、网络、远端连接和客户端请求必须经过边界校验。
- 保持 Host 单进程 Session writer lock；GUI 与 CLI 不同时写同一个 Session 文件。
- 不把历史测试、截图或旧发布包当作当前实现证据。

## 6. 验证入口

局部修改按责任范围运行：

```bash
npm --workspace @lystar/code-gui-protocol test
npm --workspace @lystar/code-gui-host test:required
npm --workspace @lystar/code-gui test
npm run check:schema
npm run check
npm run build:offline
```

可见 GUI 修改还要运行浏览器 smoke；Tauri 或本机 Host 修改还要在对应平台执行实际启动、窗口关闭、资源清理和断线恢复检查。发行包需额外验证版本、SHA、manifest、安装器和当前平台启动，不把单一平台结果扩展成跨平台结论。

## 7. 相关文件

- `packages/gui-protocol/src/schemas.ts`
- `packages/gui-host/src/runtime-adapter.ts`
- `packages/gui-host/src/service.ts`
- `packages/gui-host/src/transcript-reader.ts`
- `packages/gui-host/src/transcript-projection.ts`
- `packages/gui/src/store.ts`
- `packages/gui/src-tauri/`
- `scripts/build-binaries.sh`
- `scripts/generate-release-metadata.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
