import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type ChangelogEntry, getFullChangelogMarkdown, normalizeChangelogLinks } from "../src/utils/changelog.ts";

const cleanups: string[] = [];

afterEach(() => {
	for (const directory of cleanups.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("loads every packaged entry and pins its relative links", () => {
		const directory = mkdtempSync(join(tmpdir(), "lystar-changelog-"));
		cleanups.push(directory);
		const changelogPath = join(directory, "CHANGELOG.md");
		writeFileSync(changelogPath, "# Changelog\n\n## [1.2.3]\n\n[Docs](docs/test.md)\n\n## 1.2.2\n\nOlder entry\n");

		const markdown = getFullChangelogMarkdown(changelogPath);
		expect(markdown).toContain("https://github.com/earendil-works/pi/blob/v1.2.3/packages/coding-agent/docs/test.md");
		expect(markdown).toContain("## 1.2.2");
		expect(getFullChangelogMarkdown(join(directory, "missing.md"))).toBe("没有更新记录。");
	});

	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/earendil-works/pi/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/earendil-works/pi/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("canonicalizes old repository URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/earendil-works/pi/pull/5167)",
				"[#4163](https://github.com/earendil-works/pi/issues/4163)",
				"[Agent README](https://github.com/earendil-works/pi/blob/v0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});
