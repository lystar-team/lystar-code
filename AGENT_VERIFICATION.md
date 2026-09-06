# LYStar Code 验证记录

> 更新日期：2026-09-05
>
> 本文件只记录当前 TypeScript TUI、Web Runtime、Web Runtime Protocol 和发行链路的验证。历史原生终端实验记录已移除，不作为当前实现证据。

## 当前事实

- 正式 CLI 入口是 `packages/coding-agent/src/main.ts`，使用 TypeScript Interactive TUI。
- Web 客户端使用 `packages/web-protocol`、`packages/web-runtime`、Transcript 分页、Session lease、operation journal、content reference 和标准 `ui_request`/`ui_response`。
- 发行包只构建 `lc` 与 `lystar`，不包含额外终端前端可执行文件。
- 上游 Pi 基线已同步到 `v0.84.4`，commit `b79e4cc834970cca69daebffab7df1da7d1e52c4`；LYStar 产品版本为 `0.84.4-lystar.1`。

## LYStar / Codex 架构整理定向验证（2026-09-05）

本轮验证 Skill 引用加载、系统提示、Skill 资源、SDK Skill、Subagent 失败状态，以及工具启动器和 Shell 退出码：

```bash
cd packages/coding-agent
npx vitest --run \
  test/skill-reference.test.ts test/system-prompt.test.ts \
  test/skills.test.ts test/resource-loader.test.ts test/sdk-skills.test.ts \
  test/subagent-extension.test.ts test/subagent-run.test.ts test/subagent-session-view.test.ts
npx tsgo -p tsconfig.build.json --noEmit --pretty false
npx biome check \
  src/core/system-prompt.ts src/extensions/skill-reference/index.ts \
  test/skill-reference.test.ts src/extensions/subagent/index.ts \
  test/subagent-extension.test.ts
```

结果：8 个测试文件、112 项通过；Coding Agent 定向 TypeScript 检查和 5 个改动文件的 Biome 检查通过。新增 faux RPC 回归确认并行任务失败时 ToolResult 返回 `isError: true`。使用临时运行时桩确认 `dbx`、`sshx` 会调用对应 Skill 的 `lystar-skill-update auto <skill> --quiet`；更新器成功或失败都不阻断目标脚本，`pipefail` 下失败管道退出码保持为 `1`。

本节未验证真实模型派发、真实企业微信通知、真实数据库/SSH 操作、网络更新、发布、部署、PTY 或跨平台运行。

## 本轮发版前定向验证（2026-09-01）

本轮修复工作区的类型、格式、Agent Tool 冲突、Web companion、全屏工作台、Markdown 和鼠标 Overlay 相关回归，实际运行：

```bash
npx tsgo --noEmit --pretty false
npx biome check --error-on-warnings --files-ignore-unknown=true .
npm run test:scripts
npm --workspace @earendil-works/pi-agent-core exec vitest -- --run test/agent-loop.test.ts test/harness/tools.test.ts --maxWorkers=2 --pool=forks
npm --workspace @earendil-works/pi-coding-agent exec vitest -- --run test/web-companion.test.ts test/interactive-web-companion.test.ts test/apply-patch-extension.test.ts test/assistant-message.test.ts test/edit-tool-no-full-redraw.test.ts test/file-mutation-queue.test.ts test/interactive-tui.test.ts test/lystar-tui.test.ts test/lystar-workspace.test.ts test/subagent-session-view.test.ts test/system-prompt.test.ts test/task-workbench-components.test.ts test/tool-execution-component.test.ts test/tool-recovery.test.ts test/tool-system-prompt-contributions.test.ts --maxWorkers=2 --pool=forks
npm --workspace @earendil-works/pi-coding-agent run build:unbundled
npm --workspace @earendil-works/pi-coding-agent test -- --maxWorkers=2 --reporter=json --outputFile=/tmp/coding-local.json
cd packages/tui && node --test test/markdown.test.ts test/tui-alt-screen.test.ts
node scripts/lcd.mjs --version
```

