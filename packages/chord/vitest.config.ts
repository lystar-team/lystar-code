import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { environment: "node" },
	// Workspace packages ship source conditions, so tests read current sources instead of stale dist output.
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
