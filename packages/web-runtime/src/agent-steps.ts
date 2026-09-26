import { randomUUID } from "node:crypto";
import type { SessionEntry, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent/core";
import type { AgentStep, AgentStepStatus } from "@lystar/code-web-protocol";
import Type from "typebox";

export const AGENT_STEP_CUSTOM_TYPE = "lystar.web.agent-step";
export const STEP_START_TOOL_NAME = "step_start";
export const STEP_END_TOOL_NAME = "step_end";
export const AGENT_STEP_TOOL_NAMES = new Set([STEP_START_TOOL_NAME, STEP_END_TOOL_NAME]);
const AGENT_STEP_EVENT_LIMIT = 512;

interface PersistedAgentStep {
	version: 1;
	step: AgentStep;
}

function boundedText(value: string | undefined, maximum: number): string | undefined {
	const normalized = value?.replace(/\s+/gu, " ").trim();
	if (!normalized) return undefined;
	return normalized.length <= maximum ? normalized : normalized.slice(0, maximum);
}

function agentStep(value: unknown): AgentStep | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !record.step || typeof record.step !== "object" || Array.isArray(record.step)) {
		return undefined;
	}
	const step = record.step as Record<string, unknown>;
	if (
		typeof step.id !== "string" ||
		typeof step.title !== "string" ||
		!(["running", "completed", "failed", "interrupted"] as const).includes(step.status as AgentStepStatus) ||
		!Array.isArray(step.toolCallIds) ||
		!step.toolCallIds.every((id) => typeof id === "string") ||
		(step.messageEntryIds !== undefined &&
			(!Array.isArray(step.messageEntryIds) || !step.messageEntryIds.every((id) => typeof id === "string"))) ||
		typeof step.startedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: step.id,
		title: step.title,
		status: step.status as AgentStepStatus,
		toolCallIds: step.toolCallIds,
		messageEntryIds: (step.messageEntryIds as string[] | undefined) ?? [],
		startedAt: step.startedAt,
		...(typeof step.endedAt === "number" ? { endedAt: step.endedAt } : {}),
		...(typeof step.summary === "string" ? { summary: step.summary } : {}),
	};
}

export function agentStepFromEntry(entry: SessionEntry): AgentStep | undefined {
	return entry.type === "custom" && entry.customType === AGENT_STEP_CUSTOM_TYPE ? agentStep(entry.data) : undefined;
}

