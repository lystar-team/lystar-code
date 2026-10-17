import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execNpmSync } from "./npm-command.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
for (const arg of args) {
	if (arg !== "--offline" && arg !== "--shared") throw new Error(`Unknown option: ${arg}`);
}
const shared = args.has("--shared");
const offline = shared || args.has("--offline");
const packages = [
	"chord", "tui", "telemetry", "codemode", "mcp", "ai", "durable", "env", "agent", "protocol",
	"coding-agent", "web-protocol", "web-runtime", "web", "web-gateway",
];
for (const name of packages) {
	const script = name === "ai" && offline ? "build:offline" : name === "web-runtime" && shared ? "build:js" : "build";
	const started = Date.now();
	execNpmSync(["run", script, "--workspace", `packages/${name}`], { cwd: root, stdio: "inherit", timeout: 600_000 });
	console.log(`Built ${name} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
if (shared) {
	mkdirSync(new URL("../.artifacts/", import.meta.url), { recursive: true });
	// 平台索引由各 runner 提供，共享归档不能覆盖其原生产物。
	execFileSync("tar", ["--exclude=packages/coding-agent/dist/native", "-cf", ".artifacts/release-shared.tar",
		...packages.map((name) => `packages/${name}/dist`)], { cwd: root, stdio: "inherit", timeout: 60_000 });
}
