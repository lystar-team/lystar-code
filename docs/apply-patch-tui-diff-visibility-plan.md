# apply_patch TUI Diff 可见性修复方案

## 1. 问题

当前在 TUI 中执行 `apply_patch` 后，只能看到类似下面的通用结果：

```text
apply_patch 已执行
Applied patch to 3 file(s).
```

用户看不到：

- 修改了哪些文件。
- 每个文件增加、删除了多少行。
- 本次操作总共增加、删除了多少行。
- 具体 diff 内容。

文件已经真实修改，但 TUI 没有提供可核对的变更证据，操作过程因此变成黑盒。

## 2. 根因

### 2.1 执行端已经产生完整 diff 数据

`packages/coding-agent/src/extensions/apply-patch/index.ts` 在应用补丁前会为每个文件调用 `generateDiffString()`，最终结果已经包含：

```ts
interface ApplyPatchDetails {
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    diff: string;
  }>;
}
```

`apply_patch` 的 Tool Result details 中没有缺数据。新增、更新、删除文件都已经有文件路径、行数统计和完整 diff。

### 2.2 `apply_patch` 没有注册 TUI renderer

`createApplyPatchToolDefinition()` 目前只有：

- 参数定义。
- 参数兼容处理。
- patch 解析和文件写入。
- Tool Result 数据。

它没有实现 `renderCall()` 和 `renderResult()`。

`ToolExecutionComponent` 找到 Extension ToolDefinition 后仍会尝试调用 renderer。由于 renderer 不存在，只能走通用 fallback：

- 折叠状态只显示工具名和执行状态。
- 成功结果默认隐藏正文。
- 展开后只读取 Tool Result `content`。
- 通用 fallback 不读取 `details.files`。

`content` 只有 `Applied patch to N file(s).`，所以 TUI 看不到已有的结构化 diff。

### 2.3 Turn Summary 不能替代 Tool Diff

`InteractiveMode` 在 `tool_execution_end` 中已经识别 `details.files`，并把文件和行数写入 Turn Summary。该能力只能提供回合结束后的汇总：

- 需要等待整个 Agent turn 结束。
- 默认仍然折叠。
- 展开后只有文件列表和行数，没有具体 diff。
- 无法直接对应当前这次 `apply_patch` Tool 调用。

Turn Summary 适合做回合总览，不能承担单次文件修改的即时核对。

## 3. 修复原则

修复放在 `apply_patch` ToolDefinition 中，原因如下：

- `ApplyPatchDetails` 的结构由该 Extension 定义。
- diff 已经计算完成，可以直接渲染。
- Extension renderer 会同时覆盖实时执行和 Session 历史重放。
- 通用 `ToolExecutionComponent` 不需要认识 `apply_patch` 的私有 details 格式。
- `edit`、`write` 已经采用 ToolDefinition 自定义 renderer，这条路径和现有架构一致。

本次不新增设置项，也不新增 diff 组件。继续复用现有：

- `formatToolSummary()`：工具摘要。
- `renderToolPath()`：路径展示。
- `renderDiff()`：带行号和增删颜色的 diff。
- `Ctrl+O` 和点击 Tool：现有展开、折叠行为。

## 4. TUI 展示

### 4.1 执行中

参数尚未完整或文件还未写入时显示：

```text
✎ 正在应用补丁
```

参数完整后可以从 patch operation 中显示预计文件数，但不能在执行成功前使用“已修改”文案。

### 4.2 执行成功后的默认状态

成功后立即显示总数和每个文件的统计，具体 diff 保持折叠：

```text
✎ 已应用补丁 · 3 个文件 · +2 -2
  + docs/new.md        +1
  ✎ src/index.ts       +1 -1
  - src/old.ts         -1
```

文件列表属于本次操作的基本结果，默认可见。用户不需要等待 Turn Summary，也不需要先猜测是否有可展开内容。

文件操作图标根据真实 operation 选择：

| operation | 显示 |
| --- | --- |
| `add` | `+` |
| `update` | `✎` |
| `delete` | `-` |

路径继续使用现有路径缩短和主题着色，长路径按终端宽度换行或截断，不能挤掉行数统计。

### 4.3 展开状态

用户点击 Tool 或按 `Ctrl+O` 后，在每个文件行下面显示该文件已有的 `diff`：

```text
✎ 已应用补丁 · 3 个文件 · +2 -2

+ docs/new.md  +1
  + 1 新内容

✎ src/index.ts  +1 -1
  - 8 oldValue
  + 8 newValue

- src/old.ts  -1
  - 1 removed
```