export class AgentStepController {
	private readonly steps = new Map<string, AgentStep>();
	private readonly listeners = new Set<(step: AgentStep) => void>();
	private readonly sessionManager: SessionManager;
	private activeStepId?: string;

	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
		for (const entry of sessionManager.getEntries()) {
			const step = agentStepFromEntry(entry);
			if (!step) continue;
			this.steps.set(step.id, step);
			if (step.status === "running") this.activeStepId = step.id;
			else if (this.activeStepId === step.id) this.activeStepId = undefined;
		}
	}

	onChange(listener: (step: AgentStep) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get activeStep(): AgentStep | undefined {
		return this.activeStepId ? this.steps.get(this.activeStepId) : undefined;
	}

	stepIdForTool(toolCallId: string): string | undefined {
		for (const step of this.steps.values()) {
			if (step.toolCallIds.includes(toolCallId)) return step.id;
		}
		return undefined;
	}

	stepsForEntries(entries: readonly SessionEntry[]): AgentStep[] {
		const entryIds = new Set(entries.map((entry) => entry.id));
		const toolCallIds = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "toolResult") toolCallIds.add(entry.message.toolCallId);
			if (entry.message.role !== "assistant") continue;
			for (const part of entry.message.content) {
				if (part.type === "toolCall") toolCallIds.add(part.id);
			}
		}
		const persistedStepIds = new Set(entries.flatMap((entry) => agentStepFromEntry(entry)?.id ?? []));
		return [...this.steps.values()]
			.filter(
				(step) =>
					step.messageEntryIds?.some((entryId) => entryIds.has(entryId)) ||
					step.toolCallIds.some((toolCallId) => toolCallIds.has(toolCallId)) ||
					persistedStepIds.has(step.id),
			)
			.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
			.slice(-AGENT_STEP_EVENT_LIMIT);
	}

	start(title: string): AgentStep {
		this.finishActive("completed", "进入下一步骤");
		const step: AgentStep = {
			id: randomUUID(),
			title: boundedText(title, 512) ?? "继续处理任务",
			status: "running",
			toolCallIds: [],
			messageEntryIds: [],
			startedAt: Date.now(),
		};
		this.activeStepId = step.id;
		this.persist(step);
		return step;
	}

	associateTool(toolCallId: string): AgentStep | undefined {
		const current = this.activeStep;
		if (current?.toolCallIds.includes(toolCallId)) return current;
		const associatedStepId = this.stepIdForTool(toolCallId);
		if (associatedStepId) return this.steps.get(associatedStepId);
		if (!current) return undefined;
		const step = { ...current, toolCallIds: [...current.toolCallIds, toolCallId] };
		this.persist(step);
		return step;
	}

	associateMessage(messageEntryId: string, stepId = this.activeStepId): AgentStep | undefined {
		const current = stepId ? this.steps.get(stepId) : undefined;
		if (!current || current.messageEntryIds?.includes(messageEntryId)) return current;
		const step = { ...current, messageEntryIds: [...(current.messageEntryIds ?? []), messageEntryId] };
		this.persist(step);
		return step;
	}

	finishActive(status: Exclude<AgentStepStatus, "running">, summary?: string): AgentStep | undefined {
		const current = this.activeStep;
		if (!current) return undefined;
		const step: AgentStep = {
			...current,
			status,
			endedAt: Date.now(),
			...(boundedText(summary, 4096) ? { summary: boundedText(summary, 4096) } : {}),
		};
		this.activeStepId = undefined;
		this.persist(step);
		return step;
	}

	private persist(step: AgentStep): void {
		this.steps.set(step.id, step);
		const data: PersistedAgentStep = { version: 1, step };
		this.sessionManager.appendCustomEntry(AGENT_STEP_CUSTOM_TYPE, data);
		for (const listener of this.listeners) listener(step);
	}
}

const stepStartSchema = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 512, description: "面向用户的简短中文步骤标题" }),
	},
	{ additionalProperties: false },
);

const stepEndSchema = Type.Object(
	{
		summary: Type.Optional(Type.String({ maxLength: 4096, description: "该步骤完成结果的简短中文摘要" })),
	},
	{ additionalProperties: false },
);

export function createAgentStepTools(controller: AgentStepController): ToolDefinition[] {
	return [
		{
			name: STEP_START_TOOL_NAME,
			label: "开始步骤",
			description:
				"开始一个新的执行步骤。处理需要多个工具调用的任务时，在调用普通工具前使用；标题应描述当前目标，不写工具名。",
			promptGuidelines: [
				"处理包含多个操作的任务时，先调用 step_start 创建简短、面向用户的中文步骤标题，再调用完成该步骤所需的普通工具。",
				"同一时间只保留一个活动步骤；切换目标前调用 step_end。完成最后一个步骤后，在最终答复前调用 step_end。",
				"不要在普通回复中解释 step_start 或 step_end，它们只用于组织执行轨迹。",
			],
			parameters: stepStartSchema,
			executionMode: "sequential",
			async execute(_toolCallId, { title }) {
				const step = controller.start(title);
				return { content: [{ type: "text", text: `已开始步骤：${step.title}` }], details: { step } };
			},
		},
		{
			name: STEP_END_TOOL_NAME,
			label: "结束步骤",
			description: "结束当前执行步骤，可记录简短结果摘要。",
			parameters: stepEndSchema,
			executionMode: "sequential",
			async execute(_toolCallId, { summary }) {
				const step = controller.finishActive("completed", summary);
				return {
					content: [{ type: "text", text: step ? `已完成步骤：${step.title}` : "当前没有活动步骤" }],
					details: step ? { step } : undefined,
				};
			},
		},
	];
}
