import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const guiProtocolSource = fileURLToPath(new URL("../gui-protocol/src/index.ts", import.meta.url));
const gatewayUrl = process.env.PI_WEB_GATEWAY_URL ?? "http://127.0.0.1:1420";
const gatewayWebSocketUrl = gatewayUrl.replace(/^http/iu, "ws");

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@lystar/code-gui-protocol": guiProtocolSource,
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	define: {
		__LYSTAR_WEB_REPOSITORY_ROOT__: JSON.stringify(repositoryRoot),
	},
	server: {
		host: "0.0.0.0",
		port: 1421,
		strictPort: true,
		proxy: {
			"/api": gatewayUrl,
			"/healthz": gatewayUrl,
			"/ws": {
				target: gatewayWebSocketUrl,
				ws: true,
			},
		},
	},
	build: {
		target: "es2022",
		sourcemap: true,
	},
});
