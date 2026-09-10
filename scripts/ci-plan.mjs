import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GATES = ["validate", "core", "coding", "web", "platform"];

export const TEST_PACKAGES = Object.freeze({
	core: [
		"@earendil-works/chord",
		"@earendil-works/pi-tui",
		"@earendil-works/pi-telemetry",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-protocol",
		"@earendil-works/pi-client",
		"@earendil-works/pi-session-backend-sqlite-node",
		"@earendil-works/pi-server",
	],
	coding: ["@earendil-works/pi-coding-agent"],
	web: [
		"@lystar/code-web-protocol",
		"@lystar/code-web-runtime",
		"@lystar/code-web",
		"@lystar/code-web-gateway",
	],
});

const FULL_GATES = new Set(GATES);
const PACKAGE_GROUPS = new Map([
	["chord", ["core", "@earendil-works/chord"]],
	["telemetry", ["core", "@earendil-works/pi-telemetry"]],
	["ai", ["core", "@earendil-works/pi-ai"]],
	["agent", ["core", "@earendil-works/pi-agent-core"]],
	["protocol", ["core", "@earendil-works/pi-protocol"]],
	["client", ["core", "@earendil-works/pi-client"]],
	["server", ["core", "@earendil-works/pi-server"]],
	["tui", ["core", "@earendil-works/pi-tui"]],
	["coding-agent", ["coding", "@earendil-works/pi-coding-agent"]],
	["web", ["web", "@lystar/code-web"]],
	["web-runtime", ["web", "@lystar/code-web-runtime"]],
	["web-protocol", ["web", "@lystar/code-web-protocol"]],
	["web-gateway", ["web", "@lystar/code-web-gateway"]],
	["session-backends", ["core", "@earendil-works/pi-session-backend-sqlite-node"]],
]);

function emptyPlan(mode) {
	return {
		mode,
		wouldRun: Object.fromEntries(GATES.map((gate) => [gate, false])),
		reasons: Object.fromEntries(GATES.map((gate) => [gate, []])),
		tests: Object.fromEntries(Object.keys(TEST_PACKAGES).map((group) => [group, []])),
	};
}

function normalizePath(path) {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized.startsWith("/") || normalized.startsWith("../") || normalized.includes("/../")) {
		return undefined;
	}
	return normalized;
}

function mark(plan, gates, reason) {
	for (const gate of gates) {
		plan.wouldRun[gate] = true;
		if (!plan.reasons[gate].includes(reason)) plan.reasons[gate].push(reason);
	}
}

function addTests(plan, group, packageName, reason) {
	if (!Object.hasOwn(plan.tests, group)) throw new Error(`Unknown test group: ${group}`);
	if (!plan.tests[group].includes(packageName)) plan.tests[group].push(packageName);
	mark(plan, ["validate", group], reason);
}

function markFull(plan, reason) {
	mark(plan, FULL_GATES, reason);
	for (const [group, packages] of Object.entries(TEST_PACKAGES)) {
		for (const packageName of packages) addTests(plan, group, packageName, reason);
	}
}

function markValidation(plan, reason) {
	mark(plan, ["validate"], reason);
}

function isDocumentation(path) {
	return path === "README.md" || path.startsWith("docs/") || path.startsWith("features/") || path.endsWith(".md");
}

function isReleaseScript(path) {
	return [
		"scripts/build-binaries.sh",
		"scripts/build-windows-release.ps1",
		"scripts/build-windows-terminal.ps1",
		"scripts/generate-release-metadata.mjs",
		"scripts/lystar-bun-cli.mjs",
		"scripts/prepare-release-package.mjs",
		"scripts/test-install-ps1.ps1",
		"scripts/test-install-sh.sh",
		"scripts/test-windows-managed-bash.mjs",
		"scripts/test-windows-terminal.ps1",
		"scripts/test-windows-web.mjs",
	].includes(path);
}

function isPlatformScript(path) {
	return path === "scripts/run-coding-agent-platform-tests.mjs";
}
function classifyPath(plan, path, status) {
	if (status === "D") {
		markFull(plan, `deleted file: ${path}`);
		return;
	}
	if (isDocumentation(path)) return;

	if (path.startsWith(".github/")) {
		markValidation(plan, `workflow configuration: ${path}`);
		return;
	}

	if (
		path === "package-lock.json" ||
		path === "package.json" ||
		path.endsWith("/package.json") ||
		path.endsWith("/npm-shrinkwrap.json") ||
		path.startsWith("packages/coding-agent/install-lock/") ||
		path.startsWith(".git/") ||
		path.startsWith(".npmrc") ||
		path.startsWith("tsconfig") ||
		path === "vitest.base.ts"
	) {
		markFull(plan, `repository contract: ${path}`);
		return;
	}

	if (path.startsWith("scripts/")) {
		if (path.startsWith("scripts/ci-plan") || path === "scripts/extended-quality-workflow.test.mjs") {
			markValidation(plan, `CI planner or workflow test: ${path}`);
			return;
		}
		if (isReleaseScript(path)) {
			mark(plan, ["validate", "platform"], `release script: ${path}`);
			return;
		}
		if (isPlatformScript(path)) {
			mark(plan, ["validate", "platform"], `platform test script: ${path}`);
			return;
		}
		markValidation(plan, `repository script: ${path}`);
		return;
	}

	if (path.startsWith("packages/session-backends/sqlite-node/")) {
		addTests(plan, "core", "@earendil-works/pi-session-backend-sqlite-node", `workspace: ${path}`);
		return;
	}

	const packageMatch = /^packages\/([^/]+)/.exec(path);
	if (!packageMatch) {
		markFull(plan, `unknown path: ${path}`);
		return;
	}

	if (packageMatch[1] === "evals") {
		markValidation(plan, `evaluation workspace: ${path}`);
		return;
	}

	const packageInfo = PACKAGE_GROUPS.get(packageMatch[1]);
	if (!packageInfo) {
		markFull(plan, `unknown workspace: ${path}`);
		return;
	}

	const [group, packageName] = packageInfo;
	addTests(plan, group, packageName, `workspace: ${path}`);
	if (/windows|win32|\.ps1$/i.test(path)) {
		mark(plan, ["platform"], `Windows path: ${path}`);
	}
}

