import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const [base, head = "HEAD"] = process.argv.slice(2);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
}

function readState(ref) {
	const lock = JSON.parse(git("show", `${ref}:package-lock.json`));
	const workspaces = new Map();
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path.startsWith("node_modules/") && entry.link && lock.packages[entry.resolved]) {
			workspaces.set(path.slice("node_modules/".length), {
				directory: entry.resolved,
				manifest: lock.packages[entry.resolved],
			});
		}
	}
	return { lock, workspaces };
}

function normalizeManifest(manifest, workspaces) {
	const normalized = structuredClone(manifest);
	if (/^\d+\.\d+\.\d+-lystar\.\d+$/.test(normalized.version)) normalized.version = "workspace";
	for (const field of dependencyFields) {
		for (const [name, version] of Object.entries(normalized[field] ?? {})) {
			const match = /^([~^]?)(.+)$/.exec(version);
			if (match && match[2] === workspaces.get(name)?.manifest.version)
				normalized[field][name] = `${match[1]}workspace`;
		}
	}
	return normalized;
}

function normalizeLock({ lock, workspaces }) {
	const normalized = normalizeManifest(lock, workspaces);
	for (const [path, entry] of Object.entries(normalized.packages)) {
		if (!path.includes("node_modules")) normalized.packages[path] = normalizeManifest(entry, workspaces);
	}
	return normalized;
}

let changed = true;
if (base && !/^0+$/.test(base)) {
	const before = readState(base);
	const after = readState(head);
	const directories = new Set(["packages/env", "packages/durable"]);
	// 同时沿用变更前后的依赖关系，新增或移除依赖也会触发验证。
	for (const state of [before, after]) {
		const pending = [...directories];
		const visited = new Set();
		while (pending.length) {
			const directory = pending.pop();
			if (visited.has(directory)) continue;
			visited.add(directory);
			const manifest = state.lock.packages[directory];
			for (const field of dependencyFields) {
				for (const name of Object.keys(manifest?.[field] ?? {})) {
					const dependency = state.workspaces.get(name);
					if (!dependency) continue;
					directories.add(dependency.directory);
					pending.push(dependency.directory);
				}
			}
		}
	}

	const files = git("diff", "--name-status", "--no-renames", "-z", base, head, "--").split("\0");
	changed = false;
	for (let index = 0; index < files.length - 1; index += 2) {
		const status = files[index];
		const path = files[index + 1];
		const relevant =
			path === "package.json" ||
			path === "package-lock.json" ||
			/^tsconfig[^/]*\.json$/.test(path) ||
			path === ".github/workflows/env.yml" ||
			path === ".github/workflows/env-daemons.yml" ||
			path === "scripts/check-env-changes.mjs" ||
			path === "scripts/build-workspace.mjs" ||
			path === "scripts/write-npm-cache-key.mjs" ||
			[...directories].some((directory) => path.startsWith(`${directory}/`));
		if (!relevant) continue;
		if (status === "M") {
			if (/\/(README|CHANGELOG)\.md$/.test(path)) continue;
			if (path === "package-lock.json" && isDeepStrictEqual(normalizeLock(before), normalizeLock(after))) continue;
			if (path === "package.json" || path.endsWith("/package.json")) {
				const oldManifest = normalizeManifest(JSON.parse(git("show", `${base}:${path}`)), before.workspaces);
				const newManifest = normalizeManifest(JSON.parse(git("show", `${head}:${path}`)), after.workspaces);
				if (isDeepStrictEqual(oldManifest, newManifest)) continue;
			}
		}
		changed = true;
		console.log(`Execution environment input changed: ${path}`);
		break;
	}
}

console.log(`changed=${changed}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