结果：TypeScript 检查、Biome 检查、脚本测试（33 项）、Agent 定向测试（2 个文件、71 项）、Coding Agent 定向测试（15 个文件、234 项）、Coding Agent unbundled build、Coding Agent 完整测试（263 个文件、2323 项，其中 2322 项通过、1 项按平台跳过）、TUI 定向测试（138 项）和源码快捷入口版本检查均通过，返回 `0.84.4-lystar.1`。本节未替代完整 CI、离线构建、PTY、多平台实机和发行包安装验证。

## Pi v0.84.4 合并验证（2026-08-31）

本轮在当前工作区完成：

```bash
npm ci --ignore-scripts
npm run check
npm run build:offline
npm exec -- vitest --run --maxWorkers=1 \
  packages/agent/test/harness/nodejs-env.test.ts \
  packages/coding-agent/test/config.test.ts \
  packages/coding-agent/test/model-resolver.test.ts \
  packages/coding-agent/test/suite/agent-session-model-extension.test.ts \
  packages/coding-agent/test/interactive-tui.test.ts \
  packages/coding-agent/test/session-id-readonly.test.ts \
  packages/ai/test/model-catalog-types.test.ts \
  packages/ai/test/xai-responses.test.ts \
  packages/ai/test/zai-coding-plan-models.test.ts
cd packages/tui && node --test test/tui-render.test.ts
```

结果：静态检查、离线构建、定向 Vitest（9 个文件、149 项）和 TUI 渲染测试（29 项）通过。未在本轮验证真实 Provider、PTY、多平台实机、Tauri 和发行包安装运行。


## Tool Recovery 验证

当前恢复经验链路包含 candidate 自动验证、显式 active 批准、Session ledger 重放、账本游标幂等、history checkpoint 归档，以及代码侧注册的 `safe_refresh` handler。当前实际运行的定向验证为：

```bash
cd packages/coding-agent
npx vitest --run test/tool-recovery.test.ts test/lessons-store.test.ts \
  test/file-mutation-queue.test.ts test/apply-patch-extension.test.ts \
  --maxWorkers=2 --pool=forks
# 4 个测试文件，78 项通过

cd ../agent
npx vitest --run test/agent-loop.test.ts --maxWorkers=2 --pool=forks
# 1 个测试文件，41 项通过
```

本轮只增加三个有明确契约价值的运行链路 E2E：`custom safe_refresh` handler、真实 `apply_patch` 重建，以及由独立 Node 进程执行两次的 Session ledger reconcile 幂等。它们分别覆盖自定义 handler 的 active 门槛、补丁失败到重建成功的关联、以及进程重启后的补偿重放；未扩展为全 Tool、全 Provider 或全 Session 的 E2E 矩阵。

已通过 `npx tsgo -p packages/coding-agent/tsconfig.build.json --pretty false`、根目录 `tsgo --noEmit`、`npm run check --silent` 和 `git diff --check --no-ext-diff`。跨进程真实进程重启、真实 Provider、Windows、macOS、Tauri 和发行包实机运行仍未在本轮验证。

## 验证入口

依赖安装：

```bash
npm ci --ignore-scripts
```

局部测试：

```bash
npm --workspace @lystar/code-web-protocol test
npm --workspace @lystar/code-web-runtime run test:required
npm --workspace @lystar/code-web-runtime test
npm --workspace @earendil-works/pi-coding-agent test -- test/doctor-command.test.ts
```

静态检查与构建：

```bash
npm run check:schema
npm run check
npm run build:offline
npm run test:scripts
```

发行链路：

```bash
bash scripts/test-install-sh.sh
bash scripts/build-binaries.sh --skip-install --skip-build --offline-model-data
```

## Web/Gateway 首轮垂直闭环验证（2026-09-03）

本轮新增本地 fake OpenAI Responses SSE 集成测试，并修正 WebSocket `operation_updated` 投影按 Session ID 查找的问题。实际运行：

