import { describe, expect, it } from "vitest";
import {
	AUTO_RUNTIME_READ_CONCURRENCY,
	MAX_RUNTIME_READ_CONCURRENCY,
	MIN_RUNTIME_READ_CONCURRENCY,
	resolveRuntimeReadConcurrency,
	suggestRuntimeReadConcurrency,
} from "../src/runtime-read-concurrency.ts";

describe("runtime read concurrency", () => {
	it("limits the automatic suggestion by CPU and memory", () => {
		expect(suggestRuntimeReadConcurrency({ cpuCores: 2, totalMemoryBytes: 32 * 1024 ** 3 })).toBe(2);
		expect(suggestRuntimeReadConcurrency({ cpuCores: 8, totalMemoryBytes: 8 * 1024 ** 3 })).toBe(3);
		expect(suggestRuntimeReadConcurrency({ cpuCores: 32, totalMemoryBytes: 64 * 1024 ** 3 })).toBe(6);
	});

	it("uses the suggestion for automatic mode and preserves a valid manual value", () => {
		const facts = { cpuCores: 8, totalMemoryBytes: 32 * 1024 ** 3 };
		expect(resolveRuntimeReadConcurrency(AUTO_RUNTIME_READ_CONCURRENCY, facts)).toMatchObject({
			configured: 0,
			suggested: 4,
			effective: 4,
			source: "auto",
		});
		expect(resolveRuntimeReadConcurrency(7, facts)).toMatchObject({
			configured: 7,
			suggested: 4,
			effective: 7,
			source: "manual",
		});
	});

	it("normalizes invalid and out-of-range configuration", () => {
		expect(resolveRuntimeReadConcurrency(-1, { cpuCores: 4, totalMemoryBytes: 16 * 1024 ** 3 }).configured).toBe(
			AUTO_RUNTIME_READ_CONCURRENCY,
		);
		expect(resolveRuntimeReadConcurrency(1, { cpuCores: 4, totalMemoryBytes: 16 * 1024 ** 3 }).configured).toBe(
			AUTO_RUNTIME_READ_CONCURRENCY,
		);
		expect(
			resolveRuntimeReadConcurrency(MAX_RUNTIME_READ_CONCURRENCY + 1, {
				cpuCores: 4,
				totalMemoryBytes: 16 * 1024 ** 3,
			}).effective,
		).toBe(MAX_RUNTIME_READ_CONCURRENCY);
		expect(
			resolveRuntimeReadConcurrency(MIN_RUNTIME_READ_CONCURRENCY, { cpuCores: 4, totalMemoryBytes: 16 * 1024 ** 3 })
				.effective,
		).toBe(MIN_RUNTIME_READ_CONCURRENCY);
	});
});
