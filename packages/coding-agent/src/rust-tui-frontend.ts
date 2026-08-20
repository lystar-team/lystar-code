import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "./core/agent-session-runtime.ts";
import type { RustTuiLaunchOptions } from "./rust-tui-launch-options.ts";

export type TuiFrontendSelection = "auto" | "rust" | "typescript";

export function resolveTuiFrontendSelection(env: NodeJS.ProcessEnv = process.env): TuiFrontendSelection {
	const value = env.PI_TUI_FRONTEND;
	return value === "auto" || value === "rust" || value === "typescript" ? value : "typescript";
}

export interface RustTuiFrontendContext {
	runtime: AgentSessionRuntime;
	createRuntime: CreateAgentSessionRuntimeFactory;
	agentDir: string;
	launchOptions: RustTuiLaunchOptions;
	startupInput?: RustTuiStartupInput;
}

export interface RustTuiStartupPrompt {
	text: string;
	images?: Array<{ data: string; mimeType: string }>;
}

export interface RustTuiStartupInput {
	batchId: string;
	prompts: RustTuiStartupPrompt[];
}

export type RustTuiFrontendResult = { handled: true; exitCode: number } | { handled: false; reason: string };

/**
 * `handled: false` 必须保证没有接管或释放传入的 Runtime，调用方随后会回退 TypeScript TUI。
 * 一旦 Runtime 已被 Host 采用，前端必须返回 `handled: true`，避免同一 Session 启动第二个前端。
 */
export type RustTuiFrontend = (context: RustTuiFrontendContext) => Promise<RustTuiFrontendResult>;
