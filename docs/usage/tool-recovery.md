# Tool Recovery 与恢复经验

LYStar Code 的 Tool Recovery 用于记录稳定的 Tool 失败、关联后续恢复结果，并把已经验证的恢复经验提供给后续调用。它不改变 Tool 名、Session JSONL 或 `PI_*` 环境变量契约。

## 状态流转

```text
candidate -> verified -> active
     |          |         |
     +--------> suspended <- 终止失败过多
```

- `candidate`：由真实 recovery ledger 聚合产生，只能提供候选经验。
- `verified`：确定性证据达到门槛后自动进入。当前门槛是至少 3 次出现、至少 2 个 Session、至少 3 次恢复成功，并且没有失败或 terminal failure。
- `active`：必须通过显式批准进入。`verified` 不会因为单次成功自动获得执行权限。
- `suspended`：active 经验连续出现至少 3 次终止失败，且终止失败数高于恢复数时自动挂起。
- `expired`：超过 `expiresAt` 后只读展示，不参与匹配。

CLI 批准入口：

```bash
lc lessons list --status verified
lc lessons approve <lesson-id>
```

## Ledger 重放

Session recovery ledger 在成功落盘后才会生成可信 receipt。Session 启动时会重放对应 ledger：

- receipt 带有该 Session 内的账本序号。
- lesson 保存每个 Session 已处理的最后序号，进程重启后不会重复聚合旧记录。
- `receiptHashes` 只保留最近 64 条，用于覆盖写入与 Store 更新之间的崩溃窗口。
- 账本条目本身不保存原始 Session 路径；Session 标识和 Tool 调用标识使用摘要。

重放入口是 `reconcileToolRecoveryLessons()`。它只读取已经校验过的 ledger，不接受调用方伪造的普通对象作为恢复证据。

## History 与归档

Store 使用 `history.jsonl` 记录结构化状态转换。当前文件超过 512 条记录时：

1. 旧记录写入 `tool-recovery/history-archive/`。
2. 当前 history 替换为包含完整当前快照的 `checkpoint`。
3. 后续状态转换继续追加到 checkpoint 之后。
4. 最多保留 32 个归档文件；超出保留窗口的最旧归档会被删除。

普通读取、历史查看和 rollback 会同时读取归档与当前 history。归档保留期间，checkpoint 之前的 history ID 仍可用于回滚；超出 32 个归档文件保留窗口后，旧 ID 不再可用。

归档不是第二份状态事实源。启动恢复只以当前 checkpoint 和其后的增量记录重建快照；归档用于审计和受控 rollback。

## `safe_refresh` Handler

lesson 只能声明 `safe_refresh`，不能在持久数据中保存可执行代码。真正能执行的 handler 必须由代码显式注册：

```ts
import {
	createAgentSession,
	createToolRecoverySafeRefreshRegistry,
} from "@earendil-works/pi-coding-agent";

const safeRefresh = createToolRecoverySafeRefreshRegistry();
safeRefresh.register("inspect_custom", async ({ args, signal }) => {
	if (signal?.aborted) return undefined;
	return `当前状态：${JSON.stringify(args)}`;
});

await createAgentSession({
	toolRecoverySafeRefreshRegistry: safeRefresh,
});
```

默认 registry 只包含内置 `read` 和 `edit`：它们读取目标文件的前 200 行，目标不存在时只读取父目录前 80 个条目。自定义 handler 的约束由注册方负责，handler 抛错会被隔离为没有刷新结果，不会改变原 ToolResult 或中断 Agent 主流程。

只有匹配到 `active` lesson 后才会调用 handler；`candidate`、`verified`、`suspended` 和 `expired` 不会触发刷新动作。刷新文本还会和恢复指导共同受到 500 token 上限约束。

## 当前验证范围

已覆盖：

- candidate 自动验证但不会自动激活。
- ledger 重启重放、长账本游标幂等和 receipt hash 上限。
- history checkpoint 回放、归档读取和归档 history rollback。
- 自定义 Tool 的显式 safe_refresh handler、handler 异常隔离和 active lesson 命中链路。
- 真实 `apply_patch` Tool 从失败、模型重建到成功写入的关联链路。

没有把所有 Tool、所有 Provider 或所有 Session 流程扩展成 E2E。当前只对 ledger reconcile 使用独立 Node 进程验证重启幂等；发行包环境仍需单独验证，不作为本功能的默认测试矩阵。
