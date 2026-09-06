import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	type CreateToolRecoveryLessonInput,
	createToolRecoveryLesson,
	disableToolRecoveryLesson,
	getToolRecoveryLesson,
	listToolRecoveryLessons,
	type ToolRecoveryLesson,
	type ToolRecoveryLessonAction,
	type ToolRecoveryLessonScope,
	type UpdateToolRecoveryLessonInput,
	updateToolRecoveryLesson,
} from "./lessons-store.ts";

export interface ToolRecoveryRefinerFailure {
	toolName: string;
	code: string;
	category: string;
	fingerprint: string;
	action: string;
	outcome: string;
	targetHash?: string;
}

export interface ToolRecoveryRefinerInput {
	scopeHash: string;
	failures: readonly ToolRecoveryRefinerFailure[];
	relatedLessons: ReadonlyArray<{
		id: string;
		status: ToolRecoveryLesson["status"];
		scope: ToolRecoveryLessonScope;
		toolName: string;
		failureCode: string;
		fingerprintPrefix?: string;
		guidance: string;
	}>;
	userCorrections: readonly string[];
	signal?: AbortSignal;
}

export type ToolRecoveryRefiner = (input: ToolRecoveryRefinerInput) => Promise<unknown> | unknown;

export interface ModelBackedToolRecoveryRefinerOptions {
	getModel: () => Model<any> | undefined;
	complete: (model: Model<any>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;
}

const MODEL_REFINER_SYSTEM_PROMPT = `你是 LYStar Code 的错题本提炼器。只根据给定的结构化恢复案例和已有经验，提出一个最小、可验证的恢复经验变更。
不要执行工具，不要修改源代码、系统提示、AGENTS 或权限。没有足够证据时返回 {"type":"none"}。
默认只能创建 project scope 的 guidance 经验；不得创建 safe_refresh，不得编造恢复成功，不得包含路径、URL、密钥、令牌、原始错误输出或用户原话。
只返回 JSON：
{"type":"none"}
或 {"type":"create","scope":"project","matcher":{"toolName":"...","failureCode":"...","fingerprintPrefix":"..."},"guidance":"...","allowedAction":"guidance","expiresAt":"2030-01-01T00:00:00.000Z"}
或 {"type":"update","id":"...","expectedVersion":1,"input":{"guidance":"..."}}
或 {"type":"disable","id":"...","expectedVersion":1}`;

function extractJson(text: string): unknown {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/iu, "")
		.replace(/\s*```$/u, "");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return undefined;
		}
	}
}

export function createModelBackedToolRecoveryRefiner(
	options: ModelBackedToolRecoveryRefinerOptions,
): ToolRecoveryRefiner {
	return async (input) => {
		const model = options.getModel();
		if (!model) return undefined;
		const compactInput = JSON.stringify({
			failures: input.failures.slice(0, 3),
			relatedLessons: input.relatedLessons.slice(0, 3),
			userCorrections: input.userCorrections.slice(0, 3),
		});
		const response = await options.complete(
			model,
			{
				systemPrompt: MODEL_REFINER_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: compactInput.slice(0, 16_000) }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: 1_000, signal: input.signal },
		);
		const text = response.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		const proposal = extractJson(text);
		return proposal;
	};
}

type RefinerNoneProposal = { type: "none" };
type RefinerCreateProposal = {
	type: "create";
	scope: ToolRecoveryLessonScope;
	matcher: CreateToolRecoveryLessonInput["matcher"];
	guidance: string;
	allowedAction: ToolRecoveryLessonAction;
	expiresAt: string;
};
type RefinerUpdateProposal = {
	type: "update";
	id: string;
	expectedVersion: number;
	input: UpdateToolRecoveryLessonInput;
};
type RefinerDisableProposal = { type: "disable"; id: string; expectedVersion: number };
export type ToolRecoveryRefinerProposal =
	| RefinerNoneProposal
	| RefinerCreateProposal
	| RefinerUpdateProposal
	| RefinerDisableProposal;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 240 &&
		!/(?:api[_ -]?key|oauth|access[_ -]?token|secret|cookie|authorization|https?:\/\/|[A-Za-z]:[\\/]|(?:^|[\s"'`])(?:~\/|\/[^\s]+))/iu.test(
			value,
		)
	);
}

