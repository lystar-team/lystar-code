import { type JsonValue, RUNTIME_MAX_FRAME_LENGTH } from "@lystar/code-web-protocol";

const TRANSCRIPT_PAGE_BYTE_BUDGET = RUNTIME_MAX_FRAME_LENGTH / 2;

export async function readTranscriptPageWithinFrameBudget(
	limit: number,
	readPage: (limit: number) => Promise<unknown>,
): Promise<JsonValue> {
	let pageLimit = limit;
	while (true) {
		const serialized = JSON.stringify(await readPage(pageLimit));
		const bytes = Buffer.byteLength(serialized);
		if (bytes <= TRANSCRIPT_PAGE_BYTE_BUDGET || pageLimit === 1) {
			if (bytes >= RUNTIME_MAX_FRAME_LENGTH) throw new Error("单条历史记录超过 Runtime 响应大小上限");
			return JSON.parse(serialized) as JsonValue;
		}
		pageLimit = Math.max(1, Math.floor(pageLimit / 2));
	}
}
