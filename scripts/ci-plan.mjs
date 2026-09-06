import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GATES = ["source", "core", "coding", "platform", "web", "release"];

const FULL_GATES = new Set(GATES);
const PUBLIC_PACKAGES = new Set([
	"ai",
	"agent",
	"client",
	"protocol",
	"server",
	"session-backends",
	"telemetry",
	"tui",
]);

function emptyPlan(mode) {
	return {
		mode,
		wouldRun: Object.fromEntries(GATES.map((gate) => [gate, false])),
		reasons: Object.fromEntries(GATES.map((gate) => [gate, []])),
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

function markFull(plan, reason) {
	mark(plan, FULL_GATES, reason);
}

function isDocumentation(path) {
	return path === "README.md" || path.startsWith("docs/") || path.startsWith("features/") || path.endsWith(".md");
}

function classifyPath(plan, path, status) {
	if (status === "D") {
		markFull(plan, `deleted file: ${path}`);
		return;
	}
	if (isDocumentation(path)) return;

	if (
		path === "package-lock.json" ||
		path === "package.json" ||
		path.endsWith("/npm-shrinkwrap.json") ||
		path.startsWith("packages/coding-agent/install-lock/") ||
		path.startsWith(".github/") ||
		path.startsWith(".git/") ||
		path.startsWith(".npmrc") ||
		path.startsWith("tsconfig") ||
		path === "vitest.base.ts"
	) {
		markFull(plan, `repository contract: ${path}`);
		return;
	}

	if (path.startsWith("scripts/")) {
		if (path.startsWith("scripts/ci-plan") || path.startsWith("scripts/ci-summary")) {
			mark(plan, ["source"], `CI script: ${path}`);
			return;
		}
		markFull(plan, `build or installer script: ${path}`);
		return;
	}

	const packageMatch = /^packages\/([^/]+)/.exec(path);
	if (!packageMatch) {
		markFull(plan, `unknown path: ${path}`);
		return;
	}

	const packageName = packageMatch[1];
	if (PUBLIC_PACKAGES.has(packageName)) {
		markFull(plan, `public workspace: packages/${packageName}`);
		return;
	}
	if (packageName === "coding-agent") {
		mark(plan, ["source", "coding", "web"], `Coding Agent: ${path}`);
		if (/windows|win32|\.ps1$/i.test(path)) mark(plan, ["platform"], `Windows path: ${path}`);
		return;
	}
	if (packageName === "web" || packageName === "web-runtime" || packageName === "web-protocol" || packageName === "web-gateway") {
		mark(plan, ["source", "web"], `Web workspace: ${path}`);
		return;
	}
	if (packageName === "evals") {
		mark(plan, ["source"], `evaluation workspace: ${path}`);
		return;
	}

	markFull(plan, `unknown workspace: ${path}`);
}

/**
 * Maps changed files to the existing CI gates. Unknown and repository-wide
 * changes deliberately select every gate so the caller can fail open.
 */
export function createPlan(changes, mode = "observe") {
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
	return {
		...plan,
		execution: Object.fromEntries(GATES.map((gate) => [gate, mode === "observe" || plan.wouldRun[gate]])),
	};
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
		if (argument !== "--changed-file") index++;
		else index++;
	}
	return options;
}

function writeGithubOutput(path, plan) {
	const lines = GATES.map((gate) => `${gate}=${plan.wouldRun[gate]}`);
	lines.push(`mode=${plan.mode}`, `plan=${JSON.stringify(plan)}`);
	writeFileSync(path, `${lines.join("\n")}\n`, { flag: "a" });
}

export function runCli(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	const mode = options.mode ?? process.env.CI_PLAN_MODE ?? "observe";
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
			if (!plan.reasons[gate].includes(`git diff failed: ${fallbackReason}`)) {
				plan.reasons[gate].push(`git diff failed: ${fallbackReason}`);
			}
		}
	}
	const serialized = `${JSON.stringify(plan, null, 2)}\n`;
	if (options.jsonPath) writeFileSync(options.jsonPath, serialized);
	if (options.githubOutput) writeGithubOutput(options.githubOutput, plan);
	process.stdout.write(serialized);
	return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
