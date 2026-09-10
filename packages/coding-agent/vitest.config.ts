import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

const TEST_FILES = {
	ci: [
		"test/args.test.ts",
		"test/config.test.ts",
		"test/model-resolver.test.ts",
		"test/package-distribution.test.ts",
		"test/path-utils.test.ts",
		"test/resource-loader.test.ts",
		"test/skills.test.ts",
		"test/tools.test.ts",
		"test/web-command.test.ts",
	],
	live: [
		"test/agent-session-branching.test.ts",
		"test/agent-session-compaction.test.ts",
		"test/agent-session-tree-navigation.test.ts",
		"test/compaction-extensions.test.ts",
		"test/compaction.live.test.ts",
		"test/rpc.test.ts",
	],
	platform: ["test/bash-close-hang-windows.test.ts"],
	stress: ["test/stress/session-manager-large-file.test.ts"],
} as const;

const suite = process.env.PI_TEST_SUITE as keyof typeof TEST_FILES | undefined;
const selectedFiles = suite ? TEST_FILES[suite] : undefined;

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			include: selectedFiles ?? ["test/**/*.test.ts"],
			exclude: selectedFiles ? [] : [...TEST_FILES.live, ...TEST_FILES.platform, ...TEST_FILES.stress],
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
