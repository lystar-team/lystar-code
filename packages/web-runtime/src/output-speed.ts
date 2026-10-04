import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { UsageProgress } from "@lystar/code-web-protocol";

type OutputSpeedSample = { outputTokens: number; elapsedMs: number };
const OUTPUT_SPEED_SAMPLE_MS = 250;

export function visibleOutputTokens(
	outputTokens: number | undefined,
	reasoningTokens: number | undefined,
): number | undefined {
	if (outputTokens === undefined) return undefined;
	return Math.max(0, outputTokens - (reasoningTokens ?? 0));
}

export class OutputSpeedTracker {
	private firstOutputAt?: number;
	private lastSampleAt?: number;
	private outputText = "";

	start(): void {
		this.firstOutputAt = undefined;
		this.lastSampleAt = undefined;
		this.outputText = "";
	}

	outputDelta(now = performance.now()): void {
		this.firstOutputAt ??= now;
	}

	update(text: string, now = performance.now()): UsageProgress["outputSpeed"] {
		if (!text) return undefined;
		this.outputDelta(now);
		this.outputText += text;
		const firstOutputAt = this.firstOutputAt!;
		if (now - (this.lastSampleAt ?? firstOutputAt) < OUTPUT_SPEED_SAMPLE_MS) return undefined;
		this.lastSampleAt = now;
		return {
			outputTokens: estimateTextTokens(this.outputText),
			elapsedMs: Math.max(1, Math.round(now - firstOutputAt)),
			estimated: true,
			streaming: true,
		};
	}

	finish(
		outputTokens: number | undefined,
		stopReason: string | undefined,
		now = performance.now(),
	): OutputSpeedSample | undefined {
		const firstOutputAt = this.firstOutputAt;
		this.start();
		if (
			firstOutputAt === undefined ||
			!outputTokens ||
			outputTokens <= 0 ||
			stopReason === "error" ||
			stopReason === "aborted"
		)
			return undefined;
		return { outputTokens, elapsedMs: Math.max(1, Math.round(now - firstOutputAt)) };
	}
}