```bash
npm run build --workspace=@lystar/code-web-runtime
npm run build --workspace=@lystar/code-web
npm run build --workspace=@lystar/code-web-gateway
./node_modules/.bin/tsgo --ignoreConfig --noEmit --pretty false \
  --noErrorTruncation --target ES2022 --module Node16 \
  --moduleResolution Node16 --strict --skipLibCheck \
  --allowImportingTsExtensions --types node \
  packages/web-gateway/test/vertical-loop.test.ts
node --import tsx --test --test-reporter=spec \
  --test-name-pattern='Web Gateway fake Provider' \
  packages/web-gateway/test/vertical-loop.test.ts
```

结果：Host、Web 和 Gateway 构建通过；集成测试 1 项通过。测试使用临时 Agent 目录和本地 fake Provider，实际覆盖项目添加、Session 创建、`select` 类型 Project Trust 响应、Prompt `202 Accepted`、Provider Responses SSE、WebSocket `session_progress`、`transcript_committed`、带 Session ID 的 `operation_updated`、Transcript API 和 Session JSONL 持久化；公开响应未包含 Session 路径、CWD、Operation 路径或客户端内部字段。

浏览器验收继续使用 `http://127.0.0.1:14320/`：Token 登录、项目目录选择、Session 创建、Project Trust、文件查看、Settings、移动端项目抽屉均已通过；axe 结果为 `passes: 27`、`violations: 0`、`incomplete: 0`。真实 Provider 仍返回 `403 unsupported_country_region_territory`，因此真实模型回复、Tool 执行和认证流程未验证。根目录完整 check/build、多浏览器 Lease 冲突、Gateway/Host 重启恢复、跨平台和反向代理仍未验证。

## Web Gateway 稳定性与减载优化验证（2026-09-05）

本轮完成 Gateway、Web Runtime 和 Web 工作台的本地优化闭环：保留单一 Host RuntimeSession，通过租约共享读写；会话发现改为 metadata-only 并做并发去重；Host/Gateway 写入、重连、心跳、租约恢复和上下文清理均有边界；Bootstrap、项目会话列表和前端初始化请求做缓存或 in-flight 去重；进度事件按 50 ms 合并并限制队列；Web Transcript 对外移除原始 `payload`，保留 `view` 投影。

实际运行：

```bash
(cd packages/web-gateway && node --import tsx --test --test-reporter=spec --test-timeout=90000 \
  test/config.test.ts test/project-registry.test.ts test/server-resilience.test.ts \
  test/vertical-loop.test.ts test/resilience-loop.test.ts)

npm --workspace @lystar/code-web-protocol test -- --reporter=dot
(cd packages/web-runtime && ../../node_modules/.bin/vitest --run \
  test/ipc-process.test.ts test/lease-manager.test.ts test/service-observation.test.ts \
  --maxWorkers=1 --pool=forks --reporter=dot)
(cd packages/coding-agent && ../../node_modules/.bin/vitest --run \
  test/session-info-modified-timestamp.test.ts test/session-list-dedup.test.ts \
  --maxWorkers=1 --reporter=dot)
npm --workspace @lystar/code-web-protocol run build
npm --workspace @lystar/code-web-runtime run build
npm --workspace @lystar/code-web-gateway run build
(cd packages/web && npm run check -- --pretty false)
git diff --check
```

结果：Web Gateway 全套 9 项通过；Web Runtime Protocol 26 项通过；Web Runtime IPC/租约/观察定向测试 3 个文件、6 项通过；Session 去重定向测试 4 项通过；Runtime、Gateway 和 Web 构建及 Web TypeScript 检查通过。新增可信 Runtime IPC 解码回归，确认默认 ServerMessageDecoder 仍做完整校验，可信解码器只做 envelope 校验；可信 transcript 请求只校验 generation/revision 元数据，不再对整页执行 TypeBox 深校验。公开 Session 列表的 `firstMessage` 限制为 512 个字符，保留标题用途并降低 Bootstrap/项目列表传输和前端渲染量。Resilience loop 覆盖两个 Web Client 同时观察同一 RuntimeSession、租约串行写入、实时进度与 Transcript 共享，以及 `manageRuntime=1` 时 Runtime 断开后的自动重启、重连和 Bootstrap 恢复。服务端回归覆盖进度增量合并、非进度事件顺序、无浏览器连接时丢弃高频事件、WebSocket 心跳终止和公开 Transcript 不含 `payload`。

