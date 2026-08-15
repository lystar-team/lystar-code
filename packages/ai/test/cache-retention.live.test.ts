import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModel, stream } from "../src/compat.ts";
import { makeCacheRetentionContext, stopAfterPayload } from "./cache-retention-test-utils.ts";

const originalEnv = process.env.PI_CACHE_RETENTION;
const context = makeCacheRetentionContext();

beforeEach(() => {
	delete process.env.PI_CACHE_RETENTION;
});

afterEach(() => {
	if (originalEnv !== undefined) {
		process.env.PI_CACHE_RETENTION = originalEnv;
	} else {
		delete process.env.PI_CACHE_RETENTION;
	}
});

describe("Cache Retention E2E", () => {
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider", () => {
		it("uses the default cache TTL when PI_CACHE_RETENTION is not set", async () => {
			const model = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			const s = stream(model, context, {
				onPayload: stopAfterPayload((payload) => {
					capturedPayload = payload;
				}),
			});

			for await (const _ of s) {
				// Consume the stream to trigger the request.
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system).toBeDefined();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
		});

		it("uses a 1h cache TTL when PI_CACHE_RETENTION=long", async () => {
			process.env.PI_CACHE_RETENTION = "long";
			const model = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			const s = stream(model, context, {
				onPayload: stopAfterPayload((payload) => {
					capturedPayload = payload;
				}),
			});

			for await (const _ of s) {
				// Consume the stream to trigger the request.
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system).toBeDefined();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider", () => {
		it("omits prompt_cache_retention when PI_CACHE_RETENTION is not set", async () => {
			const model = getModel("openai", "gpt-4o-mini");
			let capturedPayload: any = null;

			const s = stream(model, context, {
				onPayload: stopAfterPayload((payload) => {
					capturedPayload = payload;
				}),
			});

			for await (const _ of s) {
				// Consume the stream to trigger the request.
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_retention).toBeUndefined();
		});

		it("sets prompt_cache_retention to 24h when PI_CACHE_RETENTION=long", async () => {
			process.env.PI_CACHE_RETENTION = "long";
			const model = getModel("openai", "gpt-4o-mini");
			let capturedPayload: any = null;

			const s = stream(model, context, {
				onPayload: stopAfterPayload((payload) => {
					capturedPayload = payload;
				}),
			});

			for await (const _ of s) {
				// Consume the stream to trigger the request.
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});
	});
});
