import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtimeProtocolSource = fileURLToPath(new URL("../web-protocol/src/index.ts", import.meta.url));
const WEB_DEV_PORT = 1420;
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:1422";
const gatewayUrl = process.env.PI_WEB_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
const gatewayWebSocketUrl = gatewayUrl.replace(/^http/iu, "ws");
const gatewayProxy: ProxyOptions = {
	target: gatewayUrl,
	changeOrigin: true,
	headers: { Origin: gatewayUrl },
};
const gatewayWebSocketProxy: ProxyOptions = {
	target: gatewayWebSocketUrl,
	changeOrigin: true,
	ws: true,
	headers: { Origin: gatewayUrl },
};

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@lystar/code-web-protocol": runtimeProtocolSource,
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	define: {
		__LYSTAR_WEB_REPOSITORY_ROOT__: JSON.stringify(repositoryRoot),
	},
	server: {
		host: "0.0.0.0",
		port: WEB_DEV_PORT,
		strictPort: true,
		proxy: {
			"/api": gatewayProxy,
			"/healthz": gatewayProxy,
			"/ws": gatewayWebSocketProxy,
		},
	},
	build: {
		target: "es2022",
		sourcemap: true,
	},
});