function isCreateProposal(value: Record<string, unknown>): value is RefinerCreateProposal {
	return (
		value.type === "create" &&
		hasOnlyKeys(value, ["type", "scope", "matcher", "guidance", "allowedAction", "expiresAt"]) &&
		value.scope === "project" &&
		isRecord(value.matcher) &&
		isSafeText(value.guidance) &&
		value.allowedAction === "guidance" &&
		typeof value.expiresAt === "string"
	);
}

function isUpdateProposal(value: Record<string, unknown>): value is RefinerUpdateProposal {
	if (
		value.type !== "update" ||
		!hasOnlyKeys(value, ["type", "id", "expectedVersion", "input"]) ||
		typeof value.id !== "string" ||
		!isPositiveInteger(value.expectedVersion) ||
		!isRecord(value.input) ||
		!hasOnlyKeys(value.input, ["matcher", "guidance", "expiresAt"])
	) {
		return false;
	}
	return value.input.guidance === undefined || isSafeText(value.input.guidance);
}

function isDisableProposal(value: Record<string, unknown>): value is RefinerDisableProposal {
	return (
		value.type === "disable" &&
		hasOnlyKeys(value, ["type", "id", "expectedVersion"]) &&
		typeof value.id === "string" &&
		isPositiveInteger(value.expectedVersion)
	);
}

/** Refiner 输出只允许候选的 create/update/disable，不能改变恢复执行或审批路径。 */
export function parseToolRecoveryRefinerProposal(value: unknown): ToolRecoveryRefinerProposal | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "none" && hasOnlyKeys(value, ["type"])) return value as RefinerNoneProposal;
	if (isCreateProposal(value) || isUpdateProposal(value) || isDisableProposal(value)) return value;
	return undefined;
}

/** Store 会再次执行完整 schema、隐私和版本校验；refiner 没有 Tool 执行入口。 */
export async function applyToolRecoveryRefinerProposal(
	agentDir: string,
	scopeHash: string,
	proposal: ToolRecoveryRefinerProposal,
): Promise<ToolRecoveryLesson | undefined> {
	if (proposal.type === "none") return undefined;
	if (proposal.type === "create") {
		if (proposal.scope !== "project" || proposal.allowedAction !== "guidance") return undefined;
		return await createToolRecoveryLesson(
			agentDir,
			{
				scope: proposal.scope,
				...(proposal.scope === "project" ? { scopeHash } : {}),
				matcher: proposal.matcher,
				guidance: proposal.guidance,
				allowedAction: proposal.allowedAction,
				expiresAt: proposal.expiresAt,
			},
			{ source: "refiner" },
		);
	}

	const current = await getToolRecoveryLesson(agentDir, proposal.id);
	if (current.status !== "candidate") return undefined;
	if (proposal.type === "disable") {
		return await disableToolRecoveryLesson(agentDir, proposal.id, proposal.expectedVersion, { source: "refiner" });
	}
	return await updateToolRecoveryLesson(agentDir, proposal.id, proposal.expectedVersion, proposal.input, {
		source: "refiner",
	});
}

export function sanitizeToolRecoveryUserCorrections(values: readonly string[] | undefined): string[] {
	if (!values) return [];
	return values.filter(isSafeText).map((value) => value.trim());
}

export async function findToolRecoveryRefinerLessons(
	agentDir: string,
	scopeHash: string,
	failures: readonly ToolRecoveryRefinerFailure[],
): Promise<ToolRecoveryRefinerInput["relatedLessons"]> {
	const matches = (await listToolRecoveryLessons(agentDir)).filter(
		(lesson) =>
			lesson.status !== "expired" &&
			(lesson.scope === "global" || lesson.scopeHash === scopeHash) &&
			failures.some(
				(failure) =>
					failure.toolName === lesson.matcher.toolName &&
					failure.code === lesson.matcher.failureCode &&
					(lesson.matcher.fingerprintPrefix === undefined ||
						failure.fingerprint.startsWith(lesson.matcher.fingerprintPrefix)),
			),
	);
	return matches.slice(0, 3).map((lesson) => ({
		id: lesson.id,
		status: lesson.status,
		scope: lesson.scope,
		toolName: lesson.matcher.toolName,
		failureCode: lesson.matcher.failureCode,
		...(lesson.matcher.fingerprintPrefix ? { fingerprintPrefix: lesson.matcher.fingerprintPrefix } : {}),
		guidance: lesson.guidance,
	}));
}