本轮重建并重启了共享 Web Runtime（PID `2020855`）和 Web Gateway（PID `2023143`），健康检查 `1420`、`1422` 均返回 `{"ok":true,"gateway":"ok","host":"connected"}`。Gateway Node inspector 采样 10 秒、并发读取 Transcript 期间得到 8924 个样本，其中 8738 个为空闲，TypeBox 检查仅出现少量调用，先前占主导的完整 `parseServerMessage` 校验路径不再出现。通过 `http://127.0.0.1:1420/` 完成真实浏览器 Prompt smoke：Session 控制返回 `200`，Prompt 返回 `202`，页面收到 `WEB_GATEWAY_SMOKE_20260905` 的流式回复并继续可交互；重新打开页面后未产生新的模块加载错误。最新 Bootstrap 为 264203 字节，330 个会话的公开 `firstMessage` 最大长度为 512。

当前工作区完整 `npm run check` 仍会被其他 Web UI 文件已有改动触发的 Biome 格式/导入检查阻断；本轮涉及的 Gateway、Runtime、Session 和 Web 工作台文件已单独通过定向检查。Web Runtime 完整 `test:required` 的 112 项中有 111 项通过，唯一失败是现有 Skill 引用 RPC/Runtime 隔离契约不一致，不属于本轮 Gateway 回归。没有清理、回退或提交其他工作区改动。

本节没有替代真实 Provider、真实用户 Web/TUI 同时输入、PTY、多平台实机、反向代理和 `PI_WEB_MANAGE_RUNTIME=0` 下的自动 Runtime 重启验证；真实机器链路由用户执行。

## 会话冷读、异步接管与加载解耦补充（2026-09-05）

在上一节网关减载基础上，本轮继续修复了会话读取链路中剩余的两个真实阻塞点：冷读时对完整 JSONL 做内容哈希，以及 Host 在取得会话控制权时同步加载整个历史文件。

实现内容：

- `packages/web-runtime/src/transcript-reader.ts` 将游标版本提升为 `3`，把 generation 指纹改为文件头部与尾部各最多 64 KiB 的有界指纹；追加内容只校验旧尾部，游标不再为了确认旧文件而扫描数百 MB。对“只追加未完成 JSONL 尾巴”的情况保留 generation 和游标有效性。
- Web Runtime Protocol 的 `list_sessions` 增加可选 `metadataOnly`；Web Gateway 的 Bootstrap 和项目会话列表明确走 metadata-only，Host/TUI 默认行为保持兼容。新增 Host 回归确认 metadata-only 不返回完整消息文本。
- `SessionManager.openAsync()` 改为取得写锁后使用异步分块加载，避免 Host 事件循环被大文件同步解析长时间卡住；`CodingAgentRuntimeAdapter.openSession()` 使用该异步入口。同步 `SessionManager.open()` 和正常 Session 写入语义未改。
- Web 工作台选择会话时先启动 Transcript 请求，再等待控制权；即使摘要标记为 `controlled_elsewhere`/`locked_externally`，也会先请求 control，让 Host 尝试已有 Runtime 或 WebCompanion，只有控制失败时才回退只读；会话选择尚未完成时抑制重复 Transcript 刷新。

定向验证：

```bash
npx biome format packages/web-runtime/src/transcript-reader.ts
npx biome format packages/coding-agent/src/core/session-manager.ts
npm --workspace @earendil-works/pi-coding-agent exec vitest -- run test/session-manager/file-operations.test.ts --maxWorkers=1 --reporter=verbose --no-file-parallelism
npm --workspace @lystar/code-web-runtime exec vitest -- run test/service-observation.test.ts --maxWorkers=1 --reporter=dot --no-file-parallelism
npm --workspace @earendil-works/pi-coding-agent run build
npm --workspace @lystar/code-web-runtime run build
npm --workspace @lystar/code-web run build
cd packages/web && npm run check -- --pretty false
```

