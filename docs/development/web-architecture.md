# LYStar Code Web 编写规范

本文用于 Web 日常开发、组件拆分和行为保持型重构。

**适用范围：**

- `packages/web`
- `packages/web-gateway`
- `packages/web-runtime`
- `packages/web-protocol`

TypeScript、格式、依赖和 Git 等通用要求沿用仓库根目录 `AGENTS.md`。本文只规定 Web 的模块职责、业务边界和验证要求。

## 1. 系统结构

```text
浏览器
  │ HTTP / JSON、WebSocket 事件
  ▼
packages/web
  │ 请求、交互和页面状态
  ▼
packages/web-gateway
  │ Web Runtime Protocol
  ▼
packages/web-runtime
  │ RuntimeAdapter
  ▼
packages/coding-agent、packages/ai
```

`packages/web-protocol` 定义 Gateway 与 Runtime 使用的消息、类型和 Schema。Web 前端也使用其中的部分类型。

运行调用沿上图方向传递。底层包不得依赖上层页面或 Gateway 实现。

## 2. 各层职责

| 位置 | 负责 | 不负责 |
| --- | --- | --- |
| `packages/web/src/components` | 页面结构、展示、局部交互 | 直接实现服务端规则或复制 API 请求逻辑 |
| `packages/web/src/state` | 页面共享状态、交互流程、异步请求生命周期 | 保存互不相关的组件临时状态；另造一份服务端业务规则 |
| `packages/web/src/adapters` | HTTP、WebSocket、请求响应映射 | 页面布局和组件样式 |
| `packages/web-gateway/src` | 浏览器 HTTP / WebSocket 入口、请求校验、鉴权、响应投影、Runtime 调用 | 重复实现 Coding Agent 的会话和执行规则 |
| `packages/web-runtime/src` | Web Runtime 消息处理、运行时和会话协调、Runtime 适配 | 页面展示逻辑 |
| `packages/web-protocol/src` | Gateway 与 Runtime 的协议类型、Schema、编解码 | 页面状态或业务流程编排 |

Web 内部按当前目录职责组织：

- `components/workbench`：工作台页面区域和局部组件。
- `components/ui`：基础交互组件。
- `components/ai-elements`：AI 内容展示组件。
- `state`：工作台状态、动作和状态转换。
- `adapters`：Gateway 通信和数据映射。

新增代码放到实际负责它的目录，不因名称相似就放进通用 `lib` 或 `utils`。

## 3. 组件与模块拆分

### 什么时候拆

- 一块界面有独立交互、状态生命周期或清楚的子任务时，可以拆成局部组件。
- React 状态和副作用需要独立管理时，放入对应 Hook；同一业务流程的纯状态转换可放入所属领域模块。
- HTTP / WebSocket 调用及传输数据转换放在适配层，不散落在多个展示组件里。
- 有真实共用行为、共同契约或适配职责时，才抽取公共模块。

### 什么时候不拆

- 不以行数、文件大小或“以后可能复用”为单独理由拆分。
- 不为单一调用点创建不表达业务职责的包装层。
- 不把不同领域的逻辑合并到一个 `common`、`shared` 或全局 Store。
- 不把页面、状态管理、网络请求和业务判断塞进同一个组件。

拆分完成后，每个模块应有明确的职责、输入和输出。模块之间通过明确的类型、Props、Actions 或协议通信，不互相改写内部状态。

## 4. 状态与业务规则

### 状态放置

- 只服务于一个组件、且随组件销毁的状态，放在组件内部。
- 被多个工作台区域共同使用，或需要跨请求、重连和会话切换保留的状态，放在对应的状态 Hook 或状态模块。
- 事件监听、定时器、请求代次、取消和清理逻辑，放在拥有该生命周期的 Hook 或服务中。
- 不把组件临时状态塞入 `WorkbenchState`，也不把跨组件的会话状态复制到多个组件。

### 规则归属

