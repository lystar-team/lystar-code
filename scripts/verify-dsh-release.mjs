#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/verify-dsh-release.mjs <binary-or-cli.js> [report.json]");
const root = await mkdtemp(join(tmpdir(), "lystar-dsh-release-"));
const agent = join(root, "agent");
const cwd = join(root, "workspace");
await mkdir(agent);
await mkdir(cwd);
const manifest = JSON.parse(await readFile(new URL("../packages/deepseek-harness/package.json", import.meta.url), "utf8"));
const version = manifest.dependencies["@deepseek-ai/dsh-agent"];
const report = { passed: false, platform: process.platform, architecture: process.arch, runtime: binary, directory: root, checks: {}, modelRequests: [], toolEvents: [], notifications: [] };
let profileName = "";
let callSequence = 0;
const workerMarker = "DSH_RELEASE_SECOND";
const shellMarker = "DSH_RELEASE_SHELL";
const shellTool = process.platform === "win32" ? "dsh__pwsh" : "dsh__bash";
const shellCommand = process.platform === "win32" ? `Write-Output ${shellMarker}` : `printf ${shellMarker}`;
const loopMarker = "DSH_RELEASE_LOOP";
const successMarker = "DSH_RELEASE_FINISHED";
const code = [
 "const written = await tools.dsh__write({file_path: \"receipt.txt\", content: \"DSH_RELEASE_FIRST\"}); if (written.isError) throw new Error(JSON.stringify(written));",
 "const initial = await tools.dsh__read({file_path: \"receipt.txt\"}); if (initial.isError) throw new Error(JSON.stringify(initial));",
 "const edited = await tools.dsh__edit({file_path: \"receipt.txt\", old_string: \"FIRST\", new_string: \"SECOND\"}); if (edited.isError) throw new Error(JSON.stringify(edited));",
 "const result = await tools.dsh__read({file_path: \"receipt.txt\"}); if (result.isError) throw new Error(JSON.stringify(result)); text(result);",
 `const shell = await tools.${shellTool}(${JSON.stringify({ command: shellCommand, description: "Verify the original platform shell runner" })}); if (shell.isError) throw new Error(JSON.stringify(shell)); text(shell);`,
].join("\n");

