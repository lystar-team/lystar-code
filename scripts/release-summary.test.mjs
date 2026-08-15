import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarizeRelease, summarizeReleaseMetrics } from "./release-summary.mjs";

test("release summary also exposes documented metrics as JSON", () => {
	const directory = mkdtempSync(join(tmpdir(), "lystar-release-summary-"));
	const artifact = join(directory, "artifact");
	try {
		writeFileSync(artifact, "artifact");
		const metrics = summarizeReleaseMetrics({
			release: "cli",
			sha: "abc123",
			fullMatrixCount: 1,
			artifacts: [{ platform: "linux-x64", path: artifact }],
			timings: { wall: 12, build: 8, cache: 1 },
		});
		assert.equal(metrics.schemaVersion, 1);
		assert.equal(metrics.kind, "release-job");
		assert.equal(metrics.metrics.release_wall_seconds, 12);
		assert.equal(metrics.metrics.release_runner_seconds_total, 12);
		assert.equal(metrics.artifactBytes["linux-x64"], 8);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("release summary reports matrix, artifact bytes, timings, and cache state", () => {
	const directory = mkdtempSync(join(tmpdir(), "lystar-release-summary-"));
	const artifact = join(directory, "lystar-code-gui.AppImage");
	try {
		writeFileSync(artifact, "artifact");
		const output = summarizeRelease({
			release: "gui",
			sha: "abc123",
			fullMatrixCount: 1,
			artifacts: [{ platform: "linux-x64", path: artifact }],
			timings: { wall: 12, build: 8, cache: "unavailable" },
			cacheHits: { npm: "true", rust: "false" },
		});
		assert.match(output, /release_full_matrix_count\{sha=abc123\}: 1/);
		assert.match(output, /release_artifact_bytes\{platform=linux-x64\}: 8/);
		assert.match(output, /release_wall_seconds: 12/);
		assert.match(output, /release_build_seconds: 8/);
		assert.match(output, /release_cache_restore_seconds: unavailable/);
		assert.match(output, /release_cache_hit\{cache=npm\}: true/);
		assert.match(output, /release_cache_hit\{cache=rust\}: false/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("release summary rejects an empty artifact", () => {
	const directory = mkdtempSync(join(tmpdir(), "lystar-release-summary-"));
	const artifact = join(directory, "empty");
	try {
		writeFileSync(artifact, "");
		assert.throws(
			() => summarizeRelease({ release: "cli", sha: "abc123", artifacts: [{ platform: "linux-x64", path: artifact }] }),
			/Release artifact is empty/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