结果：Session 文件操作测试 30 项通过，Host 观察/metadata-only 测试 3 项通过；Coding Agent、Web Runtime 和 Web 构建通过，Web TypeScript 检查通过。`runtime-adapter.ts` 的 Biome 全文件检查仍会显示本轮之前已存在的 import/格式差异；本轮改动的调用点已通过构建，未顺手改动无关格式。

实时证据：

- 有界 `TranscriptReader` 冷读：981 MB 文件约 20 ms，294 MB 文件约 14 ms；同一 Reader 二次读取约 4–8 ms。这里的计时只覆盖历史首屏读取，不代表完整 Runtime 初始化时间。
- 重建并重启共享 Host/Gateway 后，`1420`、`1422` 健康检查均返回 `{"ok":true,"gateway":"ok","host":"connected"}`；当前进程为 Web Runtime PID `2777461`、Web Gateway PID `2778359`。
- 最新 Bootstrap 约 0.569 s、263373 bytes；项目会话列表约 0.007 s、232944 bytes。
- 对 294 MB 会话发起控制权接管时，控制请求约 9.791 s；同时发起的 Transcript 请求约 0.101 s、238949 bytes，证明大文件 Runtime 初始化不再阻塞只读历史响应。控制请求成功后已释放租约。
- Host Node Inspector 10 秒采样得到 8977 个样本，其中 8377 个为空闲；未出现旧的整文件同步解析热点，残余非空闲样本主要是正常租约/文件状态检查。热身后现场进程观测约为 Host 16%、Gateway 2%，仍受当前活动会话影响。
- 真实浏览器重新打开 `http://127.0.0.1:1420/` 后无新的页面错误；选中已知外部控制会话时可以读取 Transcript，输入框保持只读，未再为该选择发起控制 POST。

本节仍未替代真实用户同时在 TUI/Web 输入、网络中断恢复、PTY、反向代理、跨平台和真实 Provider 验证；`PI_WEB_MANAGE_RUNTIME=0` 下的自动 Runtime 重启也只保留已有的自动化 `manageRuntime=1` 证据。

## Web 会话共享控制权修复补充（2026-09-05）

本轮确认输入框显示“当前会话不可写”的直接原因：Web 工作台把 Session 摘要中的 `locked_externally` 和 `controlled_elsewhere` 提前当成永久只读，因此没有调用 `/control`。对于由 TUI 持有 JSONL 锁的会话，Host 的 `CodingAgentRuntimeAdapter.openSession()` 会继续尝试 `WebCompanionRuntime`；该共享路径可在不创建第二个独立 Runtime Writer 的前提下返回 Web lease。

修复内容：

- `packages/web/src/state/use-workbench.ts` 删除外部锁/其他客户端状态的前端短路，所有会话统一先尝试控制权；Host 无法接管时仍通过 `webApi.session()` 展示只读快照。
- 控制响应返回前增加会话选择代次检查，避免旧会话的异步 control 响应覆盖当前会话状态。
- 保留单一 Host Runtime、TUI/Web 共享和租约串行写入语义。

实时验证：

- 对当前 TUI 持锁会话直接请求 `/api/sessions/<id>/control` 返回 HTTP `200`，结果为 `owned: true`、快照 `writeAccess: "owned"`。
- 重建并重启 Vite 后，真实浏览器重新加载同一外部锁会话，网络记录出现一次 `POST /api/sessions/<id>/control`，返回 `200`；输入框从 `当前会话不可写` 恢复为 `描述你想完成的工作…`，`disabled` 为 `false`。
- 对另一个已有客户端控制的同一会话再次请求 control 也返回 HTTP `200`，确认 `controlled_elsewhere` 不代表 Web 必须只读。
- `npm --workspace @lystar/code-web run check` 通过；Web 构建通过；`git diff --check` 通过。
- 本地 `1420`/`1422` 健康检查均返回 `{"ok":true,"gateway":"ok","host":"connected"}`。

真正没有可用 TUI/WebCompanion、Host 运行时无法接管或控制请求失败的会话仍会显示只读，这是预期降级，不再把摘要状态本身当作最终结论。

