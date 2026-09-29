type OutputSpeedSample = { outputTokens: number; elapsedMs: number };

export function visibleOutputTokens(
	outputTokens: number | undefined,
	reasoningTokens: number | undefined,
): number | undefined {
	if (outputTokens === undefined) return undefined;
	return Math.max(0, outputTokens - (reasoningTokens ?? 0));
}

export class OutputSpeedTracker {
	private firstOutputAt?: number;

	start(): void {
		this.firstOutputAt = undefined;
	}

	outputDelta(now = performance.now()): void {
		this.firstOutputAt ??= now;
	}

	finish(
		outputTokens: number | undefined,
		stopReason: string | undefined,
		now = performance.now(),
	): OutputSpeedSample | undefined {
		const firstOutputAt = this.firstOutputAt;
		this.firstOutputAt = undefined;
		if (firstOutputAt === undefined || !outputTokens || outputTokens <= 0 || stopReason === "error") return undefined;
		return { outputTokens, elapsedMs: Math.max(1, Math.round(now - firstOutputAt)) };
	}
}
