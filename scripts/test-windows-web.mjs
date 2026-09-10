#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
	throw new Error("This integration check must run on Windows");
}

function argumentValue(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function reservePort() {
	const server = createServer();
	return await new Promise((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Unable to reserve a Windows Web test port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

async function waitForHealth(url, child, output) {
	let lastError = "unknown error";
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (child.exitCode !== null) {
			throw new Error(`lc web exited with ${child.exitCode}: ${output.join("")}`);
		}
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = await response.json();
			if (body?.ok === true && body.gateway === "ok" && body.host === "connected") return;
			throw new Error(`Unexpected health response: ${JSON.stringify(body)}`);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
		}
	}
	throw new Error(`Timed out waiting for lc web health: ${lastError}; output: ${output.join("")}`);
}

function stopProcessTree(pid) {
	if (pid === undefined) return;
	spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

const bundleDir = resolve(argumentValue("--bundle-dir") ?? "packages/coding-agent/binaries/windows-x64/lystar-agent");
const executable = join(bundleDir, "lc.exe");
const agentDir = mkdtempSync(join(tmpdir(), "lystar-web-windows-"));
const webPort = await reservePort();
const runtimePort = await reservePort();
const runtimeEndpoint = `tcp://127.0.0.1:${runtimePort}`;
const output = [];
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: agentDir,
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	PI_WEB_ALLOWED_HOSTS: "127.0.0.1,localhost",
	PI_WEB_HOST: "127.0.0.1",
	PI_WEB_PORT: String(webPort),
	PI_WEB_RUNTIME_PORT: String(runtimePort),
	PI_WEB_TOKEN: "windows-web-smoke-password",
};
let gateway;

try {
	gateway = spawn(executable, ["web"], {
		cwd: bundleDir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	gateway.stdout.on("data", (chunk) => output.push(String(chunk)));
	gateway.stderr.on("data", (chunk) => output.push(String(chunk)));
	await waitForHealth(`http://127.0.0.1:${webPort}/healthz`, gateway, output);
	const indexResponse = await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(2_000) });
	if (!indexResponse.ok || !(await indexResponse.text()).includes("<html")) {
		throw new Error(`Web UI did not serve index.html: HTTP ${indexResponse.status}`);
	}
	console.log(`Windows lc web smoke passed on ${webPort}; Runtime connected on ${runtimePort}`);
} finally {
	const stopRuntime = spawnSync(
		executable,
		["web-runtime", "stop", "--force", "--endpoint", runtimeEndpoint],
		{ cwd: bundleDir, env, encoding: "utf8", windowsHide: true },
	);
	if (stopRuntime.status !== 0 && stopRuntime.status !== null) {
		output.push(stopRuntime.stdout ?? "", stopRuntime.stderr ?? "");
	}
	stopProcessTree(gateway?.pid);
	if (gateway) await new Promise((resolvePromise) => gateway.once("close", resolvePromise));
	rmSync(agentDir, { recursive: true, force: true });
}
