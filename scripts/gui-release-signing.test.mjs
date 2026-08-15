import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readEmbeddedHost } from "../packages/gui/scripts/verify-macos-bundle.mjs";
import { guiReleaseSigningErrors } from "./check-gui-release-signing.mjs";

const workflow = readFileSync(new URL("../.github/workflows/gui-release.yml", import.meta.url), "utf8");
const sidecar = readFileSync(new URL("../packages/gui/scripts/build-sidecar.mjs", import.meta.url), "utf8");
const collector = readFileSync(new URL("./collect-gui-beta-artifact.mjs", import.meta.url), "utf8");

function expectContractFailure(broken, pattern) {
	assert.match(guiReleaseSigningErrors(broken, sidecar, collector).join("\n"), pattern);
}

test("GUI release keeps one protected, dispatch-only five-platform publish flow", () => {
	assert.deepEqual(guiReleaseSigningErrors(workflow, sidecar, collector), []);

	const tagTrigger = workflow.replace(
		"on:\n  workflow_dispatch:",
		'on:\n  push:\n    tags:\n      - "gui-v*"\n  workflow_dispatch:',
	);
	expectContractFailure(tagTrigger, /only use workflow_dispatch|must not be triggered by gui-v tags/);

	const earlyTag = workflow.replace(
		"      - name: Generate GUI beta metadata",
		"      - name: Create annotated GUI tag early\n        run: git tag -a early -m early\n\n      - name: Generate GUI beta metadata",
	);
	expectContractFailure(earlyTag, /annotated tag must be created only in the publish job|tag must be created after/);

	const noEnvironment = workflow.replace("    environment: gui-release\n", "");
	expectContractFailure(noEnvironment, /require the gui-release environment approval/);

	const duplicateMatrix = workflow.replace(
		"          - platform: linux-arm64\n            runner: ubuntu-24.04-arm",
		"          - platform: linux-x64\n            runner: ubuntu-24.04\n            bundle: appimage\n            extension: AppImage\n          - platform: linux-arm64\n            runner: ubuntu-24.04-arm",
	);
	expectContractFailure(duplicateMatrix, /build matrix must contain each platform exactly once/);

	const unsignedMacBuild = workflow.replace(
		'run: |\n          started=$SECONDS\n          npm --workspace @lystar/code-gui run tauri -- build --ci --bundles "${{ matrix.bundle }}"',
		'run: |\n          started=$SECONDS\n          npm --workspace @lystar/code-gui run tauri -- build --ci --no-sign --bundles "${{ matrix.bundle }}"',
	);
	expectContractFailure(unsignedMacBuild, /macOS GUI build must not use --no-sign/);

	const noArtifactUpload = workflow.replace("          path: ${{ runner.temp }}/gui-release/*\n          if-no-files-found: error\n", "");
	expectContractFailure(noArtifactUpload, /must upload its collected platform artifact/);

	const noManifestCheck = workflow.replace(
		"node scripts/generate-gui-beta-metadata.mjs gui-release \"$VERSION\" \"$GITHUB_REPOSITORY\"",
		"true",
	);
	expectContractFailure(noManifestCheck, /must verify artifacts, SHA256SUMS, and manifest/);

	const noAttestation = workflow.replace(
		"actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be",
		"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
	);
	expectContractFailure(noAttestation, /must attest release artifacts and manifest/);

	assert.match(
		guiReleaseSigningErrors(workflow, sidecar, collector.replace("PE machine mismatch", "removed")).join("\n"),
		/checked for Linux ELF and Windows PE architectures/,
	);
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
