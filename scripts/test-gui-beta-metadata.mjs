import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const generator = join(scriptDir, "generate-gui-beta-metadata.mjs");
const projectRoot = resolve(scriptDir, "..");
const version = JSON.parse(readFileSync(join(projectRoot, "packages/gui/package.json"), "utf8")).version;
const repository = JSON.parse(
	readFileSync(join(projectRoot, "packages/coding-agent/package.json"), "utf8"),
).piConfig.releaseRepository;
const assets = {
	"linux-x64": "AppImage",
	"linux-arm64": "AppImage",
	"darwin-arm64": "dmg",
	"darwin-x64": "dmg",
	"windows-x64": "exe",
};

function assetName(platform, extension, releaseVersion = version) {
	return `lystar-code-gui-${releaseVersion}-${platform}.${extension}`;
}

function createArtifacts(directory, releaseVersion = version) {
	for (const [platform, extension] of Object.entries(assets)) {
		writeFileSync(join(directory, assetName(platform, extension, releaseVersion)), `${platform}\n`);
	}
}

function run(directory, releaseVersion = version, releaseRepository = repository) {
	return execFileSync(process.execPath, [generator, directory, releaseVersion, releaseRepository], {
		cwd: projectRoot,
		encoding: "utf8",
		stdio: "pipe",
	});
}

function expectFailure(directory, releaseVersion = version, releaseRepository = repository) {
	assert.throws(
		() => run(directory, releaseVersion, releaseRepository),
		(error) => error && typeof error === "object" && error.status !== 0,
	);
}

const root = mkdtempSync(join(tmpdir(), "lystar-gui-beta-metadata-"));
try {
	const successDir = join(root, "success");
	mkdirSync(successDir);
	createArtifacts(successDir);
	run(successDir);

	const manifest = JSON.parse(readFileSync(join(successDir, "gui-release-manifest.json"), "utf8"));
	assert.deepEqual(
		{ channel: manifest.channel, signed: manifest.signed, version: manifest.version, repository: manifest.repository },
		{ channel: "beta", signed: false, version, repository },
	);
	assert.deepEqual(Object.keys(manifest.assets), Object.keys(assets));

	const sums = readFileSync(join(successDir, "SHA256SUMS"), "utf8").trim().split("\n");
	assert.equal(sums.length, Object.keys(assets).length);
	for (const [platform, extension] of Object.entries(assets)) {
		const file = assetName(platform, extension);
		const contents = readFileSync(join(successDir, file));
		const sha256 = createHash("sha256").update(contents).digest("hex");
		assert.deepEqual(manifest.assets[platform], { file, size: contents.length, sha256 });
		assert.ok(sums.includes(`${sha256}  ${file}`));
	}

	const missingDir = join(root, "missing");
	mkdirSync(missingDir);
	createArtifacts(missingDir);
	rmSync(join(missingDir, assetName("windows-x64", "exe")));
	expectFailure(missingDir);

	const extraDir = join(root, "extra");
	mkdirSync(extraDir);
	createArtifacts(extraDir);
	writeFileSync(join(extraDir, "unexpected.txt"), "unexpected\n");
	expectFailure(extraDir);

	const mismatchDir = join(root, "mismatch");
	mkdirSync(mismatchDir);
	createArtifacts(mismatchDir);
	expectFailure(mismatchDir, "0.0.0");
	expectFailure(mismatchDir, version, "wrong-owner/wrong-repository");

	console.log("GUI beta metadata tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
