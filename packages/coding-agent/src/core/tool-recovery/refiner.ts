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
	code: string;
	category: string;
	fingerprint: string;
	action: string;
	outcome: string;
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
}

export type ToolRecoveryRefiner = (input: ToolRecoveryRefinerInput) => Promise<unknown> | unknown;

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
export type ToolRecoveryRefinerProposal = RefinerCreateProposal | RefinerUpdateProposal | RefinerDisableProposal;

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
		(value.scope === "project" || value.scope === "global") &&
		isRecord(value.matcher) &&
		isSafeText(value.guidance) &&
		(value.allowedAction === "guidance" || value.allowedAction === "safe_refresh") &&
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
		!hasOnlyKeys(value.input, ["matcher", "guidance", "allowedAction", "expiresAt"])
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
	if (isCreateProposal(value) || isUpdateProposal(value) || isDisableProposal(value)) return value;
	return undefined;
}

/** Store 会再次执行完整 schema、隐私和版本校验；refiner 没有 Tool 执行入口。 */
export async function applyToolRecoveryRefinerProposal(
	agentDir: string,
	scopeHash: string,
	proposal: ToolRecoveryRefinerProposal,
): Promise<ToolRecoveryLesson | undefined> {
	if (proposal.type === "create") {
		return await createToolRecoveryLesson(
			agentDir,
			{
				status: "candidate",
				scope: proposal.scope,
				...(proposal.scope === "project" ? { scopeHash } : {}),
				matcher: proposal.matcher,
				guidance: proposal.guidance,
				allowedAction: proposal.allowedAction,
				evidence: { occurrences: 0, sessions: 0, recovered: 0, failed: 0 },
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
	const keys = new Set(failures.map((failure) => `${failure.code}\u0000${failure.fingerprint.slice(0, 16)}`));
	return (await listToolRecoveryLessons(agentDir))
		.filter(
			(lesson) =>
				lesson.status !== "expired" &&
				(lesson.scope === "global" || lesson.scopeHash === scopeHash) &&
				keys.has(`${lesson.matcher.failureCode}\u0000${lesson.matcher.fingerprintPrefix ?? ""}`),
		)
		.slice(0, 3)
		.map((lesson) => ({
			id: lesson.id,
			status: lesson.status,
			scope: lesson.scope,
			toolName: lesson.matcher.toolName,
			failureCode: lesson.matcher.failureCode,
			...(lesson.matcher.fingerprintPrefix ? { fingerprintPrefix: lesson.matcher.fingerprintPrefix } : {}),
			guidance: lesson.guidance,
		}));
}
