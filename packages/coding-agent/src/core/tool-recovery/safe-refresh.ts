import { readdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveReadPathAsync } from "../tools/path-utils.ts";

const TOOL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_FILE_LINES = 200;
const MAX_DIRECTORY_ENTRIES = 80;

export interface ToolRecoverySafeRefreshContext {
	readonly toolName: string;
	readonly args: unknown;
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

export type ToolRecoverySafeRefreshHandler = (
	context: ToolRecoverySafeRefreshContext,
) => Promise<string | undefined> | string | undefined;

/**
 * 只保存代码侧显式注册的受控刷新 handler。lesson 只能声明 safe_refresh，不能携带可执行逻辑。
 */
export class ToolRecoverySafeRefreshRegistry {
	private readonly handlers = new Map<string, ToolRecoverySafeRefreshHandler>();

	register(toolName: string, handler: ToolRecoverySafeRefreshHandler): void {
		if (!TOOL_NAME.test(toolName)) throw new Error("safe_refresh Tool 名称无效");
		if (typeof handler !== "function") throw new Error("safe_refresh handler 必须是函数");
		if (this.handlers.has(toolName)) throw new Error(`safe_refresh handler 已注册：${toolName}`);
		this.handlers.set(toolName, handler);
	}

	has(toolName: string): boolean {
		return this.handlers.has(toolName);
	}

	async run(toolName: string, args: unknown, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
		const handler = this.handlers.get(toolName);
		if (!handler || signal?.aborted) return undefined;
		try {
			return await handler({ toolName, args, cwd, signal });
		} catch {
			// 刷新失败不能改变原 ToolResult，也不能把 handler 异常传播到 Agent 主流程。
			return undefined;
		}
	}
}

export function createToolRecoverySafeRefreshRegistry(
	customHandlers: Readonly<Record<string, ToolRecoverySafeRefreshHandler>> = {},
): ToolRecoverySafeRefreshRegistry {
	const registry = new ToolRecoverySafeRefreshRegistry();
	registry.register("read", refreshBuiltinFileContext);
	registry.register("edit", refreshBuiltinFileContext);
	for (const [toolName, handler] of Object.entries(customHandlers)) registry.register(toolName, handler);
	return registry;
}

async function refreshBuiltinFileContext(context: ToolRecoverySafeRefreshContext): Promise<string | undefined> {
	if (context.toolName !== "read" && context.toolName !== "edit") return undefined;
	if (typeof context.args !== "object" || context.args === null || Array.isArray(context.args)) return undefined;
	const pathValue = (context.args as Record<string, unknown>).path;
	if (typeof pathValue !== "string" || pathValue.length === 0 || context.signal?.aborted) return undefined;

	let resolvedPath: string;
	try {
		resolvedPath = await resolveReadPathAsync(pathValue, context.cwd);
	} catch {
		return undefined;
	}

	try {
		const content = await readFile(resolvedPath, "utf8");
		if (context.signal?.aborted) return undefined;
		const lines = content.split(/\r?\n/).slice(0, MAX_FILE_LINES);
		return `已受控刷新 ${pathValue} 的当前内容：\n${lines.map((line, index) => `${index + 1}: ${line}`).join("\n")}`;
	} catch {
		try {
			const parent = dirname(resolvedPath);
			const entries = await readdir(parent, { withFileTypes: true });
			if (context.signal?.aborted) return undefined;
			const names = entries
				.slice(0, MAX_DIRECTORY_ENTRIES)
				.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
				.join(", ");
			return `已受控刷新目标父目录 ${parent}，当前条目：${names || "（空）"}`;
		} catch {
			return undefined;
		}
	}
}