diff 使用现有 `renderDiff()`，保持和 `edit` Tool 一致的行号、增删颜色和行内变化高亮。这里不能显示原始 patch 文本，因为原始 patch 缺少最终文件上下文，且执行端已经生成了更准确的结果 diff。

### 4.4 执行失败

失败时直接显示错误正文，不显示成功统计：

```text
! 应用补丁失败
  Could not find the expected text in src/index.ts
```

如果失败发生在写入过程中，现有原子回滚逻辑继续负责恢复文件。TUI 只展示真实错误，不根据输入 patch 伪造已修改文件列表。

## 5. 数据结构调整

为 `ApplyPatchDetails.files` 增加 operation，避免根据增删行数猜测文件类型：

```ts
interface ApplyPatchDetails {
  files: Array<{
    path: string;
    operation: "add" | "update" | "delete";
    additions: number;
    deletions: number;
    diff: string;
  }>;
}
```

该值直接来自 `StagedPatchFile.operation.kind`，没有第二套判断规则。

旧 Session 中的 `details.files` 没有 operation。renderer 读取旧记录时使用通用修改图标 `✎`，路径、行数和 diff 仍可正常展示。Session JSONL 不需要迁移。

## 6. 实现范围

### 6.1 `packages/coding-agent/src/extensions/apply-patch/index.ts`

在现有 ToolDefinition 中完成全部修复：

- `ApplyPatchDetails.files` 增加 `operation`。
- Tool Result 写入 operation。
- 增加 `renderCall()`。
- 增加 `renderResult()`。
- 汇总总 additions/deletions。
- 默认渲染文件列表。
- 展开时逐文件调用 `renderDiff()`。
- 错误时显示 Tool Result 文本。

renderer 使用 `context.lastComponent` 复用组件实例，避免流式更新和展开操作反复创建整棵组件树。

### 6.2 `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

预期无需修改。现有 Extension renderer、`context.expanded`、点击展开和 `Ctrl+O` 已经足够。

只有测试证明通用组件没有把最新 `resultDetails` 传回 `renderCall()` 时，才在共享责任位置补齐该上下文；当前源码已经提供 `resultDetails`。

### 6.3 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

预期无需修改。当前 Turn Summary 已经支持 `details.files`，新增 operation 不影响现有读取。

## 7. 测试

### 7.1 Extension 结果测试

更新 `packages/coding-agent/test/apply-patch-extension.test.ts`：

- add、update、delete 返回正确 operation。
- 每个文件仍有正确 additions、deletions 和 diff。
- 多文件总结果不丢失。
- 原子校验和回滚测试保持通过。

### 7.2 TUI renderer 测试

在同一测试文件或 `tool-execution-component.test.ts` 增加：

- 折叠状态显示“已应用补丁”、文件总数和总增删行。
- 折叠状态列出全部文件及各自行数。
- 展开状态显示每个文件的 diff。
- add、update、delete 使用对应操作标识。
- 失败状态显示错误，不显示成功统计。
- 旧 details 没有 operation 时仍能显示文件和 diff。
- Session 重放时 renderer 只依赖持久 Tool Result details，不读取当前工作区重新计算 diff。

### 7.3 宽度测试

覆盖 40、60、80、120 列：

- 文件路径和行数不重叠。
- 中文路径和宽字符不越界。
- 长路径处理后仍能看到 `+N -N`。
- 展开 diff 的每一行不超过终端宽度。

### 7.4 验证命令

```bash
npm --prefix packages/coding-agent test -- \
  test/apply-patch-extension.test.ts \
  test/tool-execution-component.test.ts \
  test/task-workbench-components.test.ts

npm run check
npm --prefix packages/coding-agent test
```

真实 PTY 验收使用一个 patch 同时新增、修改、删除三个文件，检查：

1. 执行完成后立即看到文件列表和增删行数。
2. 点击工具后看到三个文件各自的 diff。
3. 再次点击后 diff 收起，文件列表保留。
4. 退出并恢复 Session 后仍能看到相同内容。
5. Turn Summary 的文件统计与 Tool 卡片一致。

## 8. 完成标准

- `apply_patch` 成功后立即显示文件总数、总增删行、文件路径和各文件增删行。
- 展开 Tool 后可以检查每个文件的完整 diff。
- 折叠只隐藏 diff 正文，不隐藏文件清单。
- 失败结果直接可见，不显示虚假成功信息。
- 历史 Session 可以用持久 details 重放，不依赖当前工作区状态。
- 不修改通用 Tool renderer，不重复计算 diff，不新增设置和组件体系。
- 聚焦测试、Coding Agent 全量测试、`npm run check` 和真实 PTY 验收通过。