import { type JsonValue, RUNTIME_MAX_FRAME_LENGTH } from "@lystar/code-web-protocol";

const TRANSCRIPT_PAGE_BYTE_BUDGET = RUNTIME_MAX_FRAME_LENGTH / 2;
const TRANSCRIPT_RAW_BYTE_BUDGET = RUNTIME_MAX_FRAME_LENGTH / 4;

// 只规范化 JSON 值，不再通过 stringify/parse 复制整页和长字符串。
function normalizeJson(value: unknown): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") throw new TypeError("历史记录包含无法序列化的 BigInt");
	if (typeof value !== "object") return undefined;
	if (value instanceof Date) return value.toJSON();
	if (Array.isArray(value)) return Array.from(value, (item) => normalizeJson(item) ?? null);
	const entries: Array<[string, JsonValue]> = [];
	for (const [key, item] of Object.entries(value)) {
		const normalized = normalizeJson(item);
		if (normalized !== undefined) entries.push([key, normalized]);
	}
	return Object.fromEntries(entries);
}

export async function readTranscriptPageWithinFrameBudget(
	limit: number,
	readPage: (limit: number, byteBudget: number) => Promise<unknown>,
): Promise<JsonValue> {
	let pageLimit = limit;
	while (true) {
		const page = normalizeJson(await readPage(pageLimit, TRANSCRIPT_RAW_BYTE_BUDGET));
		if (page === undefined) throw new TypeError("历史读取没有返回 JSON 值");
		const bytes = Buffer.byteLength(JSON.stringify(page));
		if (bytes <= TRANSCRIPT_PAGE_BYTE_BUDGET || pageLimit === 1) {
			if (bytes >= RUNTIME_MAX_FRAME_LENGTH) throw new Error("单条历史记录超过 Runtime 响应大小上限");
			return page;
		}
		// 由读取器重新计算页边界与游标，不截短 items 后沿用旧游标。
		pageLimit = Math.max(1, Math.floor(pageLimit / 2));
	}
}
