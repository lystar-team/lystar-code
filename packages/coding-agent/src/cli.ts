#!/usr/bin/env node
import { runCloseOldCommand } from "./cli/close-old-command.ts";
import { setupCli } from "./cli/setup.ts";
import { runWebCommand, runWebRuntimeCommand, runWebSessionCommand } from "./cli/web-command.ts";
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

setupCli();

const args = process.argv.slice(2);
try {
	if (args[0] === "close-old") await runCloseOldCommand(args.slice(1));
	else if (args[0] === "session") await runWebSessionCommand(args.slice(1));
	else if (args[0] === "web") await runWebCommand(args.slice(1));
	else if (args[0] === "web-runtime") await runWebRuntimeCommand(args.slice(1));
	else await main(args);
} catch (error) {
	console.error(`${APP_NAME}：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
