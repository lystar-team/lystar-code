import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const profileScript = fileURLToPath(new URL("./profile-markdown-render.mjs", import.meta.url));
const expectedFixtures = ["continuous-64kb", "code-block-500-lines", "table-50x20", "mermaid-large-source"];

test("Markdown profile script reports deterministic fixture timings", () => {
	const result = spawnSync(process.execPath, ["--import", "tsx", profileScript], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);

	const report = JSON.parse(result.stdout);
	assert.equal(report.width, 80);
	assert.deepEqual(
		report.fixtures.map((fixture) => fixture.name),
		expectedFixtures,
	);

	for (const fixture of report.fixtures) {
		assert.ok(fixture.outputLines > 0);
		assert.equal(fixture.profiles.length, 2);
		const [initial, cached] = fixture.profiles;
		for (const profile of fixture.profiles) {
			assert.ok(profile.bytes > 0);
			assert.equal(profile.width, 80);
			assert.ok(profile.transformMs >= 0);
			assert.ok(profile.parseMs >= 0);
			assert.ok(profile.renderMs >= 0);
			assert.ok(profile.totalMs >= 0);
		}
		assert.equal(initial.cached, false);
		assert.equal(cached.cached, true);
		assert.equal(cached.transformMs, 0);
		assert.equal(cached.parseMs, 0);
		assert.equal(cached.renderMs, 0);
	}
});
