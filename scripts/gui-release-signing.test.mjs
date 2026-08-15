import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEmbeddedHost } from "../packages/gui/scripts/verify-macos-bundle.mjs";
import { guiReleaseSigningErrors } from "./check-gui-release-signing.mjs";

const workflow = readFileSync(new URL("../.github/workflows/gui-release.yml", import.meta.url), "utf8");
const sidecar = readFileSync(new URL("../packages/gui/scripts/build-sidecar.mjs", import.meta.url), "utf8");

test("GUI release keeps macOS signing enabled", () => {
	assert.deepEqual(guiReleaseSigningErrors(workflow, sidecar), []);
	assert.doesNotMatch(workflow, /gui-preflight\/\*\*/);
	const broken = workflow.replace(
		'run: npm --workspace @lystar/code-gui run tauri -- build --ci --bundles "${{ matrix.bundle }}"',
		'run: npm --workspace @lystar/code-gui run tauri -- build --ci --no-sign --bundles "${{ matrix.bundle }}"',
	);
	assert.match(guiReleaseSigningErrors(broken, sidecar).join("\n"), /must not use --no-sign/);
	const publishingPreflight = workflow.replace(
		"  release:\n    if: startsWith(github.ref, 'refs/tags/gui-v')",
		"  release:",
	);
	assert.match(guiReleaseSigningErrors(publishingPreflight, sidecar).join("\n"), /only run for gui-v tags/);
	const duplicatePreflight = workflow.replace('tags:\n      - "gui-v*"', 'branches:\n      - "gui-preflight/**"\n    tags:\n      - "gui-v*"');
	assert.match(guiReleaseSigningErrors(duplicatePreflight, sidecar).join("\n"), /must not rebuild the same commit/);
});

test("macOS verifier extracts the signed Host bytes", () => {
	const directory = mkdtempSync(join(tmpdir(), "lystar-gui-signing-test-"));
	const payloadPath = join(directory, "lystar-gui-host.bin");
	try {
		writeFileSync(payloadPath, Buffer.concat([Buffer.from("LYSTAR-GUI-BINARY/1\n"), Buffer.from("host")]));
		assert.equal(readEmbeddedHost(payloadPath).toString(), "host");
		writeFileSync(payloadPath, "invalid");
		assert.throws(() => readEmbeddedHost(payloadPath), /invalid GUI Host payload header/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
