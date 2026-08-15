import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

const LIVE_TEST_FILES = [
	"test/abort.test.ts",
	"test/anthropic-eager-tool-input-e2e.test.ts",
	"test/anthropic-long-cache-retention-e2e.test.ts",
	"test/anthropic-opus-4-8-smoke.test.ts",
	"test/anthropic-thinking-disable.test.ts",
	"test/anthropic-tool-name-normalization.test.ts",
	"test/bedrock-thinking-payload.test.ts",
	"test/cache-retention.test.ts",
	"test/context-overflow.test.ts",
	"test/cross-provider-handoff.test.ts",
	"test/google-thinking-disable.test.ts",
	"test/image-tool-result.test.ts",
	"test/images.test.ts",
	"test/interleaved-thinking.test.ts",
	"test/openai-codex-cache-affinity-e2e.test.ts",
	"test/openai-responses-cache-affinity-e2e.test.ts",
	"test/openai-responses-reasoning-replay-e2e.test.ts",
	"test/openai-responses-tool-result-images.test.ts",
	"test/openrouter-cache-write-repro.test.ts",
	"test/responseid.test.ts",
	"test/stream.test.ts",
	"test/tokens.test.ts",
	"test/tool-call-id-normalization.test.ts",
	"test/tool-call-without-result.test.ts",
	"test/total-tokens.test.ts",
	"test/unicode-surrogate.test.ts",
	"test/xhigh.test.ts",
	"test/xiaomi-token-plan-ams-anthropic-empty-signature-smoke.test.ts",
	"test/zen.test.ts",
];

const isLiveSuite = process.env.PI_TEST_SUITE === "live";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: isLiveSuite ? LIVE_TEST_FILES : ["test/**/*.test.ts"],
		exclude: isLiveSuite ? [] : LIVE_TEST_FILES,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex }],
	},
});
