import type { LiveTurnItem } from "../../state/use-workbench";
import { Shimmer } from "../ai-elements/shimmer";

export const THINKING_SHIMMER_HEIGHT = 32;

export function latestThinkingLine(parts: readonly string[]): string {
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

export function activeThinkingText(items: readonly LiveTurnItem[]): string {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item || item.kind === "user") continue;
		return item.kind === "thinking" ? latestThinkingLine(item.parts) : "";
	}
	return "";
}

export function ThinkingBlock({ text }: { text: string }) {
	const thinkingLine = latestThinkingLine([text]);
	return (
		<div
			className="px-1 py-1 text-sm text-muted-foreground"
			style={{ height: THINKING_SHIMMER_HEIGHT }}
			aria-live="polite"
			role="status"
		>
			{thinkingLine ? (
				<Shimmer as="span" className="block truncate text-sm font-normal">
					{thinkingLine}
				</Shimmer>
			) : null}
		</div>
	);
}