## TUI/Web 共享会话模型与思考强度切换补充（2026-09-05）

本轮补齐了 TUI Companion 到 Host Runtime 的模型与思考强度控制链，不再把“请在 TUI 中切换”作为共享会话的固定限制。新增 `set_model`、`set_thinking_level`、`cycle_model` 和 `cycle_thinking_level` Companion 请求；TUI 侧实际调用当前 `AgentSession` 的模型/思考强度方法，Host 侧继续复用同一个 TUI Runtime，不创建第二个 JSONL Writer。

同时，Web 工作台的模型和思考强度操作改为控制权优先：即使 Session 摘要显示 `controlled_elsewhere` 或 `locked_externally`，也先尝试 `/control`，成功后再执行修改；控制或修改失败时捕获错误并显示提示，不产生未处理 Promise。TUI Companion 完成远程修改后会请求 TUI 重绘，Host 会用返回快照同步 Web 状态。

本轮验证：

- `npx vitest --run test/web-companion.test.ts --passWithNoTests`：3 个测试通过。
- `cd packages/web-runtime && npx vitest --run test/runtime-adapter.test.ts test/service-observation.test.ts`：21 个测试通过。
- 临时隔离 TUI + 新构建 Host Runtime 线协议探针通过：模型直接切换、思考强度直接切换、模型循环切换、思考强度循环切换均成功；临时 JSONL 生成并观察到对应配置变更记录，验证后已清理。
- Coding Agent 与 Web Runtime 构建通过；Host 重启后 `1420`/`1422` 健康检查均返回 `{"ok":true,"gateway":"ok","host":"connected"}`。
- 浏览器工作台重新加载后仍保持已连接，未发现新的页面错误；本轮未通过长期运行的旧 TUI 进程验证模型操作，因为未为加载新 Companion 协议而中断用户会话。

当前 Web 生产构建仍受工作区内无关的 `packages/web/src/components/ai-elements/tool-batch.tsx` 语法错误阻塞；这不是本轮模型/思考强度改动引入的问题。


可见 TypeScript TUI 修改需要使用独立 tmux socket 覆盖至少以下尺寸：

- `80x24`
- 极小高度，例如 `80x8`
- `120x36`
- 流式回复、完成后状态、`/settings`、overlay、Tool/Diff 展开、resize 和退出恢复

验证结束后只关闭本轮创建的 tmux session，并检查 `git diff --check`。没有真实 Provider、Windows、macOS、Tauri 或远端 Host 实机证据时，不把本地构建结果写成跨平台运行通过。

## 会话标题发现与侧栏/详情同步补充（2026-09-05）

本轮修复会话列表只读 metadata 扫描无法发现首轮 64 KiB 之后 `session_info` 的问题，并统一侧栏与详情头部的标题来源：

- `packages/coding-agent/src/core/session-manager.ts` 在不解析完整历史的前提下，有界扫描首轮，最多读取 16 MiB；同一首轮存在多个 `session_info` 时取最后一个。
- metadata-only 缓存记录 `metadataNameResolved`；已解析的空标题以空字符串保留，避免项目会话列表刷新时把“明确清空标题”误当成“尚未发现标题”。
- `packages/web/src/components/workbench.tsx` 的 `SessionButton` 始终使用 `sessionTitle(summary)`，不再给当前活动会话单独覆盖标题。
- `packages/web/src/state/use-workbench.ts` 将 Bootstrap、control、snapshot、rename 及非当前会话的 `session_snapshot` 标题回写到对应侧栏摘要；明确清空标题时删除旧摘要名称，回退到稳定的 `firstMessage`/“未命名会话”。

定向验证：

```bash
cd packages/coding-agent
npx vitest --run test/session-info-modified-timestamp.test.ts --reporter=verbose --retry=0
npx biome check --no-errors-on-unmatched \
  src/core/session-manager.ts test/session-info-modified-timestamp.test.ts \
  --diagnostic-level=error
npx tsgo -p tsconfig.build.json --noEmit --pretty false

cd ../..
npm --prefix packages/coding-agent run build
npm --prefix packages/web-runtime run build
npm --prefix packages/web-gateway run build
npm --workspace @lystar/code-web run build
npx tsgo -p packages/web/tsconfig.json --noEmit --pretty false --incremental false
git diff --check
```

