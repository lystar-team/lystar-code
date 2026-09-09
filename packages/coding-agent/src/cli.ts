#!/usr/bin/env node
import { runCloseOldCommand } from "./cli/close-old-command.ts";
import { runWebCommand, runWebRuntimeCommand } from "./cli/web-command.ts";
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.
configureHttpDispatcher();

const args = process.argv.slice(2);
try {
	if (args[0] === "close-old") await runCloseOldCommand(args.slice(1));
	else if (args[0] === "web") await runWebCommand(args.slice(1));
	else if (args[0] === "web-runtime") await runWebRuntimeCommand(args.slice(1));
	else await main(args);
} catch (error) {
	console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
