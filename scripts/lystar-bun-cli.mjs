#!/usr/bin/env node
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { restoreSandboxEnv } from "../packages/coding-agent/dist/bun/restore-sandbox-env.js";
import { APP_NAME } from "../packages/coding-agent/dist/config.js";

process.title = APP_NAME;
process.emitWarning = () => {};

registerBunOAuthFlows();
restoreSandboxEnv();

await import("../packages/coding-agent/dist/bun/register-bedrock.js");
const { main } = await import("../packages/coding-agent/dist/main.js");
await main(process.argv.slice(2));