结果：SessionInfo 测试 6 项通过；Coding Agent/Web Runtime/Web Gateway/Web 构建通过；Web TypeScript 检查通过；标题扫描与空标题回归的 Biome 检查通过。重建后仅重启本轮允许重启的 Web Runtime 与 Web Gateway，未中断既有 TUI；健康检查 `127.0.0.1:1421/healthz` 与 `127.0.0.1:14320/healthz` 均返回 `{"ok":true,"gateway":"ok","host":"connected"}`。Gateway Bootstrap 实测返回 331 个会话，其中 9 个带已发现标题。

浏览器实测使用 `http://127.0.0.1:1421/`：初始活动会话的详情头部与侧栏同名；切换到“LYStar Code Web版模型供应商配置方案制定”后，详情头部与侧栏同名；切回“LYStar Code Web Prompts命令支持开发”后，原会话标题仍保持，三次状态均无页面告警。未通过真实重命名操作验证清空路径，以避免改写用户现有会话；该路径由 metadata-only 空标题单测和 snapshot/rename 状态代码覆盖。

当前完整根目录 `npm run check` 仍受其他 Web UI 文件已有 Biome 问题阻断；Web 工作台文件的整体格式检查还会报告既有 import、可访问性和格式差异，本节只把 Web TypeScript/build 与标题相关行为作为本轮证据。真实 Provider、跨平台、反向代理、同时 Web/TUI 输入及 `PI_WEB_MANAGE_RUNTIME=0` 下自动 Runtime 重启仍未验证。


## Web/Gateway 固定端口与单实例补充（2026-09-05）

本轮将本地 Web 开发入口和 Gateway 默认端口重新固定，避免因手工启动参数或旧进程残留造成端口漂移：

- Web Vite 开发服务器固定监听 `0.0.0.0:1420`，`packages/web` 增加 `npm run dev` 入口，并保持 `strictPort`；
- Web Gateway 默认固定监听 `0.0.0.0:1422`，Web Vite 的 `/api`、`/healthz` 和 `/ws` 代理统一指向 `http://127.0.0.1:1422`；
- Gateway 在 `${PI_CODING_AGENT_DIR}/web/gateway.lock` 使用原子创建的 PID 锁。同一 Agent 目录已有 Gateway 时直接拒绝重复启动，即使第二次启动显式传入另一端口，也不会创建第二个 Gateway；已退出进程留下的锁可按 PID/进程启动标识清理；
- `PI_WEB_PORT` 和 `PI_WEB_GATEWAY_URL` 仍保留作为明确的测试/特殊部署覆盖，不属于默认启动路径。

实际验证：

```bash
cd packages/web-gateway
node --import tsx --test test/config.test.ts test/instance-lock.test.ts
npm run build
cd ../web
npm run check
```

结果：Gateway 配置与单实例锁测试 3 项通过，Gateway 构建和 Web TypeScript 检查通过。重建后仅重启本轮允许重启的 Gateway 与 Web Vite，未中断 Web Runtime 或既有 TUI；当前监听为一个 Gateway `0.0.0.0:1422` 和一个 Web Vite `0.0.0.0:1420`，本机与 `192.168.2.35:1420` 的 Web 根页面均返回 HTTP `200`，两个 `/healthz` 均返回 `{"ok":true,"gateway":"ok","host":"connected"}`。使用另一端口再次启动 Gateway 被锁拒绝，当前 Gateway 进程数保持为 1。远程浏览器应访问 `http://<本机IP>:1420/`；`1422` 是 Gateway 后端端口，通常不需要直接打开。

## 远程 Web 页面离线与 WebSocket 来源校验补充（2026-09-05）

