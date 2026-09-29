import { availableParallelism, totalmem } from "node:os";

export const AUTO_RUNTIME_READ_CONCURRENCY = 0;
export const MIN_RUNTIME_READ_CONCURRENCY = 2;
export const MAX_RUNTIME_READ_CONCURRENCY = 16;

type RuntimeReadConcurrencyFacts = {
	cpuCores: number;
	totalMemoryBytes: number;
};

export type RuntimeReadConcurrency = RuntimeReadConcurrencyFacts & {
	configured: number;
	suggested: number;
	effective: number;
	source: "auto" | "manual";
};

function boundedInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getRuntimeReadConcurrencyFacts(): RuntimeReadConcurrencyFacts {
	return {
		cpuCores: Math.max(1, availableParallelism()),
		totalMemoryBytes: Math.max(0, totalmem()),
	};
}

export function suggestRuntimeReadConcurrency(facts: RuntimeReadConcurrencyFacts): number {
	const cpuLimit = boundedInteger(facts.cpuCores / 2, MIN_RUNTIME_READ_CONCURRENCY, 8);
	const memoryLimit =
		facts.totalMemoryBytes < 8 * 1024 ** 3
			? 2
			: facts.totalMemoryBytes < 16 * 1024 ** 3
				? 3
				: facts.totalMemoryBytes < 32 * 1024 ** 3
					? 4
					: 6;
	return boundedInteger(Math.min(cpuLimit, memoryLimit), MIN_RUNTIME_READ_CONCURRENCY, 8);
}

export function resolveRuntimeReadConcurrency(
	configured: number,
	facts = getRuntimeReadConcurrencyFacts(),
): RuntimeReadConcurrency {
	const normalizedConfigured =
		configured === AUTO_RUNTIME_READ_CONCURRENCY
			? AUTO_RUNTIME_READ_CONCURRENCY
			: Number.isInteger(configured) && configured >= MIN_RUNTIME_READ_CONCURRENCY
				? Math.min(configured, MAX_RUNTIME_READ_CONCURRENCY)
				: AUTO_RUNTIME_READ_CONCURRENCY;
	const suggested = suggestRuntimeReadConcurrency(facts);
	return {
		...facts,
		configured: normalizedConfigured,
		suggested,
		effective: normalizedConfigured === AUTO_RUNTIME_READ_CONCURRENCY ? suggested : normalizedConfigured,
		source: normalizedConfigured === AUTO_RUNTIME_READ_CONCURRENCY ? "auto" : "manual",
	};
}
