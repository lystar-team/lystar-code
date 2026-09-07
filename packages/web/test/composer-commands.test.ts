import { describe, expect, it, vi } from "vitest";
import { executeComposerCommand, resolveComposerCommand, webCommandCompletions } from "../src/state/composer-commands";
import type { WorkbenchState } from "../src/state/use-workbench";

const completions = vi.fn(async (text: string) => ({
	prefixStart: 0,
	prefixEnd: text.length,
	items: [{ value: `${text} `, label: text.slice(1), kind: "command" as const }],
}));
const state: Pick<WorkbenchState, "sessionId" | "session" | "models" | "currentOperation"> = {
	sessionId: "session-one",
	models: [],
};
function actions() {
	return {
		reloadResources: vi.fn(async () => {}),
		compact: vi.fn(async () => {}),
		createSession: vi.fn(async () => {}),
		exportSession: vi.fn(async () => {}),
		renameSession: vi.fn(async () => {}),
		updateModel: vi.fn(async () => {}),
		updateThinking: vi.fn(async () => {}),
		openSettings: vi.fn(async () => {}),
		openInspector: vi.fn(async () => {}),
	};
}

describe("Web 输入命令", () => {
	it("菜单移除不支持的内置命令，保留 reload 与所有资源命令", () => {
		const names = ["reload", "compact", "import", "share", "clone", "quit", "scoped-models"];
		const result = webCommandCompletions({
			prefixStart: 0,
			prefixEnd: 1,
			items: [
				...names.map((name) => ({ label: name, value: `/${name} `, kind: "command" as const })),
				{ label: "plugin", value: "/plugin ", kind: "extension" },
				{ label: "template", value: "/template ", kind: "prompt" },
				{ label: "skill:demo", value: "/skill:demo ", kind: "skill" },
				{ label: "model-argument", value: "provider/model", kind: "command" },
			],
		});
		expect(result.items.map((item) => item.label)).toEqual([
			"reload",
			"compact",
			"plugin",
			"template",
			"skill:demo",
			"model-argument",
		]);
		expect(result.prefixEnd).toBe(1);
	});
	it("reload 调用资源重载，运行中不执行", async () => {
		const api = actions();
		await executeComposerCommand({ name: "reload", args: "" }, state, api, vi.fn());
		expect(api.reloadResources).toHaveBeenCalledOnce();
		const active = { ...state, currentOperation: { status: "running" } as WorkbenchState["currentOperation"] };
		await expect(executeComposerCommand({ name: "reload", args: "" }, active, api, vi.fn())).rejects.toThrow(
			"当前任务",
		);
		expect(api.reloadResources).toHaveBeenCalledOnce();
	});
	it("普通文本不查询命令；附加说明保留换行", async () => {
		const lookup = vi.fn(completions);
		expect(await resolveComposerCommand("普通消息 /compact", lookup)).toBeUndefined();
		expect(lookup).not.toHaveBeenCalled();
		expect(await resolveComposerCommand("  /compact 保留结论\n和待办  ", lookup)).toEqual({
			name: "compact",
			args: "保留结论\n和待办",
		});
		expect(lookup).toHaveBeenCalledWith("/compact", 8);
	});
	it.each(["extension", "prompt", "skill"] as const)("不拦截 %s 命令", async (kind) => {
		expect(
			await resolveComposerCommand("/custom 参数", async () => ({
				prefixStart: 0,
				prefixEnd: 7,
				items: [{ label: "custom", value: "/custom ", kind }],
			})),
		).toBeUndefined();
	});
	it("仅匹配完整命令，不把前缀和未知命令当作内置命令", async () => {
		expect(
			await resolveComposerCommand("/comp", async () => ({
				prefixStart: 0,
				prefixEnd: 5,
				items: [{ label: "compact", value: "/compact ", kind: "command" }],
			})),
		).toBeUndefined();
	});
	it("命令归属查询失败时保留错误，不回退为普通消息", async () => {
		await expect(
			resolveComposerCommand("/compact", async () => {
				throw new Error("连接断开");
			}),
		).rejects.toThrow("连接断开");
	});
	it("压缩调用专用 action，并透传说明", async () => {
		const api = actions();
		await executeComposerCommand({ name: "compact", args: "保留代码" }, state, api, vi.fn());
		expect(api.compact).toHaveBeenCalledWith("保留代码");
		await executeComposerCommand({ name: "compact", args: "" }, state, api, vi.fn());
		expect(api.compact).toHaveBeenLastCalledWith(undefined);
	});
	it.each(["name", "model", "thinking", "resume", "fork", "tree", "trust", "session", "hotkeys"])(
		"/%s 打开交互界面",
		async (name) => {
			const open = vi.fn();
			await executeComposerCommand({ name, args: "" }, state, actions(), open);
			expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: name }));
		},
	);
	it("设置与变更复用工作台入口", async () => {
		const api = actions();
		await executeComposerCommand({ name: "settings", args: "" }, state, api, vi.fn());
		await executeComposerCommand({ name: "changes", args: "" }, state, api, vi.fn());
		expect(api.openSettings).toHaveBeenCalledWith("appearance");
		expect(api.openInspector).toHaveBeenCalledWith("git");
	});
	it("重命名参数不丢失", async () => {
		const api = actions();
		await executeComposerCommand({ name: "name", args: "命令交互修复" }, state, api, vi.fn());
		expect(api.renameSession).toHaveBeenCalledWith("session-one", "命令交互修复");
	});
	it("不支持的内置命令和参数报错，不伪装成成功", async () => {
		await expect(executeComposerCommand({ name: "import", args: "" }, state, actions(), vi.fn())).rejects.toThrow(
			"不会发送给模型",
		);
		await expect(
			executeComposerCommand({ name: "export", args: "file.html" }, state, actions(), vi.fn()),
		).rejects.toThrow("不接受参数");
	});
	it("运行中不压缩或切换上下文", async () => {
		const api = actions();
		const active = { ...state, currentOperation: { status: "running" } as WorkbenchState["currentOperation"] };
		await expect(executeComposerCommand({ name: "compact", args: "" }, active, api, vi.fn())).rejects.toThrow(
			"当前任务",
		);
		expect(api.compact).not.toHaveBeenCalled();
	});
	it("执行失败传回输入框，允许保留草稿重试", async () => {
		const api = actions();
		api.compact.mockRejectedValue(new Error("压缩失败"));
		await expect(executeComposerCommand({ name: "compact", args: "" }, state, api, vi.fn())).rejects.toThrow(
			"压缩失败",
		);
	});
});
