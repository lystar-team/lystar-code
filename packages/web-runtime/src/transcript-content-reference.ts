import type { JsonValue } from "@lystar/code-web-protocol";

export type TranscriptTextPart = string | { contentRef: string; previewHead: string };

export function transcriptTextPart(value: JsonValue | undefined): TranscriptTextPart | undefined {
	if (typeof value === "string") return value;
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		value.type === "content_ref" &&
		typeof value.contentRef === "string" &&
		value.contentRef.startsWith("native:") &&
		typeof value.previewHead === "string"
	) {
		return { contentRef: value.contentRef, previewHead: value.previewHead };
	}
	return undefined;
}

/** Keep one reference for the same text grouping used by the TS projection. */
export function joinTranscriptText(
	parts: readonly TranscriptTextPart[],
	separator: string,
): {
	text: string;
	contentRef?: string;
} {
	if (parts.every((part) => typeof part === "string")) return { text: parts.join(separator) };
	const preview = parts.map((part) => (typeof part === "string" ? part : part.previewHead)).join(separator);
	if (parts.length === 1 && typeof parts[0] !== "string") {
		return { text: `${preview.slice(0, 16 * 1024 - 1)}…`, contentRef: parts[0]?.contentRef };
	}
	const joined = parts.flatMap((part, index) => [
		...(index > 0 ? [{ text: separator }] : []),
		typeof part === "string" ? { text: part } : { contentRef: part.contentRef },
	]);
	return {
		text: `${preview.slice(0, 16 * 1024 - 1)}…`,
		contentRef: `native:join:${Buffer.from(JSON.stringify({ parts: joined })).toString("base64url")}`,
	};
}
