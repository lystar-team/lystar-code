import type { WebCompletionResult } from "../types";
import type { WorkbenchState } from "./use-workbench";
import type { WorkbenchActions } from "../components/workbench/types";

// Web 只展示已有执行入口的内置命令；插件、模板与 Skill 不受此表限制。
const WEB_COMMAND_NAMES = new Set([
	"compact", "reload", "new", "export", "settings", "changes", "name", "model", "thinking",
	"resume", "fork", "tree", "trust", "session", "hotkeys",
]);

export function webCommandCompletions(result: WebCompletionResult): WebCompletionResult {
	return {
		...result,
		items: result.items.filter((item) => item.kind !== "command" || !item.value.startsWith("/") || WEB_COMMAND_NAMES.has(item.value.trim().slice(1))),
	};
}

export interface ComposerCommand {
	name: string;
	args: string;
}

export type CommandDialogKind = "model" | "thinking" | "name" | "resume" | "fork" | "tree" | "trust" | "session" | "hotkeys";
export interface CommandDialogRequest {
	kind: CommandDialogKind;
	value?: string;
}

// 命令归属由会话补全提供，避免把插件、模板和 Skill 当作内置命令拦截。
export async function resolveComposerCommand(
	text: string,
	completions: (text: string, cursor: number) => Promise<WebCompletionResult>,
): Promise<ComposerCommand | undefined> {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
	if (!match) return undefined;
	const token = `/${match[1]}`;
	const result = await completions(token, token.length);
	if (!result.items.some((item) => item.kind === "command" && item.value.trim() === token)) return undefined;
	return { name: match[1], args: match[2]?.trim() ?? "" };
}

export async function executeComposerCommand(
	command: ComposerCommand,
	state: Pick<WorkbenchState, "sessionId" | "session" | "models" | "currentOperation">,
	actions: Pick<WorkbenchActions, "compact" | "reloadResources" | "createSession" | "exportSession" | "renameSession" | "updateModel" | "updateThinking" | "openSettings" | "openInspector">,
	openDialog: (request: CommandDialogRequest) => void,
): Promise<void> {
	const { name, args } = command;
	const acceptsArgs = ["compact", "model", "thinking", "name"];
	if (args && !acceptsArgs.includes(name)) throw new Error(`Web 端的 /${name} 不接受参数`);
	if (
		["compact", "reload", "new", "fork", "tree", "resume"].includes(name) &&
		(state.session?.activity === "running" || state.session?.activity === "waiting_for_input" ||
			(state.currentOperation && ["accepted", "running", "waiting_for_input"].includes(state.currentOperation.status)))
	) throw new Error("请等待当前任务结束或停止任务后执行此命令");
	switch (name) {
		case "reload":
			await actions.reloadResources();
			return;
		case "compact":
			await actions.compact(args || undefined);
			return;
		case "new":
			await actions.createSession();
			return;
		case "export":
			await actions.exportSession();
			return;
		case "settings":
			await actions.openSettings("appearance");
			return;
		case "changes":
			await actions.openInspector("git");
			return;
		case "name":
			if (args && state.sessionId) await actions.renameSession(state.sessionId, args);
			else openDialog({ kind: "name", value: state.session?.name ?? "" });
			return;
		case "model": {
			const models = state.models.filter((model) => args === `${model.provider}/${model.id}` || args === model.id);
			if (args && models.length === 1) await actions.updateModel(models[0].provider, models[0].id);
			else openDialog({ kind: "model", value: args });
			return;
		}
		case "thinking": {
			const model = state.models.find((model) => model.provider === state.session?.model?.provider && model.id === state.session?.model?.id);
			if (!args) openDialog({ kind: "thinking" });
			else if ((model?.supportedThinkingLevels.length ? model.supportedThinkingLevels : ["off"]).includes(args)) await actions.updateThinking(args);
			else throw new Error("当前模型不支持这个思考级别，请使用 /thinking 选择");
			return;
		}
		case "resume":
		case "fork":
		case "tree":
		case "trust":
		case "session":
		case "hotkeys":
			openDialog({ kind: name });
			return;
		default:
			throw new Error(`/${name} 尚不支持 Web 操作，请在 TUI 中执行；此命令不会发送给模型`);
	}
}
