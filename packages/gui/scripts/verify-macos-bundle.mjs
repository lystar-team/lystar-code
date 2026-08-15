import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hostPayloadHeader = Buffer.from("LYSTAR-GUI-BINARY/1\n");

function run(command, args, capture = false) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}: ${result.stderr ?? ""}`);
	}
	return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function readEmbeddedHost(path) {
	const payload = readFileSync(path);
	if (!payload.subarray(0, hostPayloadHeader.length).equals(hostPayloadHeader)) {
		throw new Error(`invalid GUI Host payload header: ${path}`);
	}
	return payload.subarray(hostPayloadHeader.length);
}

function verifyAdHocSignature(path) {
	run("codesign", ["--verify", "--strict", "--verbose=2", path]);
	const details = run("codesign", ["-dv", "--verbose=4", path], true);
	if (!details.includes("Signature=adhoc")) throw new Error(`expected ad-hoc signature: ${path}\n${details}`);
}

function verifyEmbeddedHost(resourceDir, relativePath, expectedArch) {
	const source = join(resourceDir, relativePath);
	if (!statSync(source).isFile()) throw new Error(`missing GUI Host payload: ${source}`);
	const workDir = mkdtempSync(join(tmpdir(), "lystar-gui-host-signature-"));
	const output = join(workDir, basename(relativePath));
	try {
		writeFileSync(output, readEmbeddedHost(source));
		chmodSync(output, 0o755);
		verifyAdHocSignature(output);
		const architectures = run("lipo", ["-archs", output], true).trim().split(/\s+/);
		if (!architectures.includes(expectedArch)) {
			throw new Error(`expected ${expectedArch} GUI Host, received ${architectures.join(", ")}: ${source}`);
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

export function verifyMacosBundle(appPath) {
	if (process.platform !== "darwin") throw new Error("macOS bundle verification must run on macOS");
	const resolvedApp = resolve(appPath);
	if (!statSync(resolvedApp).isDirectory()) throw new Error(`macOS app bundle does not exist: ${resolvedApp}`);
	run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", resolvedApp]);
	verifyAdHocSignature(resolvedApp);

	const resourceDir = join(resolvedApp, "Contents", "Resources");
	const localArch = process.arch === "arm64" ? "arm64" : "x86_64";
	verifyEmbeddedHost(resourceDir, "local-host/lystar-gui-host.bin", localArch);
	verifyEmbeddedHost(resourceDir, "remote-hosts/darwin-arm64/lystar-gui-host.bin", "arm64");
	verifyEmbeddedHost(resourceDir, "remote-hosts/darwin-x64/lystar-gui-host.bin", "x86_64");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const appPath = process.argv[2];
	if (!appPath) {
		console.error("Usage: node packages/gui/scripts/verify-macos-bundle.mjs <app-path>");
		process.exit(2);
	}
	verifyMacosBundle(appPath);
	console.log(`Verified ad-hoc signed macOS bundle: ${appPath}`);
}
