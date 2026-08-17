import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifestUrl = new URL("../benchmarks/rust-custom-editor-scenarios.json", import.meta.url);

export const rustCustomEditorManifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

function split(value) {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseSize(value) {
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (!match) throw new Error(`Invalid Rust CustomEditor benchmark size: ${value}`);
	return [Number(match[1]), Number(match[2])];
}

export function rustCustomEditorBenchmarkConfig({ smoke = false, scenarios, sizes } = {}) {
	const selectedScenarios = scenarios ? new Set(scenarios) : undefined;
	const selectedSizes = sizes ? new Set(sizes.map(([columns, rows]) => `${columns}x${rows}`)) : undefined;
	const availableScenarios = rustCustomEditorManifest.scenarios.map((scenario) => scenario.name);
	for (const scenario of selectedScenarios ?? []) {
		if (!availableScenarios.includes(scenario)) throw new Error(`Unknown Rust CustomEditor benchmark scenario: ${scenario}`);
	}
	for (const size of selectedSizes ?? []) {
		if (!rustCustomEditorManifest.sizes.some(([columns, rows]) => `${columns}x${rows}` === size))
			throw new Error(`Unknown Rust CustomEditor benchmark size: ${size}`);
	}
	const selected = rustCustomEditorManifest.scenarios.filter((scenario) => !selectedScenarios || selectedScenarios.has(scenario.name));
	const selectedSizeRows = rustCustomEditorManifest.sizes.filter(
		([columns, rows]) => !selectedSizes || selectedSizes.has(`${columns}x${rows}`),
	);
	if (selected.length === 0 || selectedSizeRows.length === 0) throw new Error("Rust CustomEditor benchmark selection is empty");
	return {
		...rustCustomEditorManifest,
		rounds: smoke ? 1 : rustCustomEditorManifest.rounds,
		scenarios: selected,
		sizes: selectedSizeRows,
	};
}

export function rustCustomEditorBenchmarkConfigFromEnvironment(env = process.env) {
	return rustCustomEditorBenchmarkConfig({
		smoke: env.LYSTAR_RUST_CUSTOM_EDITOR_SMOKE === "1",
		scenarios: env.LYSTAR_RUST_CUSTOM_EDITOR_SCENARIOS
			? split(env.LYSTAR_RUST_CUSTOM_EDITOR_SCENARIOS)
			: undefined,
		sizes: env.LYSTAR_RUST_CUSTOM_EDITOR_SIZES
			? split(env.LYSTAR_RUST_CUSTOM_EDITOR_SIZES).map(parseSize)
			: undefined,
	});
}

export function scenarioExpectedText(scenario) {
	if (scenario.input) return scenario.input.character.repeat(scenario.input.count);
	if (scenario.autocomplete) return scenario.autocomplete.completion;
	return "";
}

export function textHash(value) {
	return createHash("sha256").update(value).digest("hex");
}
