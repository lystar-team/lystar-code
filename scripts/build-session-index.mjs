import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const platforms = {
	"linux-x64": ["linux", "amd64"],
	"linux-arm64": ["linux", "arm64"],
	"darwin-x64": ["darwin", "amd64"],
	"darwin-arm64": ["darwin", "arm64"],
	"win32-x64": ["windows", "amd64"],
};
let platform = `${process.platform}-${process.arch}`;
let output;
for (let index = 2; index < process.argv.length; index++) {
	const option = process.argv[index];
	const value = process.argv[++index];
	if (!value) throw new Error(`Missing value for ${option}`);
	if (option === "--platform") platform = value;
	else if (option === "--out") output = resolve(value);
	else throw new Error(`Unknown option: ${option}`);
}
const target = platforms[platform];
if (!target) throw new Error(`Unsupported session index platform: ${platform}`);
const executable = platform.startsWith("win32-") ? "lystar-session-index.exe" : "lystar-session-index";
output ??= resolve(root, "packages/coding-agent/dist/native/session-index", platform, executable);
mkdirSync(dirname(output), { recursive: true });
const staging = `${output}.${process.pid}.tmp`;
const result = spawnSync("go", ["build", "-mod=readonly", "-trimpath", "-ldflags=-s -w", "-o", staging, "."], {
	cwd: resolve(root, "packages/web-runtime/native/session-index"),
	stdio: "inherit",
	env: { ...process.env, GOOS: target[0], GOARCH: target[1], CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(staging, 0o755);
renameSync(staging, output);
console.log(`Built session index: ${output}`);
