import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import {
	generateReleaseMetadata,
	releaseAssetNames,
	releaseMetadataErrors,
} from "./generate-release-metadata.mjs";

const version = "1.0.0-lystar.1";
const repository = "lystar-team/lystar-code";
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

function createRelease(directory) {
	for (const name of releaseAssetNames(version).slice(0, 5)) {
		writeFileSync(join(directory, name), `archive:${name}\n`);
	}
	generateReleaseMetadata(directory, version, repository);
}

function expectFailure(directory, pattern) {
	assert.match(releaseMetadataErrors(directory, version, repository).join("\n"), pattern);
}

function mutateRelease(root, mutate) {
	const directory = mkdtempSync(join(root, "release-"));
	createRelease(directory);
	mutate(directory);
	return directory;
}

test("CLI release metadata verifies the final ten public assets", () => {
	const root = mkdtempSync(join(tmpdir(), "lystar-release-metadata-"));
	try {
		const release = mutateRelease(root, () => {});
		assert.deepEqual(releaseMetadataErrors(release, version, repository), []);
		assert.equal(releaseAssetNames(version).length, 10);

		const packageTamper = mutateRelease(root, (directory) => {
			writeFileSync(join(directory, releaseAssetNames(version)[0]), "tampered\n");
		});
		expectFailure(packageTamper, /size mismatch|SHA-256 mismatch|SHA256SUMS/);

		const manifestShaTamper = mutateRelease(root, (directory) => {
			const path = join(directory, "release-manifest.json");
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifest.assets["linux-x64"].sha256 = "0".repeat(64);
			writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
		});
		expectFailure(manifestShaTamper, /SHA-256 mismatch: linux-x64/);

		const filenameTamper = mutateRelease(root, (directory) => {
			const path = join(directory, "release-manifest.json");
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifest.assets["windows-x64"].file = "renamed.zip";
			writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
		});
		expectFailure(filenameTamper, /filename mismatch: windows-x64/);

		const countTamper = mutateRelease(root, (directory) => {
			const path = join(directory, "release-manifest.json");
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			delete manifest.assets["darwin-x64"];
			writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
		});
		expectFailure(countTamper, /exactly five platform assets|asset is missing: darwin-x64/);

		const extraAsset = mutateRelease(root, (directory) => {
			writeFileSync(join(directory, "unexpected.txt"), "unexpected\n");
		});
		expectFailure(extraAsset, /unexpected release directory entry/);

		const repositoryTamper = mutateRelease(root, (directory) => {
			const path = join(directory, "release-manifest.json");
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifest.repository = "wrong-owner/wrong-repository";
			writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
		});
		expectFailure(repositoryTamper, /repository mismatch/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("CLI release workflow verifies a candidate before tagging and publishing", () => {
	const document = parseDocument(workflow);
	assert.deepEqual(document.errors, []);
	const parsed = document.toJS();
	assert.deepEqual(parsed.on.workflow_dispatch.inputs.publish.type, "boolean");
	assert.equal(parsed.on.workflow_dispatch.inputs.ref.default, "main");
	assert.equal(parsed.jobs["verify-ci"], undefined);
	assert.equal(parsed.jobs["build-unix"].strategy["fail-fast"], true);
	const jobs = parsed.jobs;
	const unixUpload = jobs["build-unix"].steps.find((step) => step.name === "Upload Unix release candidate");
	const windowsUpload = jobs["build-windows"].steps.find((step) => step.name === "Upload Windows release candidate");
	assert.deepEqual(
		jobs["build-unix"].strategy.matrix.include.map(({ platform, runner }) => [platform, runner]),
		[
			["darwin-arm64", "macos-15"],
			["darwin-x64", "macos-15-intel"],
			["linux-arm64", "ubuntu-24.04-arm"],
			["linux-x64", "ubuntu-24.04"],
		],
	);
	assert.equal(unixUpload.with.path, "packages/coding-agent/binaries/lystar-agent-*-${{ matrix.platform }}.tar.gz");
	assert.equal(windowsUpload.with.path, "packages/coding-agent/binaries/lystar-agent-*-windows-x64.zip");
	const candidate = jobs["verify-candidate"];
	assert.match(candidate.if, /build-unix\.result == 'success'/);
	assert.match(candidate.steps.find((step) => step.name === "Generate and verify release metadata").run, /sha256sum -c SHA256SUMS/);
	assert.match(candidate.steps.find((step) => step.name === "Generate and verify release metadata").run, /generate-release-metadata\.mjs --verify/);
	assert.equal(jobs.publish.needs, "verify-candidate");
	assert.match(jobs.publish.if, /inputs\.publish == true/);
	assert.match(jobs.publish.steps.find((step) => step.name === "Create version tag after candidate verification").run, /git tag/);
	assert.match(jobs.publish.steps.find((step) => step.name === "Create version tag after candidate verification").run, /git push origin/);
	assert.deepEqual(parsed.on.push.tags, ["v*-lystar.*"]);
	assert.doesNotMatch(workflow, /ci-budget|release-summary|release-budget-metrics/);
});
