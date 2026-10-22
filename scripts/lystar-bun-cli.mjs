#!/usr/bin/env node
import { dirname, join } from "node:path";
import { createJiti } from "jiti/static";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { restoreSandboxEnv } from "../packages/coding-agent/dist/bun/restore-sandbox-env.js";
import { APP_NAME, VERSION } from "../packages/coding-agent/dist/config.js";
import {
	runMacosPermissionsCommand,
	runWebComponentAction,
	runWebServiceAction,
} from "../packages/web-gateway/dist/gateway-service.js";

// 原版 DSH 私有 Runner 以当前可执行文件运行 JS；独立程序需进入 Bun 运行时模式。
if (process.env.DSH_SUBPROCESS_RUNNER) {
	if (process.platform === "win32") {
		const [entry, ...args] = process.argv.slice(2);
		const runner = await createJiti(entry, { tryNative: false }).import(entry);
		process.argv = [process.execPath, entry, ...args];
		await runner.runSelectedSubprocessRunner(process.env.DSH_SUBPROCESS_RUNNER);
		process.exit(process.exitCode ?? 0);
	}
	const environment = Object.fromEntries(
		Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
	);
	const runnerArgs = process.argv.slice(2);
	// Bun 消耗第一个 --；原版 Runner 仍需自己的参数分隔符。
	const delimiter = runnerArgs.indexOf("--");
	if (delimiter >= 0) runnerArgs.splice(delimiter, 0, "--");
	process.execve(process.execPath, [process.execPath, ...runnerArgs], { ...environment, BUN_BE_BUN: "1" });
}

process.title = APP_NAME;
process.emitWarning = () => {};

registerBunOAuthFlows();
restoreSandboxEnv();

await import("../packages/coding-agent/dist/bun/runtime-setup.js");

const args = process.argv.slice(2);
const foreground = args.includes("--foreground");
if (args[0] === "web") {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(
			"用法：lc web\n\n首次运行会依次配置 Web 端口、Runtime 端口和连接密码。\nWeb 默认端口：1420；Runtime 默认端口：1422。\n默认启动为后台模式；需要前台运行时使用：lc web --foreground。\n\n组件命令：\n  lc web gateway status|stop|start|restart\n  lc web runtime status|stop|start|restart\n\n服务命令：\n  lc web service install\n  lc web service status\n  lc web service restart\n  lc web service uninstall\n\nmacOS 授权：\n  lc web permissions status\n  lc web permissions setup\n",
		);
	} else if (args.length > 1 && !foreground) {
		if (args[1] === "service") {
			const { runWebServiceCommand } = await import("../packages/coding-agent/dist/cli/web-command.js");
			await runWebServiceCommand(args.slice(2), { gatewayModule: { runWebServiceAction } });
		} else if (args[1] === "permissions") {
			const { runWebPermissionsCommand } = await import("../packages/coding-agent/dist/cli/web-command.js");
			await runWebPermissionsCommand(args.slice(2), { runMacosPermissionsCommand });
		} else {
			const { runWebControlCommand } = await import("../packages/coding-agent/dist/cli/web-command.js");
			await runWebControlCommand(args.slice(1), { gatewayModule: { runWebComponentAction } });
		}
	} else {
		const { foregroundWebInvocation, sourceRuntimeInvocation } = await import("../packages/coding-agent/dist/cli/web-command.js");
		const { runWebGatewayCli } = await import("../packages/web-gateway/dist/runner.js");
		const runtimeInvocation = sourceRuntimeInvocation();
		const backgroundInvocation = foreground ? undefined : foregroundWebInvocation();
		const serviceVersion =
			backgroundInvocation &&
			backgroundInvocation.command !== process.execPath &&
			runtimeInvocation.command !== process.execPath
				? VERSION
				: undefined;
		await runWebGatewayCli({
			defaultPort: 1420,
			defaultRuntimePort: 1422,
			staticDir: join(dirname(process.execPath), "web"),
			expectedProductVersion: VERSION,
			runtimeInvocation,
			backgroundInvocation,
			...(serviceVersion ? { serviceVersion } : {}),
		});
		if (!foreground && process.stdin.isTTY && process.stdout.isTTY) {
			const { runWebPermissionsCommand } = await import("../packages/coding-agent/dist/cli/web-command.js");
			await runWebPermissionsCommand(["setup"], { runMacosPermissionsCommand });
		}
	}
} else if (args[0] === "uninstall") {
	// `lc uninstall <source>` still belongs to the Package command. runUninstallCommand
	// returns false for those arguments so main() keeps handling them.
	const { runUninstallCommand } = await import("../packages/coding-agent/dist/cli/uninstall-command.js");
	const handled = await runUninstallCommand(args, { gatewayModule: { runWebServiceAction } });
	if (!handled) {
		const { main } = await import("../packages/coding-agent/dist/main.js");
		await main(args);
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