- 每条业务规则只有一个权威实现位置。其他层调用它、校验边界数据或展示结果，不复制同一判断。
- Web 负责用户交互和展示；Gateway 负责浏览器请求边界与数据投影；Runtime 负责 Web 运行时和会话协调；Coding Agent 保留既有 Agent 与 Session 核心行为。
- 遇到错误时，按当前调用契约展示或向上返回；不吞掉错误来伪装成功，也不以默认值掩盖缺失状态。

## 5. 接口与数据契约

以下文件是修改 Web 契约时的主要核对入口：

- 前端请求：`packages/web/src/adapters/host-protocol/api.ts`
- 前端数据类型：`packages/web/src/types.ts`
- Gateway 路由：`packages/web-gateway/src/server.ts`
- Gateway / Runtime 协议：`packages/web-protocol/src/schemas.ts`
- Schema 生成器：`packages/web-protocol/scripts/generate-schema.mjs`

调整请求或响应时，前端调用、Gateway 路由、Runtime 消息和相关测试必须一起核对。保持现有 HTTP 路径、方法、状态码、字段语义和错误行为。

`packages/web-protocol/generated/web-protocol.schema.json` 是生成文件。修改 Schema 后运行 `npm run generate:schema`；不得手工维护生成结果。行为保持型重构不得改变协议版本或生成后的契约内容。

## 6. 必须保持的现有行为

以下行为属于重构保护范围。拆文件、移动函数或调整依赖时，不改变其语义：

- Session 控制权、租约、读写权，以及 Web 与 TUI 的会话协作。
- 操作接受、幂等、进度、完成和恢复行为。
- Transcript 游标、分页、版本信息、投影结果和实时更新。
- WebSocket 订阅、事件顺序、断线重连和状态恢复。
- Room 成员、消息路由、目标选择和能力约束。
- 文件路径边界、公开响应字段和现有鉴权行为。
- Web Runtime Protocol 的消息结构和版本。

需要改变上述行为时，应作为独立需求处理，不与组件拆分或文件整理混在一起。

## 7. 测试与验证

测试应覆盖所属层对外提供的行为：

| 改动位置 | 主要验证内容 |
| --- | --- |
| Web | 组件交互、状态转换、会话切换、流事件和前端 API 映射 |
| Gateway | HTTP 路由、鉴权、响应结构、WebSocket 事件和 Runtime 断连处理 |
| Runtime | 协议命令、租约、操作幂等、Session 生命周期、Transcript 和 Room 行为 |
| Web Protocol | 消息 Schema、编解码、协议边界及生成文件一致性 |

验证要求：

1. 改动前确认相关测试和契约；未覆盖的关键行为先补最小测试。
2. 每次只改一个职责切片；测试验证外部行为，不绑定内部文件布局。
3. 修改代码后运行 `npm run check`，并运行受影响的定向测试。
4. 修改测试文件后运行该测试文件。Vitest 和 Node 测试使用仓库现有入口。
5. 不用一次全量测试代替目标测试，也不把构建通过描述成运行时行为已验证。

## 8. 行为保持型重构步骤

1. **确定范围**：列出目标模块、调用者、业务事实源和受影响测试。
2. **记录基线**：确认当前接口、状态变化和测试结果；保留工作区已有改动。
3. **移动职责**：只做当前切片需要的提取或委派，不顺手改接口、数据格式和业务规则。
4. **对照验证**：运行目标测试和项目检查，比较重构前后的外部行为。
5. **遇到差异就暂停**：若结果显示行为变化，先判断是回归还是新需求；未经确认不把业务修复合入重构。

## 9. 提交前检查

- [ ] 每个模块只有一个清楚的主要职责。
- [ ] 网络请求位于适配层，展示组件没有复制服务端规则。
- [ ] 状态放在与其生命周期和使用范围相符的位置。
- [ ] 没有新增循环依赖、无调用者抽象或重复事实源。
- [ ] API、协议、Session 和实时事件行为保持不变；若改变，已作为独立需求确认。
- [ ] 相关测试和 `npm run check` 已运行，结果与未验证范围记录准确。
