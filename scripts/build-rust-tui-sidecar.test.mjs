import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { releasePlatform, sidecarExecutable } from "./build-rust-tui-sidecar.mjs";

test("maps supported native runtimes to release platforms", () => {
	assert.equal(releasePlatform("darwin", "arm64"), "darwin-arm64");
	assert.equal(releasePlatform("darwin", "x64"), "darwin-x64");
	assert.equal(releasePlatform("linux", "arm64"), "linux-arm64");
	assert.equal(releasePlatform("linux", "x64"), "linux-x64");
	assert.equal(releasePlatform("win32", "x64"), "windows-x64");
	assert.throws(() => releasePlatform("win32", "arm64"), /Unsupported Rust TUI release platform/);
});

test("uses the platform executable name", () => {
	assert.equal(sidecarExecutable("linux"), "lystar-tui");
	assert.equal(sidecarExecutable("darwin"), "lystar-tui");
	assert.equal(sidecarExecutable("win32"), "lystar-tui.exe");
});

test("release builders use the production composition root and require the sidecar", () => {
	const unix = readFileSync(new URL("./build-binaries.sh", import.meta.url), "utf8");
	const windows = readFileSync(new URL("./build-windows-release.ps1", import.meta.url), "utf8");
	const packageJson = JSON.parse(
		readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
	);

	assert.match(unix, /npx --yes -p bun@1\.3\.9 bun/);
	assert.match(unix, /scripts\/lystar-bun-cli\.mjs/);
	assert.match(unix, /build-rust-tui-sidecar\.mjs/);
	assert.match(unix, /lystar-tui/);
	assert.match(unix, /lc" --version/);
	assert.match(windows, /scripts\/lystar-bun-cli\.mjs/);
	assert.match(windows, /build-rust-tui-sidecar\.mjs/);
	assert.match(windows, /lystar-tui\.exe/);
	assert.match(packageJson.scripts["build:binary"], /build:rust-tui-sidecar/);
});