远程访问 `0.0.0.0:1420` 时，页面实际通过 Vite 代理连接本机 Gateway。浏览器发送的 `Origin` 是远程访问地址，例如 `http://10.218.2.35:1420`；旧代理没有改写该来源，Gateway 的 Host 白名单只允许本机回环来源，因此：

- `/control` 返回 `403 origin_not_allowed`，工作台将当前会话降级为“当前会话不可写”；
- `/ws` 握手被 Gateway 直接关闭，Vite 记录 `ws proxy error: socket hang up`，前端随后显示离线并反复重连。

修复内容：

- `packages/web/vite.config.ts` 为 `/api`、`/healthz` 和 `/ws` 使用统一的本地 Gateway 代理配置；
- 代理启用 `changeOrigin`，并将转发给本机 Gateway 的 `Origin` 统一改为 Gateway 本身的地址；
- 远程浏览器仍然只访问 `http://<本机IP>:1420/`，不需要直接访问 `1422`；
- Gateway 的 Token 鉴权和本地 Host 边界仍保留，未通过放宽 Gateway 为任意远程 Origin 来掩盖问题。

实际验证：

- 使用远程来源 `http://10.218.2.35:1420` 通过 Vite 代理建立 WebSocket，握手成功并正常关闭；
- 浏览器重新打开 `http://192.168.2.35:1420/` 后，`POST /api/sessions/<id>/control` 返回 `200`；
- 输入框恢复为“描述你想完成的工作…”，不再显示“当前会话不可写”；
- 浏览器无新错误，Vite 重启后的日志不再产生新的 WebSocket 代理错误；
- Web 构建、Gateway 构建、Web Gateway 配置/锁/稳定性测试共 6 项通过，Web TypeScript 检查通过。

## 远程 Web 页面离线根因与 WebSocket 代理修复补充（2026-09-05）

本轮复现了远程页面进入后立即离线的问题。浏览器实际连接的是：

```text
ws://10.218.2.35:1420/ws?token=...&clientId=...
```

根因不是 Session 被其他客户端占用，而是远程浏览器的 `Origin` 为 `http://10.218.2.35:1420`。Vite 将请求代理到本机 Gateway 后，Gateway 的来源白名单只允许回环地址，导致：

- `/control` 返回 `403 origin_not_allowed`，前端把会话显示为不可写；
- `/ws` 握手被 Gateway 关闭，Vite 报 `ws proxy error: socket hang up`；
- 前端 WebSocket 反复重连，页面最终显示离线。

修复内容：

- `packages/web/vite.config.ts` 将 `/api`、`/healthz`、`/ws` 统一配置为本机 Gateway 代理；
- 代理启用 `changeOrigin`，并把转发给本机 Gateway 的 `Origin` 改为 Gateway 地址；
- 远程浏览器仍然只访问 `http://<本机IP>:1420/`，不需要直接访问 `1422`；
- Gateway 仍保留 Token 鉴权和自身 Host 白名单，没有通过放宽 Gateway 为任意远程 Origin 来掩盖问题。

实际验证：

- 使用 `Origin: http://10.218.2.35:1420` 通过 Vite 代理建立 WebSocket，握手成功并以关闭码 `1000` 正常结束；
- 浏览器重新打开 Web 工作台后，`POST /api/sessions/<id>/control` 返回 `200`；
- 输入框恢复为“描述你想完成的工作…”，不再显示“当前会话不可写”；
- 浏览器无新错误，Vite 重启后的日志不再出现新的代理错误；
- Gateway 配置/锁/稳定性测试共 6 项通过，Web 和 Gateway 构建、TypeScript 检查通过。

## Web Runtime 验证

- 浏览器 smoke、Transcript 首屏和分页搜索。
- Session 创建、切换、释放、恢复、abort 和断线重连。
- operation journal 的重复请求、响应丢失和 payload 冲突。
- 标准 Extension `ui_request`/`ui_response`。
- Web Runtime 进程退出后的 Gateway 恢复和会话状态恢复。

## 结果记录规则

只记录本轮实际运行的命令、测试数量和平台。历史文档、旧 release artifact、未运行的 CI job 和其他机器结果必须明确标为未验证，不能代替当前证据。
