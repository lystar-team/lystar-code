/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses RPC mode to retain structured output and a controllable subagent session.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { formatSubagentMode, formatSubagentScope, formatSubagentSource, t } from "../../locales/zh-CN.ts";
import { SubagentResultComponent } from "../../modes/interactive/components/subagent-run.ts";
import { getToolSummary } from "../../modes/interactive/components/tool-summary.ts";
import { uiGlyphs } from "../../modes/interactive/ui-glyphs.ts";
import type { JsonAgentSessionEvent } from "../../modes/json-event.ts";
import { RpcClient } from "../../modes/rpc/rpc-client.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

export type AgentRunState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface SubagentEventSummary {
	type: string;
	at: number;
	text?: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "builtin" | "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages?: Message[];
	finalOutput?: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	runId?: string;
	agentId?: string;
	state?: AgentRunState;
	currentAction?: string;
	startedAt?: number;
	updatedAt?: number;
	elapsedMs?: number;
	events?: SubagentEventSummary[];
	session?: SubagentSessionRef;
}

export interface SubagentSessionRef {
	version: 1;
	sessionId: string;
	sessionFile: string;
	parentSessionFile?: string;
	cwd: string;
	createdAt: number;
}

export interface SubagentSessionDescriptor {
	agentId: string;
	agent: string;
	agentSource: SingleResult["agentSource"];
	task: string;
	agentScope: AgentScope;
	session: SubagentSessionRef;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	runId?: string;
	results: SingleResult[];
}

/** A read-only value snapshot of a direct subagent in the current extension instance. */
export interface SubagentRunSnapshot {
	runId: string;
	agentId: string;
	agent: string;
	agentSource: SingleResult["agentSource"];
	task: string;
	state: AgentRunState;
	currentAction?: string;
	startedAt: number;
	updatedAt: number;
	elapsedMs: number;
	events: SubagentEventSummary[];
	controllable: boolean;
	session?: SubagentSessionRef;
}

export function getFinalOutput(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.state === "failed" ||
		result.state === "cancelled"
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			result.finalOutput ||
			getFinalOutput(result.messages ?? []) ||
			t("subagent.output.empty")
		);
	}
	return result.finalOutput || getFinalOutput(result.messages ?? []) || t("subagent.output.empty");
}

