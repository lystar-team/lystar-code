import { Shimmer } from "../ai-elements/shimmer";

function latestThinkingLine(parts: readonly string[]): string {
	let line = "";
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index] ?? "";
		const newline = part.lastIndexOf("\n");
		line = newline >= 0 ? part.slice(newline + 1) + line : part + line;
		if (newline >= 0 || line.length >= 2048) break;
	}
	return line
		.slice(-2048)
		.trim()
		.replace(/\*\*\s*(.*?)\s*\*\*/gu, "$1")
		.replace(/__\s*(.*?)\s*__/gu, "$1");
}

export function ThinkingBlock({ text }: { text: string }) {
	const thinkingLine = latestThinkingLine([text]);
	if (!thinkingLine) return null;
	return (
		<div className="min-h-8 px-1 py-1 text-sm text-muted-foreground" aria-live="polite" role="status">
			<Shimmer as="span" className="block truncate text-sm font-normal">
				{thinkingLine}
			</Shimmer>
		</div>
	);
}
