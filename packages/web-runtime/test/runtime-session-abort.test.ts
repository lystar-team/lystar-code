import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentSessionRuntime,
	CreateAgentSessionRuntimeFactory,
} from "../../coding-agent/src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../coding-agent/src/core/agent-session-services.ts";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../coding-agent/src/core/extensions/types.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../coding-agent/test/model-runtime-test-utils.ts";
import { CodingAgentRuntimeAdapter } from "../src/runtime-adapter.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(extensions: ExtensionFactory[] = []) {
	const directory = mkdtempSync(join(tmpdir(), "web-stop-input-"));
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "project");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const auth = AuthStorage.inMemory();
	await auth.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const registry = await createInMemoryModelRegistry(auth);
	registry.registerProvider(model.provider, {
		api: faux.api,
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		models: faux.models,
	});
	const modelRuntime = getModelRuntime(registry);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({
				defaultProjectTrust: "always",
				defaultProvider: model.provider,
				defaultModel: model.id,
				defaultThinkingLevel: "off",
			}),
			resourceLoaderOptions: {
				noExtensions: true,
				extensionFactories: extensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await new CodingAgentRuntimeAdapter({ agentDir, createRuntime }).createSession(cwd, async () => ({
		cancelled: true,
	}));
	const core = (runtime as unknown as { runtime: AgentSessionRuntime }).runtime;
	const activities: string[] = [];
	runtime.onEvent((event) => {
		if (event.type === "state_changed") activities.push((event.payload as { activity: string }).activity);
	});
	cleanups.push(async () => {
		await runtime.dispose();
		faux.unregister();
		rmSync(directory, { recursive: true, force: true });
	});
	const roomOptions = (inputId: string) => ({
		inputId,
		origin: {
			type: "room" as const,
			roomId: "room",
			messageId: inputId,
			seq: 1,
			kind: "task" as const,
			senderSessionId: "sender",
		},
	});
	return { runtime, core, faux, roomOptions, activities };
}

describe("Runtime 取消预约和预处理", () => {
	it("停止取消未提交和已排队的预约，迟到提交不能启动下一轮", async () => {
		const { runtime, faux, roomOptions, activities } = await setup();
		const pending = runtime.reservePromptWithOrigin!(roomOptions("pending"));
		const queued = runtime.reservePromptWithOrigin!(roomOptions("queued"));
		const submitted = queued.submit("不应启动");
		await runtime.abort();
		expect(await submitted).toBeUndefined();
		expect(await pending.submit("迟到提交")).toBeUndefined();
		expect(runtime.getSnapshot("owned").activity).toBe("idle");
		expect(faux.state.callCount).toBe(0);
		faux.setResponses([fauxAssistantMessage("新任务回复")]);
		await runtime.promptWithOrigin!("新任务", undefined, roomOptions("new"));
		expect(runtime.getLastAssistantText()).toBe("新任务回复");
		expect(faux.state.callCount).toBe(1);
		expect(activities.at(-1)).toBe("idle");
	});

	it("停止挂起的 Room 任务及其后续预约，迟到回复不续跑", async () => {
		const entered = deferred();
		const release = deferred();
		const exited = deferred();
		const { runtime, faux, roomOptions } = await setup();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				exited.resolve();
				return fauxAssistantMessage("迟到原回复");
			},
		]);
		const original = runtime.promptWithOrigin!("挂起输入", undefined, roomOptions("original"));
		await entered.promise;
		const queued = runtime.promptWithOrigin!("不应执行的输入", undefined, {
			inputId: "queued",
			origin: { type: "user", channel: "rpc" },
		});
		try {
			await runtime.abort();
			await Promise.all([original, queued]);
			expect(runtime.getSnapshot("owned").activity).toBe("idle");
			expect(faux.state.callCount).toBe(1);
			faux.setResponses([fauxAssistantMessage("新任务回复")]);
			await runtime.promptWithOrigin!("新任务", undefined, roomOptions("new"));
			release.resolve();
			await exited.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(runtime.getLastAssistantText()).toBe("新任务回复");
			expect(faux.state.callCount).toBe(2);
		} finally {
			release.resolve();
		}
	});

	it("停止 user_bash 预处理后，迟到的扩展结果不进入会话记录", async () => {
		const entered = deferred();
		const release = deferred();
		const exited = deferred();
		let signal: AbortSignal | undefined;
		const { runtime, faux, roomOptions } = await setup([
			(pi) => {
				pi.on("user_bash", async (_event, ctx) => {
					signal = ctx.signal;
					entered.resolve();
					await release.promise;
					exited.resolve();
					return { result: { output: "迟到 Bash 结果", exitCode: 0, cancelled: false, truncated: false } };
				});
			},
		]);
		const output: string[] = [];
		const command = runtime.runBash("ignored", false, (chunk) => output.push(chunk)).catch((error: unknown) => error);
		await entered.promise;
		try {
			await runtime.abort();
			await command;
			expect(signal?.aborted).toBe(true);
			faux.setResponses([fauxAssistantMessage("新任务回复")]);
			await runtime.promptWithOrigin!("新任务", undefined, roomOptions("new"));
			release.resolve();
			await exited.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(output).toEqual([]);
			expect(readFileSync(runtime.sessionPath, "utf8")).not.toContain("迟到 Bash 结果");
			expect(runtime.getSnapshot("owned").activity).toBe("idle");
		} finally {
			release.resolve();
		}
	});

	it("停止不等待快速模式的 Provider 刷新，刷新结束后不启动旧输入", async () => {
		const { runtime, core, faux, roomOptions } = await setup();
		const entered = deferred();
		const release = deferred();
		const refreshed = await core.services.modelRuntime.refresh({ allowNetwork: false });
		const fastMode = vi.spyOn(core.session, "fastMode", "get").mockReturnValue(true);
		const refresh = vi.spyOn(core.services.modelRuntime, "refresh").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return refreshed;
		});
		const original = runtime.promptWithOrigin!("旧输入", undefined, roomOptions("original")).catch(
			(error: unknown) => error,
		);
		await entered.promise;
		try {
			await runtime.abort();
			await original;
			fastMode.mockRestore();
			refresh.mockRestore();
			faux.setResponses([fauxAssistantMessage("新任务回复")]);
			await runtime.promptWithOrigin!("新任务", undefined, roomOptions("new"));
			release.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(faux.state.callCount).toBe(1);
			expect(runtime.getLastAssistantText()).toBe("新任务回复");
		} finally {
			release.resolve();
		}
	});
});
