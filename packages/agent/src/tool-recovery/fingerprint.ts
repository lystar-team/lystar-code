const OMIT = Symbol("omit");
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token|private[_-]?key)/i;
const VOLATILE_KEY =
	/(?:timestamp|occurredat|createdat|updatedat|time|pid|processid|requestid|traceid|spanid|nonce|random|uuid|tmpdir|tempdir)/i;
const TARGET_KEY = /(?:target|path|file|filename|directory|dir|url|uri|resource|location)$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTargetKey(key: string | undefined): boolean {
	return key !== undefined && TARGET_KEY.test(key) && !SECRET_KEY.test(key);
}

function normalizeUrl(value: string): string | undefined {
	if (!/^https?:\/\//i.test(value)) return undefined;
	try {
		const url = new URL(value);
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function normalizeTarget(value: string): string {
	return normalizeUrl(value) ?? value;
}

function normalizeString(value: string, key: string | undefined): string {
	if (isTargetKey(key)) return "<target>";
	if (ISO_TIMESTAMP.test(value)) return "<time>";
	if (UUID.test(value)) return "<random-id>";
	if (/^(?:Bearer|Basic)\s+/i.test(value)) return "<secret>";
	if (ABSOLUTE_PATH.test(value)) return "<absolute-path>";
	return normalizeUrl(value) ?? value;
}

function normalizeValue(value: unknown, key: string | undefined, seen: WeakSet<object>): CanonicalValue | typeof OMIT {
	if (key && SECRET_KEY.test(key)) return "<secret>";
	if (key && VOLATILE_KEY.test(key)) return OMIT;
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
	}
	if (typeof value === "string") return normalizeString(value, key);
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return OMIT;
	if (value instanceof Date) return "<time>";
	if (value instanceof Error) return "<error>";
	if (!isRecord(value) && !Array.isArray(value)) return "<unsupported>";
	if (seen.has(value)) return "<circular>";
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => {
				const normalized = normalizeValue(item, undefined, seen);
				return normalized === OMIT ? null : normalized;
			});
		}
		const result: Record<string, CanonicalValue> = {};
		for (const property of Object.keys(value).sort()) {
			const normalized = normalizeValue(value[property], property, seen);
			if (normalized !== OMIT) result[property] = normalized;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

/** 返回去除隐私和易变输入后的稳定 JSON 表示。 */
export function canonicalJson(value: unknown): string {
	const normalized = normalizeValue(value, undefined, new WeakSet<object>());
	return JSON.stringify(normalized === OMIT ? null : normalized);
}

function collectTargets(value: unknown, key: string | undefined, targets: string[], seen: WeakSet<object>): void {
	if (key && SECRET_KEY.test(key)) return;
	if (typeof value === "string" && isTargetKey(key)) {
		targets.push(`${key}:${normalizeTarget(value)}`);
		return;
	}
	if (!isRecord(value) && !Array.isArray(value)) return;
	if (seen.has(value)) return;
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			for (const item of value) collectTargets(item, undefined, targets, seen);
			return;
		}
		for (const property of Object.keys(value).sort()) {
			collectTargets(value[property], property, targets, seen);
		}
	} finally {
		seen.delete(value);
	}
}

export interface ToolCallFingerprint {
	callSignature: string;
	targetHash?: string;
}

export async function createToolCallFingerprint(toolName: string, args: unknown): Promise<ToolCallFingerprint> {
	const targets: string[] = [];
	collectTargets(args, undefined, targets, new WeakSet<object>());
	const targetHash = targets.length > 0 ? await sha256(canonicalJson(targets)) : undefined;
	return {
		callSignature: await sha256(`${toolName}\n${canonicalJson(args)}\n${targetHash ?? ""}`),
		...(targetHash ? { targetHash } : {}),
	};
}

export async function createFailureFingerprint(input: {
	toolName: string;
	toolVersion?: string;
	code: string;
	targetHash?: string;
	constraint?: unknown;
}): Promise<string> {
	return await sha256(
		canonicalJson({
			toolName: input.toolName,
			toolVersion: input.toolVersion,
			code: input.code,
			targetHash: input.targetHash,
			constraint: input.constraint,
		}),
	);
}