function serializeResult(result: SingleResult): SingleResult {
	const { messages, ...summary } = result;
	return {
		...summary,
		finalOutput: result.finalOutput || getFinalOutput(messages ?? []),
	};
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[${t("subagent.output.truncated", {
		bytes: byteLength - Buffer.byteLength(truncated, "utf8"),
	})}]`;
}

function formatAvailableAgents(agents: readonly AgentConfig[]): string {
	return agents.map((agent) => `${agent.name} (${formatSubagentSource(agent.source)})`).join(", ") || "无";
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(): { command: string; commandArgs: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, commandArgs: [currentScript] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, commandArgs: [] };
	}

	return { command: "pi", commandArgs: [] };
}

function formatCurrentAction(toolName: string, args: unknown): string {
	const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	if (toolName === "bash" && typeof input.command === "string") {
		const command = input.command.split(/\r?\n/, 1)[0]?.trim();
		if (command) return `$ ${command}`;
	}
	const rawPath = typeof input.path === "string" ? input.path : input.file_path;
	if (typeof rawPath === "string" && rawPath) return `${toolName} ${rawPath}`;
	if (typeof input.pattern === "string" && input.pattern) return `${toolName} ${input.pattern}`;
	return toolName;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export type SubagentSessionEvent = JsonAgentSessionEvent | { type: "tool_result_end"; message: Message };

export const SUBAGENT_RETENTION_MS = 60_000;

export interface SubagentRunControllerOptions {
	runId: string;
	agentId: string;
	agent: AgentConfig;
	task: string;
	cwd: string;
	args: string[];
	command: string;
	commandArgs: string[];
	parentSessionFile?: string;
	session?: SubagentSessionRef;
	step?: number;
	onUpdate?: () => void;
	onDisposed?: () => void;
	cleanup?: () => Promise<void>;
}

export class SubagentRunController {
	readonly result: SingleResult;
	private readonly client: RpcClient;
	private readonly options: SubagentRunControllerOptions;
	private settledPromise: Promise<SingleResult> | null = null;
	private settleResolve: ((result: SingleResult) => void) | null = null;
	private settleReject: ((error: Error) => void) | null = null;
	private retentionTimer: NodeJS.Timeout | null = null;
	private updateTimer: NodeJS.Timeout | null = null;
	private unsubscribeEvent: (() => void) | null = null;
	private unsubscribeExit: (() => void) | null = null;
	private removeAbortListener: (() => void) | null = null;
	private readonly eventListeners = new Set<(event: SubagentSessionEvent) => void>();
	private disposed = false;
	private started = false;

	constructor(options: SubagentRunControllerOptions) {
		this.options = options;
		const now = Date.now();
		this.result = {
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: options.task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: options.agent.model,
			step: options.step,
			runId: options.runId,
			agentId: options.agentId,
			state: "queued",
			startedAt: now,
			updatedAt: now,
			events: [],
			session: options.session,
		};
		this.client = new RpcClient({
			command: options.command,
			commandArgs: options.commandArgs,
			cwd: options.cwd,
			args: options.args,
		});
	}

	get controllable(): boolean {
		return !this.disposed;
	}

	get snapshot(): SubagentRunSnapshot {
		const result = this.result;
		return {
			runId: result.runId ?? this.options.runId,
			agentId: result.agentId ?? this.options.agentId,
			agent: result.agent,
			agentSource: result.agentSource,
			task: result.task,
			state: result.state ?? "queued",
			currentAction: result.currentAction,
			startedAt: result.startedAt ?? 0,
			updatedAt: result.updatedAt ?? 0,
			elapsedMs: result.elapsedMs ?? 0,
			events: (result.events ?? []).map((event) => ({ ...event })),
			controllable: this.controllable,
			session: result.session ? { ...result.session } : undefined,
		};
	}

	get active(): boolean {
		return this.isActive();
	}

	subscribe(listener: (event: SubagentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	async getMessages(): Promise<AgentMessage[]> {
		this.assertAvailable();
		return await this.client.getMessages();
	}

	async start(signal?: AbortSignal): Promise<SingleResult> {
		if (this.started) throw new Error(t("subagent.error.controllerStarted"));
		this.started = true;
		this.unsubscribeEvent = this.client.onEvent((event) => this.handleEvent(event));
		this.unsubscribeExit = this.client.onExit((error) => this.fail(error));
		this.bindAbortSignal(signal);

		try {
			await this.client.start();
			if (!this.options.session && this.options.parentSessionFile) {
				await this.client.newSession(this.options.parentSessionFile);
			}
			const state = await this.client.getState();
			if (!state.sessionFile) throw new Error(t("subagent.error.sessionMissing", { agentId: this.options.agentId }));
			this.result.session = {
				version: 1,
				sessionId: state.sessionId,
				sessionFile: state.sessionFile,
				parentSessionFile: this.options.parentSessionFile ?? this.options.session?.parentSessionFile,
				cwd: this.options.cwd,
				createdAt: this.options.session?.createdAt ?? Date.now(),
			};
			this.updateState("running", "session_ready");
			const settled = this.waitForSettled();
			await this.client.prompt(this.options.task);
			return await settled;
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			return this.result;
		}
	}

	async steer(message: string): Promise<void> {
		this.assertAvailable();
		if (!this.isActive())
			throw new Error(t("subagent.error.alreadySettledFollowUp", { agentId: this.options.agentId }));
		await this.client.steer(message);
		this.updateState("running", "steer");
	}

	async followUp(message: string): Promise<SingleResult> {
		return await this.prompt(message);
	}

	async prompt(message: string): Promise<SingleResult> {
		this.assertAvailable();
		if (this.isActive()) throw new Error(t("subagent.error.stillActiveSteer", { agentId: this.options.agentId }));
		this.clearRetention();
		const settled = this.waitForSettled();
		this.updateState("running", "prompt");
		try {
			await this.client.prompt(message);
			return await settled;
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			return this.result;
		}
	}

	async abort(): Promise<void> {
		this.assertAvailable();
		if (!this.isActive()) throw new Error(t("subagent.error.alreadySettled", { agentId: this.options.agentId }));
		this.clearRetention();
		this.updateState("cancelled", "abort");
		try {
			const settled = this.waitForSettled();
			await this.client.abort();
			await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 2000))]);
		} finally {
			await this.dispose();
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.clearRetention();
		this.clearScheduledUpdate();
		this.removeAbortListener?.();
		this.removeAbortListener = null;
		this.unsubscribeEvent?.();
		this.unsubscribeEvent = null;
		this.unsubscribeExit?.();
		this.unsubscribeExit = null;
		await this.client.stop();
		this.result.stderr = this.client.getStderr();
		await this.options.cleanup?.();
		this.options.onDisposed?.();
	}

	private assertAvailable(): void {
		if (this.disposed) throw new Error(t("subagent.error.notAvailable", { agentId: this.options.agentId }));
	}

	private isActive(): boolean {
		const state = this.result.state ?? "queued";
		return state === "queued" || state === "running" || state === "waiting";
	}

	private bindAbortSignal(signal?: AbortSignal): void {
		if (!signal) return;
		const onAbort = () => void this.abort();
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			this.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	private waitForSettled(): Promise<SingleResult> {
		if (this.settledPromise) return this.settledPromise;
		this.settledPromise = new Promise<SingleResult>((resolve, reject) => {
			this.settleResolve = resolve;
			this.settleReject = reject;
		});
		return this.settledPromise;
	}

	private handleEvent(event: SubagentSessionEvent): void {
		for (const listener of this.eventListeners) listener(event);
		switch (event.type) {
			case "agent_start":
				this.updateState("running", "agent_started");
				break;
			case "message_end":
				this.recordMessage(event.message as Message);
				break;
			case "tool_result_end":
				this.recordMessage(event.message);
				break;
			case "tool_execution_start":
				this.result.currentAction = formatCurrentAction(event.toolName, event.args);
				this.updateState("running", `tool:${event.toolName}`);
				this.flushUpdate();
				break;
			case "tool_execution_end":
				this.result.currentAction = undefined;
				this.updateState("running", `tool_finished:${event.toolName}`);
				break;
			case "queue_update":
				this.updateState(event.steering.length + event.followUp.length > 0 ? "waiting" : "running", "queue_update");
				break;
			case "agent_end":
				if (event.willRetry) this.updateState("waiting", "retrying");
				break;
			case "agent_settled":
				this.settle();
				break;
		}
	}

	private recordMessage(message: Message): void {
		this.result.messages ??= [];
		this.result.messages.push(message);
		if (message.role === "assistant") {
			this.result.usage.turns++;
			const usage = message.usage;
			if (usage) {
				this.result.usage.input += usage.input || 0;
				this.result.usage.output += usage.output || 0;
				this.result.usage.cacheRead += usage.cacheRead || 0;
				this.result.usage.cacheWrite += usage.cacheWrite || 0;
				this.result.usage.cost += usage.cost?.total || 0;
				this.result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!this.result.model && message.model) this.result.model = message.model;
			if (message.stopReason) this.result.stopReason = message.stopReason;
			if (message.errorMessage) this.result.errorMessage = message.errorMessage;
			this.result.finalOutput = getFinalOutput(this.result.messages);
		}
		this.updateState(this.result.state ?? "running", "message_end");
	}

	private settle(): void {
		const state: AgentRunState =
			this.result.state === "cancelled" || this.result.stopReason === "aborted"
				? "cancelled"
				: this.result.stopReason === "error"
					? "failed"
					: "succeeded";
		this.result.exitCode = state === "succeeded" ? 0 : 1;
		this.updateState(state, "agent_settled");
		this.flushUpdate();
		this.settleResolve?.(this.result);
		this.settledPromise = null;
		this.settleResolve = null;
		this.settleReject = null;
		this.removeAbortListener?.();
		this.removeAbortListener = null;
		this.scheduleRetention();
	}

	private fail(error: Error): void {
		if (this.disposed) return;
		this.result.exitCode = 1;
		this.result.errorMessage = error.message;
		this.result.stderr = this.client.getStderr();
		this.updateState("failed", "process_exit");
		this.flushUpdate();
		this.settleReject?.(error);
		this.settledPromise = null;
		this.settleResolve = null;
		this.settleReject = null;
		void this.dispose();
	}

	private updateState(state: AgentRunState, eventType: string): void {
		const now = Date.now();
		this.result.state = state;
		this.result.updatedAt = now;
		this.result.elapsedMs = now - (this.result.startedAt ?? now);
		let events = this.result.events;
		if (!events) {
			events = [];
			this.result.events = events;
		}
		events.push({ type: eventType, at: now, text: this.result.currentAction });
		if (events.length > 20) events.splice(0, events.length - 20);
		this.scheduleUpdate();
	}

	private scheduleUpdate(): void {
		if (this.updateTimer || !this.options.onUpdate) return;
		this.updateTimer = setTimeout(() => {
			this.updateTimer = null;
			if (!this.disposed) this.options.onUpdate?.();
		}, 16);
		this.updateTimer.unref();
	}

	private flushUpdate(): void {
		if (!this.options.onUpdate) return;
		this.clearScheduledUpdate();
		this.options.onUpdate();
	}

	private clearScheduledUpdate(): void {
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.updateTimer = null;
	}

	private scheduleRetention(): void {
		this.clearRetention();
		this.retentionTimer = setTimeout(() => void this.dispose(), SUBAGENT_RETENTION_MS);
	}

	private clearRetention(): void {
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		this.retentionTimer = null;
	}
}

class SubagentRunRegistry {
	private readonly controllers = new Map<string, SubagentRunController>();

	add(controller: SubagentRunController): void {
		this.controllers.set(controller.result.agentId!, controller);
	}

	get(agentId: string): SubagentRunController | undefined {
		return this.controllers.get(agentId);
	}

	snapshots(): SubagentRunSnapshot[] {
		return [...this.controllers.values()].map((controller) => controller.snapshot);
	}

	remove(agentId: string): void {
		this.controllers.delete(agentId);
	}

	async disposeAll(): Promise<void> {
		await Promise.all([...this.controllers.values()].map((controller) => controller.dispose()));
		this.controllers.clear();
	}
}

let currentSubagentRunRegistry: SubagentRunRegistry | null = null;

function getCurrentSubagentController(agentId: string): SubagentRunController {
	if (!currentSubagentRunRegistry) throw new Error(t("subagent.error.noActiveRegistry"));
	const controller = currentSubagentRunRegistry.get(agentId);
	if (!controller) throw new Error(t("subagent.error.notAvailable", { agentId }));
	return controller;
}

/** Returns copied snapshots so callers cannot mutate the live run registry. */
export function getCurrentSubagentRuns(): SubagentRunSnapshot[] {
	return currentSubagentRunRegistry?.snapshots() ?? [];
}

export async function steerSubagent(agentId: string, message: string): Promise<void> {
	await getCurrentSubagentController(agentId).steer(message);
}

export async function followUpSubagent(agentId: string, message: string): Promise<SingleResult> {
	return await getCurrentSubagentController(agentId).followUp(message);
}

export async function promptSubagent(agentId: string, message: string): Promise<SingleResult> {
	return await getCurrentSubagentController(agentId).prompt(message);
}

export async function abortSubagent(agentId: string): Promise<void> {
	await getCurrentSubagentController(agentId).abort();
}

export function subscribeSubagent(
	agentId: string,
	listener: (event: SubagentSessionEvent) => void,
): (() => void) | undefined {
	return currentSubagentRunRegistry?.get(agentId)?.subscribe(listener);
}

export async function getLiveSubagentMessages(agentId: string): Promise<AgentMessage[] | undefined> {
	const controller = currentSubagentRunRegistry?.get(agentId);
	return controller ? await controller.getMessages() : undefined;
}

async function prepareAgentLaunch(
	agent: AgentConfig,
	resumeSessionFile?: string,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
	const args = ["--no-extensions", "--exclude-tools", "subagent"];
	if (resumeSessionFile) args.push("--session", resumeSessionFile);
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let temporaryPrompt: { dir: string; filePath: string } | undefined;
	if (agent.systemPrompt.trim()) {
		temporaryPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt);
		args.push("--append-system-prompt", temporaryPrompt.filePath);
	}
	return {
		args,
		cleanup: async () => {
			if (temporaryPrompt) await fs.promises.rm(temporaryPrompt.dir, { recursive: true, force: true });
		},
	};
}

export async function continueSubagentSession(descriptor: SubagentSessionDescriptor, message: string): Promise<void> {
	const current = currentSubagentRunRegistry?.get(descriptor.agentId);
	if (current) {
		if (current.active) await current.steer(message);
		else void current.prompt(message);
		return;
	}
	if (!currentSubagentRunRegistry) throw new Error(t("subagent.error.noActiveRegistry"));

	const agent = discoverAgents(descriptor.session.cwd, descriptor.agentScope).agents.find(
		(candidate) => candidate.name === descriptor.agent && candidate.source === descriptor.agentSource,
	);
	if (!agent) {
		throw new Error(
			t("subagent.error.definitionUnavailable", {
				agent: descriptor.agent,
				source: formatSubagentSource(descriptor.agentSource),
			}),
		);
	}
	const launch = await prepareAgentLaunch(agent, descriptor.session.sessionFile);
	const invocation = getPiInvocation();
	const controller = new SubagentRunController({
		runId: descriptor.agentId.split(":", 1)[0] ?? descriptor.agentId,
		agentId: descriptor.agentId,
		agent,
		task: message,
		cwd: descriptor.session.cwd,
		args: launch.args,
		command: invocation.command,
		commandArgs: invocation.commandArgs,
		session: descriptor.session,
		onDisposed: () => currentSubagentRunRegistry?.remove(descriptor.agentId),
		cleanup: launch.cleanup,
	});
	currentSubagentRunRegistry.add(controller);
	void controller.start();
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	registry: SubagentRunRegistry,
	runId: string,
	agentId: string,
	parentSessionFile: string | undefined,
): Promise<SingleResult> {
	const agent = agents.find((candidate) => candidate.name === agentName);

	if (!agent) {
		const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "无";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: t("subagent.error.unknownAgent", { agent: agentName, agents: available }),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			runId,
			agentId,
			state: "failed",
			updatedAt: Date.now(),
		};
	}

	const launch = await prepareAgentLaunch(agent);
	const invocation = getPiInvocation();
	let controller: SubagentRunController;
	controller = new SubagentRunController({
		runId,
		agentId,
		agent,
		task,
		cwd: cwd ?? defaultCwd,
		args: launch.args,
		command: invocation.command,
		commandArgs: invocation.commandArgs,
		parentSessionFile,
		step,
		onUpdate: () => {
			onUpdate?.({
				content: [
					{ type: "text", text: getFinalOutput(controller.result.messages ?? []) || t("subagent.output.running") },
				],
				details: makeDetails([controller.result]),
			});
		},
		onDisposed: () => registry.remove(agentId),
		cleanup: launch.cleanup,
	});
	registry.add(controller);
	return controller.start(signal);
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const registry = new SubagentRunRegistry();
	currentSubagentRunRegistry = registry;
	const disposeRegistry = async () => {
		await registry.disposeAll();
		if (currentSubagentRunRegistry === registry) currentSubagentRunRegistry = null;
	};
	pi.on("session_before_switch", disposeRegistry);
	pi.on("session_shutdown", disposeRegistry);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (built-in agents plus ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		prepareArguments(args) {
			if (!args || typeof args !== "object") return {};

			const input = args as Record<string, unknown>;
			const common = {
				agentScope: input.agentScope,
				confirmProjectAgents: input.confirmProjectAgents,
			};

			if (Array.isArray(input.chain) && input.chain.length > 0) {
				return { ...common, chain: input.chain } as Static<typeof SubagentParams>;
			}
			if (Array.isArray(input.tasks) && input.tasks.length > 0) {
				return { ...common, tasks: input.tasks } as Static<typeof SubagentParams>;
			}
			return {
				...common,
				agent: input.agent,
				task: input.task,
				cwd: input.cwd,
			} as Static<typeof SubagentParams>;
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const runId = randomUUID();
			const parentSessionFile = ctx.sessionManager.getSessionFile();

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					runId,
					results: results.map(serializeResult),
				});

			if (modeCount !== 1) {
				const available = formatAvailableAgents(agents);
				return {
					content: [
						{
							type: "text",
							text: `${t("subagent.error.invalidMode")}\n${t("subagent.error.availableAgents", { agents: available })}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? t("subagent.source.unknown");
					const ok = await ctx.ui.confirm(
						t("subagent.confirm.projectTitle"),
						t("subagent.confirm.projectMessage", { agents: names, source: dir }),
					);
					if (!ok)
						return {
							content: [{ type: "text", text: t("subagent.error.projectNotApproved") }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						registry,
						runId,
						`${runId}:${i + 1}`,
						parentSessionFile,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: t("subagent.error.chainStopped", {
										step: i + 1,
										agent: step.agent,
										error: truncateOutput(errorMsg),
									}),
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = truncateOutput(getFinalOutput(result.messages ?? []));
				}
				return {
					content: [{ type: "text", text: previousOutput || t("subagent.output.empty") }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: t("subagent.error.tooManyParallel", {
									count: params.tasks.length,
									max: MAX_PARALLEL_TASKS,
								}),
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						runId,
						agentId: `${runId}:${i + 1}`,
						state: "queued",
						updatedAt: Date.now(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: t("subagent.progress.parallel", {
										done,
										total: allResults.length,
										running,
									}),
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						registry,
						runId,
						`${runId}:${index + 1}`,
						parentSessionFile,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `${t("subagent.result.failed")}${r.stopReason && r.stopReason !== "end" ? `（${r.stopReason}）` : ""}`
						: t("subagent.result.completed");
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `${t("subagent.result.parallel", {
								success: successCount,
								total: results.length,
							})}\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount !== results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					registry,
					runId,
					`${runId}:1`,
					parentSessionFile,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: t("subagent.error.agentFailed", {
									reason: result.stopReason || t("subagent.result.failed"),
									error: truncateOutput(errorMsg),
								}),
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: truncateOutput(getFinalOutput(result.messages ?? [])) || t("subagent.output.empty"),
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = formatAvailableAgents(agents);
			return {
				content: [
					{
						type: "text",
						text: `${t("subagent.error.invalidMode")}\n${t("subagent.error.availableAgents", { agents: available })}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const details = context.resultDetails as Partial<SubagentDetails> | undefined;
			const mode = details?.mode ?? (args.chain?.length ? "chain" : args.tasks?.length ? "parallel" : "single");
			const requestedCount =
				mode === "chain"
					? (args.chain?.length ?? 0)
					: mode === "parallel"
						? (args.tasks?.length ?? 0)
						: args.agent
							? 1
							: 0;
			const count =
				Array.isArray(details?.results) && details.results.length > 0 ? details.results.length : requestedCount;
			const completed = details?.results?.filter((result) =>
				["completed", "failed", "cancelled"].includes(result.state ?? ""),
			).length;
			const failed = details?.results?.filter((result) => result.state === "failed").length ?? 0;
			const progress = context.isError
				? "执行失败"
				: context.isPartial
					? `运行中 ${completed ?? 0}/${count}`
					: failed > 0
						? `完成 · ${failed} 个失败`
						: "已完成";
			const summary = getToolSummary(context.lastComponent);
			summary.setText(
				`${theme.fg("toolTitle", uiGlyphs.tool)} ${theme.bold(t("subagent.title"))} · ${theme.fg("accent", formatSubagentMode(mode))}${theme.fg("muted", ` · ${count} 个 Agent · ${formatSubagentScope(scope)} · ${progress}`)}`,
			);
			return summary;
		},

		renderResult(result, _options, _theme, context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : t("subagent.output.empty"), 0, 0);
			}
			const component =
				context.lastComponent instanceof SubagentResultComponent
					? context.lastComponent
					: new SubagentResultComponent(details);
			component.setDetails(details);
			component.setVisible(context.expanded || context.isError);
			return component;
		},
	});
}