const server = createServer(async (request, response) => {
 try {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const tools = payload.tools?.map(tool => tool.function.name) ?? [];
  const lastUser = payload.messages.findLastIndex(message => message.role === "user");
  const results = payload.messages.slice(lastUser + 1).filter(message => message.role === "tool");
  const native = tools.includes("write") && !tools.includes("codemode");
  const done = native
   ? results.length > 0
   : results.some(message => JSON.stringify(message.content).includes(workerMarker));
  report.modelRequests.push({ native, tools, toolResults: results.length });
  const call = native
   ? { name: "write", arguments: JSON.stringify({ file_path: "native-loop.txt", content: loopMarker }) }
   : { name: "codemode", arguments: JSON.stringify({ code: code.replaceAll("receipt.txt", `receipt-${profileName}.txt`) }) };
  const delta = done
   ? { role: "assistant", content: successMarker }
   : { role: "assistant", tool_calls: [{ index: 0, id: `release-${++callSequence}`, type: "function", function: call }] };
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: done ? "stop" : "tool_calls" }]) {
   response.write(`data: ${JSON.stringify({ id: "release-verification", object: "chat.completion.chunk", created: 0, model: "verification", choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
 } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
const address = server.address();
assert(address && typeof address !== "string");
await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "dsh-verification": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-verification", models: [{ id: "verification", contextWindow: 200000, maxTokens: 512 }] } } }));
await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
const args = ["--mode", "rpc", "--no-session", "--no-context-files", "--provider", "dsh-verification", "--model", "verification"];
const javascript = extname(binary) === ".js";
const child = spawn(javascript ? process.execPath : binary, javascript ? [binary, ...args] : args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent, npm_config_ignore_scripts: "true", PNPM_CONFIG_IGNORE_SCRIPTS: "true" }, stdio: ["pipe", "pipe", "pipe"] });
const waiting = new Map();
const emitter = new EventEmitter();
let sequence = 0;
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
 let event; try { event = JSON.parse(line); } catch { return; }
 if (event.type === "response" && waiting.has(event.id)) { const pending = waiting.get(event.id); waiting.delete(event.id); pending.resolve(event); }
 if (event.type === "tool_execution_start" || event.type === "tool_execution_end") report.toolEvents.push({ type: event.type, toolName: event.toolName, isError: event.isError, result: event.result });
 if (event.type === "extension_ui_request" && event.method === "notify") {
  report.notifications.push({ message: event.message, notifyType: event.notifyType });
  if (event.notifyType === "error") console.error(event.message);
 }
 emitter.emit(event.type, event);
});
const fail = error => { for (const pending of waiting.values()) pending.reject(error); waiting.clear(); };
child.on("error", fail);
child.on("exit", code => fail(new Error(`CLI exited ${code}: ${stderr}`)));
function request(type, extra = {}) {
 const id = String(++sequence);
 return new Promise((resolveReply, reject) => {
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`RPC ${type} timed out: ${stderr}`)); }, 180000);
  waiting.set(id, { resolve: event => { clearTimeout(timer); event.success ? resolveReply(event) : reject(new Error(JSON.stringify(event))); }, reject: error => { clearTimeout(timer); reject(error); } });
  child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
 });
}
let commandStartedAt = 0;
async function command(message) { commandStartedAt = Date.now(); await request("prompt", { message }); }
async function lastMessage(customType) {
 const response = await request("get_messages");
 return response.data.messages.findLast(message => message.role === "custom" && message.customType === customType && message.timestamp >= commandStartedAt);
}
function finished() {
 return new Promise((resolveEnd, reject) => {
  const listener = event => { clearTimeout(timer); resolveEnd(event); };
  const timer = setTimeout(() => { emitter.off("agent_end", listener); reject(new Error(`Agent did not finish: ${stderr}`)); }, 30000);
  emitter.once("agent_end", listener);
 });
}
const deadline = setTimeout(() => child.kill(), 600000);
try {
 const commands = await request("get_commands");
 assert(commands.data.commands.some(command => command.name === "plugins"));
 await command("/plugins");
 assert((await lastMessage("plugin-hub-overview"))?.content.includes("DeepSeek Harness"));
 report.checks.hub = true;
 for (const profile of ["headless", "web"]) {
  profileName = profile;
  console.log(`Installing and executing ${profile} profile`);
  await command(`/plugins dsh profile ${profile}`);
  assert.equal(JSON.parse(await readFile(join(agent, "deepseek-harness/plugins.json"), "utf8")).profile, profile);
  await command("/plugins dsh list");
  const status = (await lastMessage("dsh-plugins"))?.content;
  assert(typeof status === "string" && status.includes("active") && !/(?:^|\n)(?:failed|pending)\s/.test(status), status);
  const end = finished();
  await Promise.all([command("Verify the original DSH file tools and platform shell through Codemode."), end]);
  assert.equal(await readFile(join(cwd, `receipt-${profile}.txt`), "utf8"), workerMarker);
  const messages = (await request("get_messages")).data.messages;
  assert(messages.some(message => message.role === "toolResult" && !message.isError && JSON.stringify(message.content).includes(shellMarker)));
  assert(messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(successMarker)));
  report.checks[`${profile}Tools`] = true;
  if (profile === "headless") {
   await command("/plugins dsh run Write native-loop.txt with DSH_RELEASE_LOOP using the write tool, then report completion.");
   assert.equal(await readFile(join(cwd, "native-loop.txt"), "utf8"), loopMarker);
   assert((await lastMessage("dsh-native-turn"))?.content.includes(successMarker));
   report.checks.originalLoop = true;
  } else {
   await command("/plugins dsh web");
   const url = (await lastMessage("dsh-web"))?.content.match(/https?:\/\/\S+/)?.[0];
   assert(url);
   const bootstrap = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
   assert.equal(bootstrap.status, 303);
   const cookies = bootstrap.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
   const location = bootstrap.headers.get("location");
   assert(cookies && location);
   const page = await fetch(new URL(location, url), { headers: { cookie: cookies }, signal: AbortSignal.timeout(15000) });
   assert(page.ok, `DSH page returned ${page.status}`);
   assert((await page.text()).includes("<html"));
   report.checks.webPage = true;
  }
 }
 const bundle = "@deepseek-ai/dsh-subagent-claude-code";
 for (const action of [`install ${bundle}@${version}`, `disable ${bundle}`, `update ${bundle}@${version}`]) {
  await command(`/plugins dsh ${action}`);
  const result = JSON.parse((await lastMessage("dsh-management"))?.content ?? "null");
  assert(result && !["failed", "cancelled"].includes(result.application), JSON.stringify(result));
  if (!action.startsWith("install")) assert.equal(result.enabled, false);
  await command("/plugins dsh reload");
 }
 report.checks.bundleInstallDisableUpdate = true;
 await command("/plugins dsh list");
 const final = (await lastMessage("dsh-plugins"))?.content;
 assert(typeof final === "string" && !/(?:^|\n)(?:failed|pending)\s/.test(final), final);
 report.passed = true;
 console.log(JSON.stringify(report));
} catch (error) { report.error = String(error); report.stderr = stderr; throw error; }
finally {
 clearTimeout(deadline); child.stdin.end(); child.kill(); lines.close(); server.closeAllConnections();
 await new Promise(resolveClose => server.close(resolveClose));
 await writeFile(process.argv[3] ?? join(root, "result.json"), JSON.stringify(report, null, 2));
}
