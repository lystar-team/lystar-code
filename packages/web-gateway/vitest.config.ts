import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

const webRuntimeIndex = fileURLToPath(new URL("../web-runtime/src/index.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: { environment: "node" },
		resolve: {
			alias: [{ find: /^@lystar\/code-web-runtime$/, replacement: webRuntimeIndex }],
		},
	}),
);