export function createPlan(changes, mode = "enforce") {
	if (mode !== "observe" && mode !== "enforce") throw new Error(`Unsupported CI plan mode: ${mode}`);
	const plan = emptyPlan(mode);
	if (!Array.isArray(changes) || changes.length === 0) {
		markFull(plan, "no changed files available");
	} else {
		for (const change of changes) {
			const entry = typeof change === "string" ? { path: change, status: "M" } : change;
			const path = normalizePath(entry?.path ?? "");
			if (!path || !["A", "C", "D", "M", "R", "T"].includes(entry?.status ?? "M")) {
				markFull(plan, "unparseable changed-file entry");
				continue;
			}
			classifyPath(plan, path, entry.status ?? "M");
		}
	}

	const execution = Object.fromEntries(GATES.map((gate) => [gate, mode === "observe" || plan.wouldRun[gate]]));
	const tests = Object.fromEntries(Object.entries(plan.tests).map(([group, packages]) => [
		group,
		mode === "observe" ? [...TEST_PACKAGES[group]] : packages,
	]));
	return { ...plan, execution, tests };
}

export function parseNameStatus(output) {
	if (output === "") return [];

	const fields = output.split("\0");
	const terminated = fields.at(-1) === "";
	if (terminated) fields.pop();

	const changes = [];
	for (let index = 0; index < fields.length; ) {
		const status = fields[index++];
		if (!status) throw new Error("Unexpected empty token in git diff output");

		const match = /^(A|D|M|T|[CR]\d{1,3})$/.exec(status);
		if (!match) throw new Error(`Unsupported git diff status: ${status}`);

		const kind = match[1][0];
		const firstPath = fields[index++];
		if (firstPath === undefined) throw new Error(`Missing path for git diff status: ${status}`);
		if (!firstPath) throw new Error(`Unexpected empty path token for git diff status: ${status}`);

		if (kind === "R" || kind === "C") {
			const secondPath = fields[index++];
			if (secondPath === undefined) throw new Error(`Missing renamed path for git diff status: ${status}`);
			if (!secondPath) throw new Error(`Unexpected empty renamed path token for git diff status: ${status}`);
			changes.push({ path: firstPath, status: kind }, { path: secondPath, status: kind });
			continue;
		}
		changes.push({ path: firstPath, status: kind });
	}

	if (!terminated) throw new Error("Unterminated git diff --name-status output");
	return changes;
}

export function gitChanges(base, head) {
	if (!base || !head) throw new Error("Both --base and --head are required");
	const output = execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", base, head], {
		encoding: "utf8",
	});
	return parseNameStatus(output);
}

function parseArguments(argv) {
	const options = { changedFiles: [] };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--base") options.base = value;
		else if (argument === "--head") options.head = value;
		else if (argument === "--mode") options.mode = value;
		else if (argument === "--changed-file") options.changedFiles.push(value);
		else if (argument === "--json") options.jsonPath = value;
		else if (argument === "--github-output") options.githubOutput = value;
		else throw new Error(`Unknown argument: ${argument}`);
		index++;
	}
	return options;
}

function writeGithubOutput(path, plan) {
	const lines = GATES.map((gate) => `${gate}=${plan.execution[gate]}`);
	lines.push(
		`core_tests=${JSON.stringify(plan.tests.core)}`,
		`web_tests=${JSON.stringify(plan.tests.web)}`,
		`mode=${plan.mode}`,
		`plan=${JSON.stringify(plan)}`,
	);
	writeFileSync(path, `${lines.join("\n")}\n`, { flag: "a" });
}

export function runCli(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	const mode = options.mode ?? process.env.CI_PLAN_MODE ?? "enforce";
	let changes = options.changedFiles;
	let fallbackReason;
	if (options.base || options.head) {
		try {
			changes = gitChanges(options.base, options.head);
		} catch (error) {
			fallbackReason = error instanceof Error ? error.message : String(error);
			changes = [];
		}
	}
	const plan = createPlan(changes, mode);
	if (fallbackReason) {
		for (const gate of GATES) {
			const reason = `git diff failed: ${fallbackReason}`;
			if (!plan.reasons[gate].includes(reason)) plan.reasons[gate].push(reason);
		}
	}
	const serialized = `${JSON.stringify(plan, null, 2)}\n`;
	if (options.jsonPath) writeFileSync(options.jsonPath, serialized);
	if (options.githubOutput) writeGithubOutput(options.githubOutput, plan);
	process.stdout.write(serialized);
	return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
