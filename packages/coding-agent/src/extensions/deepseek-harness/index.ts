import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
	DSH_TOOL_PREFIX,
	EmbeddedHarness,
	type HistoryEntry,
	installHarnessPlugin,
	installNativeProfile,
	readHarnessConfig,
	updateNativeBundle,
	writeHarnessConfig,
} from "@lystar/deepseek-harness";
import { DeepSeekPrefixTracker, withDeepSeekCacheCompatibility } from "@lystar/deepseek-harness/cache";
import { type TSchema, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { convertToLlm } from "../../core/messages.ts";
import { buildSessionContext } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { buildSystemPrompt } from "../../core/system-prompt.ts";
import type { PluginAdapter, PluginAdapterController } from "../plugin-hub/types.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";

export const deepSeekPluginAdapter: PluginAdapter = {
	id: "dsh",
	name: "DeepSeek Harness",
	register: registerDeepSeekPluginAdapter,
};

export default function deepSeekHarnessExtension(pi: ExtensionAPI): void {
	registerDeepSeekPluginAdapter(pi);
}

function registerDeepSeekPluginAdapter(pi: ExtensionAPI): PluginAdapterController {
	const provider = deepseekProvider();
	const models = provider.getModels().map(withDeepSeekCacheCompatibility);
	pi.registerProvider({
		...provider,
		getModels: () => models,
		getAllModels: () => models,
	});

	const directory = join(getAgentDir(), "deepseek-harness");
	const registered = new Map<string, ToolDefinition<TSchema, unknown>>();
	const tracker = new DeepSeekPrefixTracker();
	let host: EmbeddedHarness | undefined;
	let sessionId: string | undefined;
	let previousContext = "";
	let hostInstructions = "";
	let initialized = false;
	let route: string | undefined;
	let initializing: Promise<void> | undefined;

	function synchronizeTools(): void {
		const current = new Set<string>();
		for (const schema of host?.tools() ?? []) {
			const name = `${DSH_TOOL_PREFIX}${schema.name}`;
			current.add(name);
			const original = schema.name;
			const definition: ToolDefinition<TSchema, unknown> = {
				name,
				label: schema.name,
				description: schema.description,
				parameters: Type.Unsafe(schema.parameters),
				exposure: "deferred",
				namespace: { name: "dsh", description: "DeepSeek Harness 插件工具" },
				executionMode: "sequential",
				async execute(callId, args, signal): Promise<AgentToolResult<unknown>> {
					const activeHost = host;
					if (!activeHost?.tool(original)) throw new Error(`DSH 工具 ${original} 当前不可用`);
					const result = await activeHost.execute(original, callId, args, signal);
					const content = await activeHost.content(result.content, signal);
					for (const context of result.additionalContexts ?? []) {
						pi.sendMessage(
							{
								customType: "dsh-tool-context",
								content: await activeHost.content(context.content, signal),
								display: false,
								details: { source: context.source },
							},
							{ deliverAs: "steer" },
						);
					}
					return {
						content,
						details: { dsh: { isError: result.isError, meta: result.meta, error: result.error } },
						structuredContent: result.isError ? undefined : result.value,
						isError: result.isError,
						terminate: result.concludesTurn,
					};
				},
			};
			const previous = registered.get(name);
			if (
				!previous ||
				previous.exposure === "hidden" ||
				previous.description !== definition.description ||
				JSON.stringify(previous.parameters) !== JSON.stringify(definition.parameters)
			) {
				registered.set(name, definition);
				pi.registerTool(definition);
			}
		}
		for (const [name, definition] of registered) {
			if (!current.has(name) && definition.exposure !== "hidden") {
				const hidden = { ...definition, exposure: "hidden" as const };
				registered.set(name, hidden);
				pi.registerTool(hidden);
			}
		}
		if (
			current.size > 0 &&
			pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools)
		) {
			const active = pi.getActiveTools();
			if (!active.includes(TOOL_SEARCH_TOOL_NAME)) pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
		}
	}

	async function start(ctx: ExtensionContext): Promise<void> {
		const id = ctx.sessionManager.getSessionId();
		if (initialized && sessionId === id) return;
		if (initializing) {
			await initializing;
			return start(ctx);
		}
		initializing = (async () => {
			initialized = false;
			await host?.dispose();
			host = undefined;
			previousContext = "";
			hostInstructions = ctx.getSystemPrompt();
			tracker.reset();
			sessionId = id;
			const config = readHarnessConfig(directory);
			if (!config.profile && config.plugins.every((plugin) => plugin.disabled)) {
				synchronizeTools();
				initialized = true;
				return;
			}
			const binding = config.profile
				? ctx.sessionManager
						.getBranch()
						.findLast((entry) => entry.type === "custom" && entry.customType === "deepseek-harness-binding")
				: undefined;
			let nativeSessionId = id;
			if (binding?.type === "custom") {
				const data = binding.data;
				if (
					!data ||
					typeof data !== "object" ||
					!("sessionId" in data) ||
					typeof data.sessionId !== "string" ||
					!data.sessionId
				)
					throw new Error("DSH 会话关联记录无效");
				nativeSessionId = data.sessionId;
			}
			host = await EmbeddedHarness.create(
				{
					directory,
					cwd: ctx.cwd,
					sessionId: nativeSessionId,
					history: () =>
						buildSessionContext(ctx.sessionManager.getBranch()).messages.flatMap((message) =>
							convertToLlm([message]).map((converted): HistoryEntry => {
								let source: HistoryEntry["source"];
								if (message.role === "custom" && message.customType === "dsh-tool-context") {
									const details = message.details;
									if (
										!details ||
										typeof details !== "object" ||
										!("source" in details) ||
										!details.source ||
										typeof details.source !== "object" ||
										!("kind" in details.source) ||
										typeof details.source.kind !== "string"
									)
										throw new Error("DSH 工具上下文来源记录无效");
									source = details.source as NonNullable<HistoryEntry["source"]>;
								}
								return {
									message: converted,
									native: message.role === "custom" && message.customType === "dsh-native-turn",
									source,
								};
							}),
						),
					systemPrompt: () => hostInstructions,
					isHostBusy: () => !ctx.isIdle(),
					onSessionChanged: (changed) => pi.appendEntry("deepseek-harness-binding", { sessionId: changed }),
					provider: ctx.model?.provider,
					model: ctx.model?.id,
					npmCommand: SettingsManager.create(ctx.cwd, getAgentDir()).getNpmCommand(),
					modelGateway: {
						models: () => ctx.modelRegistry.getAvailable(),
						auth: async (model) => {
							const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
							if (!auth.ok) throw new Error(auth.error);
							return auth;
						},
						stream: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
					},
					onToolsChanged: synchronizeTools,
					warn: (message) => ctx.ui.notify(message, "warning"),
				},
				config,
			);
			synchronizeTools();
			initialized = true;
			for (const status of host.statuses()) {
				if (status.state === "pending" || status.state === "failed")
					ctx.ui.notify(
						`DSH 插件 ${status.name}: ${status.state}，缺少服务: ${status.missingServices.join(", ") || "请查看插件加载错误"}`,
						"warning",
					);
			}
		})();
		try {
			await initializing;
		} finally {
			initializing = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await start(ctx);
	});
	pi.on("session_shutdown", async () => {
		await initializing;
		await host?.dispose();
		host = undefined;
		initialized = false;
		sessionId = undefined;
	});
	pi.on("resources_discover", async (_event, ctx) => {
		await start(ctx);
		return { skillPaths: (await host?.resourcePaths(ctx.signal)) ?? [] };
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const sections = { ...event.systemPromptOptions.sections };
		delete sections.deepseek_harness;
		await start(ctx);
		hostInstructions = buildSystemPrompt({ ...event.systemPromptOptions, sections });
		if (!host) return;
		host.setModel(ctx.model?.provider, ctx.model?.id);
		const prompt = await host.prompt(ctx.signal);
		const aliases = host
			.tools()
			.map((tool) => `${tool.name}: ${DSH_TOOL_PREFIX}${tool.name}`)
			.join("\n");
		if (prompt.system || aliases)
			event.systemPromptOptions.sections.deepseek_harness = [
				prompt.system,
				aliases ? `DSH 工具的 LYStar 调用名称：\n${aliases}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
		if (prompt.context === previousContext) return;
		previousContext = prompt.context;
		return {
			message: {
				customType: "dsh-runtime-context",
				content: prompt.context || "DSH 运行上下文已清空。",
				display: false,
			},
		};
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "deepseek") return;
		const nextRoute = `${ctx.model.provider}/${ctx.model.id}/${ctx.model.baseUrl}`;
		if (route !== nextRoute) tracker.reset();
		route = nextRoute;
		tracker.observe(event.payload);
	});
	pi.on("session_compact", () => {
		tracker.reset();
		previousContext = "";
	});

	const execute: PluginAdapterController["execute"] = async (args, ctx) => {
		const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(args);
		const action = match?.[1] ?? "list";
		const target = match?.[2] ?? "";
		try {
			if (action === "profile") {
				if (target !== "web" && target !== "headless" && target !== "off")
					throw new Error("用法: /dsh profile <web | headless | off>");
				const config = readHarnessConfig(directory);
				if (target === "off") delete config.profile;
				else {
					ctx.ui.setStatus("dsh", "正在安装原版 DSH Profile");
					try {
						await installNativeProfile(
							directory,
							target,
							SettingsManager.create(ctx.cwd, getAgentDir()).getNpmCommand(),
						);
					} finally {
						ctx.ui.setStatus("dsh", undefined);
					}
					config.profile = target;
				}
				writeHarnessConfig(directory, config);
				await ctx.reload();
				return;
			}
			if (action === "web") {
				await start(ctx);
				const url = host?.webUrl();
				if (!url) throw new Error("请先运行 /dsh profile web");
				pi.sendMessage({ customType: "dsh-web", content: `原版 DSH 页面：${url}`, display: true });
				return;
			}
			if (action === "run") {
				if (!target) throw new Error("用法: /dsh run <任务>");
				await start(ctx);
				if (!host?.nativeManager) throw new Error("请先运行 /dsh profile web 或 /dsh profile headless");
				host.setModel(ctx.model?.provider, ctx.model?.id);
				ctx.ui.setStatus("dsh", "DSH 正在执行");
				try {
					const result = await host.run(target, { signal: ctx.signal });
					const text = result.messages
						.flatMap((message) =>
							message.content.filter((block) => block.type === "text").map((block) => block.text),
						)
						.join("\n\n");
					pi.sendMessage({
						customType: "dsh-native-turn",
						content: `DSH 任务：${target}\n\n${text}`,
						details: { sessionId: result.sessionId, messages: result.messages.map((message) => message.id) },
						display: true,
					});
				} finally {
					ctx.ui.setStatus("dsh", undefined);
				}
				return;
			}
			if (["install", "update", "enable", "disable"].includes(action) && readHarnessConfig(directory).profile) {
				if (!target) throw new Error(`用法: /dsh ${action} <Bundle 包名或插件 entryId>`);
				await start(ctx);
				const manager = host?.nativeManager;
				if (!manager) throw new Error("DSH Profile 未能启动");
				let result: Awaited<ReturnType<typeof manager.installBundle>>;
				if (action === "update") result = await updateNativeBundle(manager, target);
				else if (action === "install") result = await manager.installBundle(target, { saveExact: true });
				else if ((await manager.listBundles()).some((bundle) => bundle.name === target))
					result = await manager.setBundleEnabled(target, action === "enable");
				else {
					const matches = (await manager.listPlugins()).filter(
						(plugin) => plugin.entryId === target || plugin.moduleName === target,
					);
					if (matches.length !== 1)
						throw new Error(
							`请选择一个插件 entryId：${matches.map((plugin) => plugin.entryId).join(", ") || target}`,
						);
					result = await manager.setPluginEnabled(matches[0].entryId, action === "enable");
				}
				pi.sendMessage({
					customType: "dsh-management",
					content: JSON.stringify(result, null, 2),
					display: true,
				});
				return;
			}
			if (action === "cache") {
				const messages = ctx.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.provider === "deepseek"
							? [entry.message]
							: [],
					);
				const totals = messages.reduce(
					(sum, message) => ({
						input: sum.input + message.usage.input,
						cacheRead: sum.cacheRead + message.usage.cacheRead,
						cacheWrite: sum.cacheWrite + message.usage.cacheWrite,
						cost:
							sum.cost + message.usage.cost.input + message.usage.cost.cacheRead + message.usage.cost.cacheWrite,
					}),
					{ input: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				);
				const total = totals.input + totals.cacheRead + totals.cacheWrite;
				const native = host?.nativeManager ? host.usage() : undefined;
				const nativeTotal = native ? native.input + native.cacheRead + native.cacheWrite : 0;
				const nativeReport = native
					? `\n\nDSH 当前主循环（全部模型）缓存命中: ${nativeTotal ? ((native.cacheRead / nativeTotal) * 100).toFixed(2) : "0.00"}%\n未缓存: ${native.input}; 命中: ${native.cacheRead}; 写入: ${native.cacheWrite}; 输出: ${native.output}`
					: "";
				pi.sendMessage({
					customType: "dsh-cache-report",
					content: `DeepSeek 缓存命中: ${total ? ((totals.cacheRead / total) * 100).toFixed(2) : "0.00"}%\n未缓存: ${totals.input}; 命中: ${totals.cacheRead}; 写入: ${totals.cacheWrite}; 输入费用估算: $${totals.cost.toFixed(6)}\n请求消息变化（不等于服务端缓存命中）：\n${JSON.stringify(tracker.snapshot(), null, 2)}${nativeReport}`,
					display: true,
				});
				return;
			}
			if (action === "install" || action === "update") {
				if (!target) throw new Error(`用法: /dsh ${action} <包名[@版本] 或本地包路径>`);
				const settings = SettingsManager.create(ctx.cwd, getAgentDir());
				const name = await installHarnessPlugin(directory, target, settings.getNpmCommand());
				ctx.ui.notify(`已安装 ${name}，正在重新加载插件`, "info");
			} else if (action === "enable" || action === "disable") {
				if (!target) throw new Error(`用法: /dsh ${action} <包名>`);
				const config = readHarnessConfig(directory);
				const selection = config.plugins.find((plugin) => plugin.name === target);
				if (selection) selection.disabled = action === "disable";
				else if (action === "enable") config.plugins.push({ name: target });
				else throw new Error(`未配置插件 ${target}`);
				writeHarnessConfig(directory, config);
			} else if (action === "list" || action === "") {
				await start(ctx);
				const config = readHarnessConfig(directory);
				const configured = config.profile ? [] : config.plugins;
				const statuses = host?.statuses() ?? [];
				pi.sendMessage({
					customType: "dsh-plugins",
					content:
						[
							config.profile ? `原版 DSH Profile: ${config.profile}` : "",
							configured.map((plugin) => `${plugin.disabled ? "停用" : "启用"} ${plugin.name}`).join("\n"),
							statuses
								.map(
									(plugin) =>
										`${plugin.state} ${plugin.name}${plugin.missingServices.length ? ` — 缺少 ${plugin.missingServices.join(", ")}` : ""}`,
								)
								.join("\n"),
							host?.diagnostics().join("\n"),
						]
							.filter(Boolean)
							.join("\n\n") || "尚未安装 DSH 插件。使用 /dsh install <包名> 安装。",
					display: true,
				});
				return;
			} else if (action !== "reload")
				throw new Error(
					"可用操作: profile / run / web / list / install / enable / disable / update / reload / cache",
				);
			await ctx.reload();
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};
	pi.registerCommand("dsh", {
		description: "管理内嵌 DSH：profile / run / web / list / install / enable / disable / update / reload / cache",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			await execute(args, ctx);
		},
	});
	return {
		commands: ["profile", "run", "web", "list", "install", "enable", "disable", "update", "reload", "cache"],
		execute,
		async list(ctx) {
			await start(ctx);
			return (host?.statuses() ?? []).map(({ id, name, state }) => ({ id, name, state }));
		},
	};
}
