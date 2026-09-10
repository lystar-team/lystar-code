#!/usr/bin/env node
import { dirname, join } from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { restoreSandboxEnv } from "../packages/coding-agent/dist/bun/restore-sandbox-env.js";
import { APP_NAME, VERSION } from "../packages/coding-agent/dist/config.js";

process.title = APP_NAME;
process.emitWarning = () => {};

registerBunOAuthFlows();
restoreSandboxEnv();

await import("../packages/coding-agent/dist/bun/runtime-setup.js");

const args = process.argv.slice(2);
if (args[0] === "web") {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(
			"用法：lc web\n\n首次运行会依次配置监听 IP、白名单 IP、Web 端口、Runtime 端口和连接密码。\nWeb 默认端口：1420；Runtime 默认端口：1422。\n\n服务命令：\n  lc web gateway restart\n  lc web runtime restart\n",
		);
	} else if (args.length > 1) {
		const { runWebControlCommand } = await import("../packages/coding-agent/dist/cli/web-command.js");
		await runWebControlCommand(args.slice(1));
	} else {
		const { runWebGatewayCli } = await import("../packages/web-gateway/dist/runner.js");
		await runWebGatewayCli({
			defaultPort: 1420,
			defaultRuntimePort: 1422,
			staticDir: join(dirname(process.execPath), "web"),
			expectedProductVersion: VERSION,
			runtimeInvocation: {
				command: process.execPath,
				args: ["web-runtime", "serve"],
				cwd: dirname(process.execPath),
			},
		});
	}
} else if (args[0] === "web-runtime") {
	const { runWebRuntimeCli } = await import("../packages/web-runtime/dist/cli-runner.js");
	await runWebRuntimeCli(args.slice(1));
} else if (args[0] === "close-old") {
	const { runCloseOldCommand } = await import("../packages/coding-agent/dist/cli/close-old-command.js");
	await runCloseOldCommand(args.slice(1));
} else {
	const { main } = await import("../packages/coding-agent/dist/main.js");
	await main(args);
}
