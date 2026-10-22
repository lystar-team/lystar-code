import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, type Exporter, Logger } from "@deepseek-ai/cordis";
import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import { type AgentHandle, assembleContextFor } from "@deepseek-ai/dsh-agent";
import { brandString } from "@deepseek-ai/dsh-brand";
import { type ContentBlock, createUserMessage, type StreamChunk, type ToolCallId } from "@deepseek-ai/dsh-llm";
import { appendPluginRecord, type SessionEvent, type SessionId } from "@deepseek-ai/dsh-session";
import { renderContextSnapshot, renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import { composePluginEntries, type HarnessConfig, readHarnessConfig, resolvePluginPackage } from "./config.ts";
import { createPluginImporter } from "./importer.ts";
import { type ModelGateway, registerModelGateway } from "./model-gateway.ts";

import { type MountedNativeProfile, mountNativeProfile, nativeProfileDirectory } from "./native-profile.ts";
import {
	type HistoryEntry,
	historyHashes,
	historySeed,
	importedTurns,
	importHistory,
	readyHistory,
	storedHistory,
} from "./session-history.ts";

export type { HarnessConfig, PluginSelection } from "./config.ts";
export {
	DSH_VERSION,
	installHarnessPlugin,
	readHarnessConfig,
	resolvePluginPackage,
	writeHarnessConfig,
} from "./config.ts";
export type { ModelGateway } from "./model-gateway.ts";
export { installNativeProfile, updateNativeBundle } from "./native-profile.ts";
export { DSH_TOOL_PREFIX, type HistoryEntry } from "./session-history.ts";

export interface PluginStatus {
	id: string;
	name: string;
	state: "active" | "disabled" | "pending" | "failed";
	missingServices: string[];
}

export interface HarnessOptions {
	directory: string;
	cwd: string;
	sessionId?: string;
	provider?: string;
	model?: string;
	modelGateway?: ModelGateway;
	npmCommand?: readonly string[];
	history?: () => readonly HistoryEntry[];
	systemPrompt?: () => string;
	isHostBusy?: () => boolean;
	onSessionChanged?: (sessionId: string) => void;
	onToolsChanged?: () => void;
	warn?: (message: string) => void;
}

/** A Cordis root belongs to exactly one LYStar session. No global loader hooks or DSH CLI. */
export class EmbeddedHarness {
	readonly context: Context;
	private readonly options: HarnessOptions;
	private readonly config: HarnessConfig;
	private readonly exporter: Exporter;
	private agent: AgentHandle | undefined;
	private activeSessionId: SessionId | undefined;
	private nativeProfile: MountedNativeProfile | undefined;
	private historySync: Promise<void> | undefined;
	private closed = false;
	private readonly executions = new Set<Promise<unknown>>();
	private readonly cancellation = new AbortController();
	private notify = false;

	private constructor(options: HarnessOptions, config: HarnessConfig) {
		this.options = options;
		this.config = config;
		this.context = new Context();
		this.exporter = {
			colors: false,
			export: (message) => {
				if (message.type === "error" || message.type === "warn")
					options.warn?.(Logger.format(this.exporter, message));
			},
		};
		this.context.logger.exporter(this.exporter);
		const directory = config.profile ? nativeProfileDirectory(options.directory, config.profile) : options.directory;
		this.context.baseUrl = pathToFileURL(join(directory, "package.json")).href;
	}

	static async create(
		options: HarnessOptions,
		config: HarnessConfig = readHarnessConfig(options.directory),
	): Promise<EmbeddedHarness> {
		const host = new EmbeddedHarness(options, config);
		try {
			const importer = createPluginImporter(options.directory);
			await host.context.plugin(importer.Loader, { baseUrl: host.context.baseUrl }).await();
			host.context.on("tools/change", () => {
				if (host.notify && host.context.get("tools")) options.onToolsChanged?.();
			});
			if (config.profile) {
				host.nativeProfile = await mountNativeProfile(host.context, importer, options, config.profile);
			} else {
				const anchors = new Map<string, string>();
				const entries = composePluginEntries(options.directory, config, options.warn ?? (() => {}), anchors);
				host.context.on("loader/patch-context", (entry, next) => {
					const anchor = anchors.get(entry.options.id);
					if (anchor) entry.ctx.baseUrl = anchor;
					next();
				});
				const defaults: EntryOptions[] = [
					{
						id: "lystar-system-prompt",
						name: "@deepseek-ai/dsh-system-prompt",
						config: { includeHarnessIdentity: false },
					},
					{ id: "lystar-tools", name: "@deepseek-ai/dsh-tools" },
					{ id: "lystar-skills", name: "@deepseek-ai/dsh-skill" },
					{ id: "lystar-session-projections", name: "@deepseek-ai/dsh-session-projection" },
					{ id: "lystar-sessions", name: "@deepseek-ai/dsh-session" },
					{ id: "lystar-agents", name: "@deepseek-ai/dsh-agent" },
					{ id: "lystar-llm", name: "@deepseek-ai/dsh-llm" },
					{ id: "lystar-agent-loop", name: "@deepseek-ai/dsh-agent-loop", config: { agents: [] } },
					{ id: "lystar-fs", name: "@deepseek-ai/dsh-fs-local", config: { cwd: options.cwd } },
					{
						id: "lystar-working-directory",
						name: "@deepseek-ai/dsh-working-directory",
						config: { defaultDirectory: options.cwd },
					},
				];
				const supplied = new Set(entries.map((entry) => entry.name));
				entries.unshift(...defaults.filter((entry) => !supplied.has(entry.name)));
				await host.context.loader.root.update(entries);
				await host.context.loader.await();
				for (const entry of host.context.loader.entries()) await entry.fiber?.await();
			}
			if (!host.context.get("tools")) throw new Error("DSH 工具服务未能启动");
			if (options.modelGateway) registerModelGateway(host.context, options.modelGateway, options.directory);
			if (options.systemPrompt)
				host.context.systemPrompt.section({
					name: "lystar-host-instructions",
					order: -1000,
					text: options.systemPrompt,
					interpolate: false,
				});
			const nativeProfile = host.nativeProfile;
			const id = brandString<SessionId>(options.sessionId ?? randomUUID());
			host.activeSessionId = id;
			const previous = await nativeProfile?.sessionInfo(id);
			const preset = previous?.preset ?? nativeProfile?.defaultPreset();
			const setup = nativeProfile ? (context: Context) => nativeProfile.setupAgent(context, preset) : undefined;
			const agentOptions = { provider: options.provider, model: options.model };
			host.context.on("agent/pre-step", async ({ agent }, next) => {
				if (
					(agent === host.agent?.agent || agent.id === host.activeSessionId) &&
					(host.historySync || options.isHostBusy?.())
				)
					throw new Error("LYStar 正在使用或同步当前会话，请稍后重试 DSH 任务");
				return next();
			});
			const history =
				nativeProfile && options.history
					? readyHistory(JSON.parse(JSON.stringify(options.history())) as HistoryEntry[])
					: undefined;
			const seed =
				!previous?.exists && history
					? await historySeed(host.context, id, history, options.systemPrompt?.())
					: undefined;
			host.agent = previous?.exists
				? await host.context.agents.resume({ resumeSessionId: id, agentOptions, setup })
				: await host.context.agents.create({
						sessionId: id,
						meta: { cwd: options.cwd, ...(preset ? { agentPreset: preset } : {}) },
						seed,
						agentOptions,
						setup,
					});
			await host.syncHistory();
			host.notify = true;
			host.nativeProfile?.commitReady();
			return host;
		} catch (error) {
			await host.dispose();
			throw error;
		}
	}

	tools() {
		// 插件的异步加载顺序不应改变宿主请求中的工具声明顺序。
		return this.context.tools
			.schemas(this.agent?.agent)
			.toSorted((left, right) => left.name.localeCompare(right.name, "en"));
	}

	get nativeManager() {
		return this.nativeProfile?.manager();
	}

	webUrl(): string | undefined {
		return this.nativeProfile?.webUrl();
	}

	tool(name: string) {
		return this.context.tools.get(name, this.agent?.agent);
	}

	statuses(): PluginStatus[] {
		return [...this.context.loader.entries()].map((entry) => ({
			id: entry.id,
			name: entry.options.name,
			state: entry.disabled
				? "disabled"
				: entry.fiber?.state === 2
					? "active"
					: entry.fiber?.state === 0
						? "pending"
						: "failed",
			missingServices: entry.fiber ? Object.keys(entry.fiber.inject).filter((name) => !entry.ctx.get(name)) : [],
		}));
	}

	diagnostics(): string[] {
		return this.context.logger.buffer
			.filter((message) => message.type === "error" || message.type === "warn")
			.map((message) => Logger.format(this.exporter, message));
	}

	async syncHistory(): Promise<void> {
		const read = this.options.history;
		if (!this.nativeProfile || !read) return;
		if (this.historySync) {
			await this.historySync;
			return this.syncHistory();
		}
		const entries = readyHistory(JSON.parse(JSON.stringify(read())) as HistoryEntry[]);
		this.historySync = this.importPiHistory(entries);
		try {
			await this.historySync;
		} finally {
			this.historySync = undefined;
		}
	}

	private async importPiHistory(entries: readonly HistoryEntry[]): Promise<void> {
		if (this.closed || !this.agent) throw new Error("DSH 插件运行时已关闭");
		const previous = this.agent;
		const assertIdle = () => {
			if (this.closed || this.agent !== previous) throw new Error("DSH 会话已切换或关闭");
			if (previous.agent.status !== "idle") throw new Error("DSH 当前会话正在执行任务");
		};
		const stored = storedHistory(previous.agent.session);
		const hashes = historyHashes(entries);
		const prefix =
			stored?.every((hash, index) => hashes[index] === hash) ??
			(entries.length === 0 || previous.agent.session.snapshotEvents().length === 0);
		if (prefix && stored?.length === hashes.length) return;
		assertIdle();
		if (prefix) {
			const framed = await importHistory(this.context, previous.agent.session, entries.slice(stored?.length ?? 0), {
				skipNative: stored !== undefined,
				systemPrompt: this.options.systemPrompt?.(),
				beforeCommit: assertIdle,
			});
			appendPluginRecord(previous.agent.session, "plugin:lystar/pi-history", { hashes });
			await this.context.sessions.flush(previous.agent.session);
			if (framed) {
				const notify = this.notify;
				this.notify = false;
				const preset = previous.agent.session.header.agentPreset;
				const agentOptions = { ...previous.agent.options };
				try {
					await previous.dispose();
					this.agent = undefined;
					this.agent = await this.context.agents.resume({
						resumeSessionId: previous.agent.id,
						signal: this.cancellation.signal,
						agentOptions,
						setup: (context) => this.nativeProfile?.setupAgent(context, preset),
					});
				} finally {
					this.notify = notify;
					if (notify) this.options.onToolsChanged?.();
				}
			}
			return;
		}
		const id = brandString<SessionId>(randomUUID());
		const seed = await historySeed(this.context, id, entries, this.options.systemPrompt?.());
		assertIdle();
		const native = this.nativeProfile;
		const preset = previous.agent.session.header.agentPreset ?? native?.defaultPreset();
		const replacement = await this.context.agents.create({
			sessionId: id,
			seed,
			signal: this.cancellation.signal,
			meta: { cwd: this.options.cwd, ...(preset ? { agentPreset: preset } : {}) },
			agentOptions: { ...previous.agent.options },
			setup: native ? (context) => native.setupAgent(context, preset) : undefined,
		});
		try {
			assertIdle();
		} catch (error) {
			await replacement.dispose();
			throw error;
		}
		this.agent = replacement;
		this.activeSessionId = id;
		this.options.onSessionChanged?.(id);
		await previous.dispose();
		this.options.onToolsChanged?.();
	}

	execute(name: string, callId: string, args: unknown, signal?: AbortSignal) {
		if (this.closed) throw new Error("DSH 插件运行时已关闭");
		const execution = (async () => {
			await this.syncHistory();
			if (this.closed) throw new Error("DSH 插件运行时已关闭");
			return this.context.tools.execute({
				name,
				callId: brandString<ToolCallId>(callId),
				arguments: args,
				agent: this.agent?.agent,
				signal: signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal,
			});
		})();
		this.executions.add(execution);
		void execution.finally(() => this.executions.delete(execution)).catch(() => {});
		return execution;
	}

	/** Drive the original loop so its policies, tools, and session events remain authoritative. */
	async run(prompt: string, options: { signal?: AbortSignal; onChunk?: (chunk: StreamChunk) => void } = {}) {
		await this.syncHistory();
		if (this.closed || !this.agent) throw new Error("DSH 插件运行时已关闭");
		const agent = this.agent.agent;
		if (agent.status !== "idle") throw new Error("DSH Agent 正在运行");
		const signal = options.signal
			? AbortSignal.any([options.signal, this.cancellation.signal])
			: this.cancellation.signal;
		signal.throwIfAborted();
		const events: SessionEvent[] = [];
		let failure: unknown;
		const releaseEvents = this.context.on("session/event", (session, event) => {
			if (session === agent.session) events.push(event);
		});
		const releaseErrors = this.context.on("agent/error", (event) => {
			if (event.agent === agent) failure = event.error;
		});
		const releaseStream = this.context.on("agent/assistant-stream", (event) => {
			if (event.agent === agent && event.frame.type === "chunk") options.onChunk?.(event.frame.chunk);
		});
		const cancel = () => agent.cancel({ kind: "user" });
		signal.addEventListener("abort", cancel, { once: true });
		const execution = (async () => {
			try {
				agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }));
				await agent.whenIdle();
				await this.context.sessions.flush(agent.session);
				signal.throwIfAborted();
				if (failure !== undefined) throw failure;
				const settled = events.findLast((event) => event.type === "turn/end");
				if (settled?.type !== "turn/end") throw new Error("DSH turn did not settle");
				if (settled.data.reason.kind === "aborted") throw new DOMException("DSH turn cancelled", "AbortError");
				if (settled.data.reason.kind !== "completed")
					throw new Error(`DSH turn ended: ${JSON.stringify(settled.data.reason)}`);
				return {
					sessionId: agent.session.id,
					events,
					messages: events.flatMap((event) => (event.type === "assistant/message" ? [event.data.message] : [])),
				};
			} finally {
				signal.removeEventListener("abort", cancel);
				releaseStream();
				releaseErrors();
				releaseEvents();
			}
		})();
		this.executions.add(execution);
		void execution.finally(() => this.executions.delete(execution)).catch(() => {});
		return execution;
	}

	usage() {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const imports = this.agent ? importedTurns(this.agent.agent.session) : new Set<number>();
		for (const event of this.agent?.agent.session.snapshotEvents() ?? []) {
			if (event.type !== "assistant/message" || imports.has(event.data.turn) || !event.data.usage) continue;
			const usage = event.data.usage;
			total.input += usage.inputTokens;
			total.output += usage.outputTokens;
			total.cacheRead += usage.cacheReadTokens ?? 0;
			total.cacheWrite += usage.cacheWriteTokens ?? 0;
		}
		return total;
	}

	cancel(): void {
		this.agent?.agent.cancel({ kind: "user" });
	}

	setModel(provider?: string, model?: string): void {
		if (!this.agent) return;
		this.agent.agent.options.provider = provider;
		this.agent.agent.options.model = model;
	}

	async prompt(signal?: AbortSignal): Promise<{ system: string; context: string }> {
		await this.syncHistory();
		const assembly = await this.context.systemPrompt.assemble(
			this.agent ? assembleContextFor(this.agent.agent, signal) : { signal },
		);
		return {
			system: renderPrompt({
				...assembly,
				sections: assembly.sections.filter((section) => section.name !== "lystar-host-instructions"),
			}),
			context: renderContextSnapshot(assembly),
		};
	}

	/** Resources follow package-local paths. Plugin-specific tools remain owned by Cordis. */
	async resourcePaths(signal?: AbortSignal): Promise<string[]> {
		const paths = (this.config.profile ? [] : this.config.plugins).flatMap((plugin) => {
			if (plugin.disabled) return [];
			const { root } = resolvePluginPackage(this.options.directory, plugin.name);
			const directory = join(root, "skills");
			return existsSync(directory) ? [directory] : [];
		});
		const skills = await this.context.skills.list({ scope: this.agent?.agent, cwd: this.options.cwd, signal });
		for (const skill of skills) {
			if (!skill.invocation.modelInvocable && !skill.invocation.userInvocable) continue;
			const path =
				skill.path ??
				(skill.resourceBase?.kind === "directory" ? join(skill.resourceBase.path, "SKILL.md") : undefined);
			if (path && existsSync(path)) paths.push(path);
		}
		return [...new Set(paths)];
	}

	async update(id: string, update: Pick<EntryOptions, "disabled" | "config">): Promise<void> {
		if (this.closed) throw new Error("DSH 插件运行时已关闭");
		const entry = this.context.loader.resolve(id);
		await entry.update(update);
		await this.context.loader.await();
		await entry.fiber?.await();
	}

	async content(
		blocks: readonly ContentBlock[],
		signal?: AbortSignal,
	): Promise<({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]> {
		return Promise.all(
			blocks.map(async (block) => {
				if (block.type === "text") return { type: "text" as const, text: block.text };
				if (block.type === "image") {
					const store = this.context.get("attachments");
					if (!store) throw new Error("图片工具结果需要 DSH attachments 服务");
					const image = await store.readImage(block.attachment, signal);
					return {
						type: "image" as const,
						data: Buffer.from(image.data).toString("base64"),
						mimeType: image.ref.mediaType,
					};
				}
				if (block.type === "file") {
					const path = this.context.get("attachments")?.fileHostPath(block.attachment);
					if (!path) throw new Error("文件工具结果需要支持本地文件的 DSH attachments 服务");
					return { type: "text" as const, text: path };
				}
				throw new Error(`DSH 工具结果不支持内容类型 ${block.type}`);
			}),
		);
	}

	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.notify = false;
		this.cancellation.abort();
		await Promise.allSettled([...this.executions, ...(this.historySync ? [this.historySync] : [])]);
		await this.agent?.dispose();
		await this.context.fiber.dispose();
	}
}
