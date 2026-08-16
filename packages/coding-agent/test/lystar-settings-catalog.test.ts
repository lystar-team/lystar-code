import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getLystarSettingsForUi,
	LYSTAR_SETTINGS_CATALOG,
	SETTINGS_SELECTOR_PERSISTENT_IDS,
} from "../src/core/lystar-settings-catalog.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const cleanups: string[] = [];

afterEach(() => {
	while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

describe("LYStar settings catalog", () => {
	it("has unique Chinese-labelled descriptors and excludes non-settings surfaces", () => {
		const ids = LYSTAR_SETTINGS_CATALOG.map((setting) => setting.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const setting of LYSTAR_SETTINGS_CATALOG) {
			expect(setting.label).toMatch(/[\u4e00-\u9fff]/u);
			expect(setting.description.trim()).not.toBe("");
		}
		expect(ids).not.toEqual(expect.arrayContaining(["apply", "single-mode", "thinking", "default-model"]));
		expect(ids).not.toEqual(expect.arrayContaining(["extensions", "skills", "prompts", "themes"]));
		expect(SETTINGS_SELECTOR_PERSISTENT_IDS).toEqual(getLystarSettingsForUi().map((setting) => setting.id));
	});

	it("round-trips every boolean and enum option through the descriptor", () => {
		const settings = SettingsManager.inMemory();
		for (const definition of LYSTAR_SETTINGS_CATALOG) {
			if (definition.kind !== "boolean" && definition.kind !== "enum") continue;
			for (const value of definition.options ?? []) {
				definition.set(settings, value);
				expect(definition.get(settings)).toBe(value);
			}
		}
	});

	it("round-trips every string descriptor through the SettingsManager", () => {
		const settings = SettingsManager.inMemory();
		for (const definition of LYSTAR_SETTINGS_CATALOG) {
			if (definition.kind !== "string") continue;
			const value = definition.get(settings);
			definition.set(settings, value);
			expect(definition.get(settings)).toBe(value);
		}
	});

	it("enforces integer ranges without narrowing the manager's permitted values", () => {
		const settings = SettingsManager.inMemory();
		for (const definition of LYSTAR_SETTINGS_CATALOG) {
			const range = definition.range;
			if (!range) continue;
			definition.set(settings, range.min);
			expect(definition.get(settings)).toBe(range.min);
			definition.set(settings, range.max);
			expect(definition.get(settings)).toBe(range.max);
			expect(() => definition.set(settings, range.min - 1)).toThrow();
			if (range.max < Number.MAX_SAFE_INTEGER) {
				expect(() => definition.set(settings, range.max + 1)).toThrow();
			}
		}
	});

	it("writes catalog settings to global scope without modifying project settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "lystar-settings-catalog-"));
		cleanups.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ theme: "light" }));
		const settings = SettingsManager.create(projectDir, agentDir);
		const analytics = LYSTAR_SETTINGS_CATALOG.find((setting) => setting.id === "analytics");
		if (!analytics) throw new Error("missing analytics descriptor");
		expect(analytics.scope).toBe("global");
		analytics.set(settings, true);
		await settings.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			enableAnalytics: true,
		});
		expect(JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8"))).toEqual({ theme: "light" });
	});
});
