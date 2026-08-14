import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { WebSocket, WebSocketServer } from "ws";

const GUI_MAX_FRAME_LENGTH = 16 * 1024 * 1024;
const GUI_MAX_PENDING_WRITE_BYTES = GUI_MAX_FRAME_LENGTH * 4;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const guiProtocolSource = fileURLToPath(new URL("../gui-protocol/src/index.ts", import.meta.url));
const hostCli = fileURLToPath(new URL("../gui-host/src/cli.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");

function guiHostBridge(): Plugin {
	return {
		name: "lystar-gui-host-bridge",
		configureServer(server) {
			const sockets = new Set<WebSocket>();
			const bridge = new WebSocketServer({ host: "127.0.0.1", port: 1421, maxPayload: GUI_MAX_FRAME_LENGTH + 4 });
			bridge.on("connection", (socket) => {
				sockets.add(socket);
				const child = spawn(process.execPath, ["--import", tsxLoader, hostCli], {
					cwd: repositoryRoot,
					env: process.env,
					stdio: ["pipe", "pipe", "pipe"],
				});
				let writing = Promise.resolve();
				let pendingWriteBytes = 0;
				socket.on("message", (data, binary) => {
					if (!binary) {
						socket.close(1003, "binary frames required");
						return;
					}
					const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
					if (bytes.length > GUI_MAX_FRAME_LENGTH + 4) {
						socket.close(1009, "frame too large");
						return;
					}
					if (pendingWriteBytes + bytes.length > GUI_MAX_PENDING_WRITE_BYTES) {
						socket.close(1013, "host input is congested");
						return;
					}
					pendingWriteBytes += bytes.length;
					writing = writing.then(
						() =>
							new Promise<void>((resolve, reject) => {
								const cleanup = () => {
									child.stdin.off("drain", onDrain);
									child.stdin.off("error", onError);
								};
								const onDrain = () => {
									cleanup();
									resolve();
								};
								const onError = (error: Error) => {
									cleanup();
									reject(error);
								};
								if (child.stdin.write(bytes)) resolve();
								else {
									child.stdin.once("drain", onDrain);
									child.stdin.once("error", onError);
								}
							}),
					).finally(() => {
						pendingWriteBytes -= bytes.length;
					});
					writing.catch(() => socket.close(1011, "host stdin failed"));
				});
				child.stdout.on("data", (chunk: Buffer) => {
					if (socket.readyState !== WebSocket.OPEN) return;
					if (socket.bufferedAmount > GUI_MAX_FRAME_LENGTH * 4) {
						socket.close(1013, "client is too slow");
						return;
					}
					socket.send(chunk, { binary: true });
				});
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk: string) => server.config.logger.error(chunk.trimEnd()));
				child.on("error", (error) => {
					server.config.logger.error(`GUI Host failed to start: ${error.message}`);
					socket.close(1011, "host failed to start");
				});
				child.on("exit", (code) => {
					if (socket.readyState < WebSocket.CLOSING) socket.close(code === 0 ? 1000 : 1011, `host exited ${code}`);
				});
				socket.on("close", () => {
					sockets.delete(socket);
					child.stdin.end();
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
				});
			});
			server.httpServer?.once("close", () => {
				for (const socket of sockets) socket.close(1001, "development server stopped");
				bridge.close();
			});
		},
	};
}

export default defineConfig({
	plugins: [react(), guiHostBridge()],
	resolve: {
		alias: {
			"@lystar/code-gui-protocol": guiProtocolSource,
		},
	},
	define: {
		__LYSTAR_GUI_DEFAULT_CWD__: JSON.stringify(repositoryRoot),
	},
	server: {
		host: "127.0.0.1",
		port: 1420,
		strictPort: true,
	},
	build: {
		target: "es2022",
	},
});
