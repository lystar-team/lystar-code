import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtimeProtocolSource = fileURLToPath(new URL("../web-protocol/src/index.ts", import.meta.url));
const WEB_DEV_PORT = 2420;
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:2422";
const webConfigPath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "web-dev-config.json");

function configuredGatewayUrl(): string {
	if (process.env.PI_WEB_GATEWAY_URL) return process.env.PI_WEB_GATEWAY_URL;
	let content: string;
	try {
		content = readFileSync(webConfigPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_GATEWAY_URL;
		throw error;
	}
	const config: unknown = JSON.parse(content);
	const port = config && typeof config === "object" && "port" in config ? config.port : undefined;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("开发 Gateway 端口无效");
	}
	return `http://127.0.0.1:${port}`;
}

const gatewayUrl = configuredGatewayUrl();
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
	plugins: [
		react(),
		tailwindcss(),
		{
			name: "web-gateway-config",
			configureServer(server) {
				server.watcher.add(webConfigPath);
				const reloadGateway = (path: string) => {
					if (path === webConfigPath && configuredGatewayUrl() !== gatewayUrl) {
						void server.restart().catch((error: unknown) => server.config.logger.error(String(error)));
					}
				};
				server.watcher.on("change", reloadGateway);
				server.httpServer?.once("close", () => server.watcher.off("change", reloadGateway));
			},
		},
	],
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
