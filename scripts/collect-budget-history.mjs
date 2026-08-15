import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function usage() {
	throw new Error("Usage: collect-budget-history.mjs --workflow <file> --artifact <name> --output <directory>");
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--workflow") options.workflow = value;
		else if (argument === "--artifact") options.artifact = value;
		else if (argument === "--output") options.output = value;
		else if (argument === "--limit") options.limit = Number(value);
		else throw new Error(`Unknown argument: ${argument}`);
		index++;
	}
	if (!options.workflow || !options.artifact || !options.output) usage();
	return { ...options, limit: Number.isInteger(options.limit) ? options.limit : 2 };
}

function zipEntries(buffer) {
	const end = buffer.lastIndexOf(Buffer.from("PK\x05\x06"));
	if (end < 0) throw new Error("artifact archive has no ZIP central directory");
	const count = buffer.readUInt16LE(end + 10);
	let offset = buffer.readUInt32LE(end + 16);
	const entries = [];
	for (let index = 0; index < count; index++) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid ZIP central directory entry");
		const compression = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const fileNameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString("utf8");
		entries.push({ name, compression, compressedSize, localOffset });
		offset += 46 + fileNameLength + extraLength + commentLength;
	}
	return entries;
}

export function readJsonFromArtifactArchive(buffer) {
	const candidates = [];
	for (const entry of zipEntries(buffer).filter((candidate) => candidate.name.endsWith(".json"))) {
		if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("invalid ZIP local entry");
		const fileNameLength = buffer.readUInt16LE(entry.localOffset + 26);
		const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
		const start = entry.localOffset + 30 + fileNameLength + extraLength;
		const compressed = buffer.subarray(start, start + entry.compressedSize);
		const content = entry.compression === 0 ? compressed : entry.compression === 8 ? inflateRawSync(compressed) : undefined;
		if (!content) throw new Error(`unsupported ZIP compression method: ${entry.compression}`);
		candidates.push(JSON.parse(content.toString("utf8")));
	}
	const metric = candidates.find((value) => value?.schemaVersion === 1 && typeof value.kind === "string" && typeof value.budgetClass === "string");
	if (!metric) throw new Error("artifact archive contains no workflow budget metric");
	return metric;
}

async function api(path) {
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN;
	if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required for history collection");
	const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${token}`,
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
	return response;
}

export async function collectHistory({ workflow, artifact, output, limit = 2 }) {
	const branch = process.env.GITHUB_REF_NAME ?? "main";
	const currentRunId = String(process.env.GITHUB_RUN_ID ?? "");
	const runsResponse = await api(`/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=30`);
	const runs = (await runsResponse.json()).workflow_runs ?? [];
	const selected = runs.filter((run) => String(run.id) !== currentRunId && run.conclusion === "success").slice(0, limit * 5);
	mkdirSync(output, { recursive: true });
	const collected = [];
	for (const run of selected) {
		if (collected.length >= limit) break;
		try {
			const artifactsResponse = await api(`/actions/runs/${run.id}/artifacts?per_page=100`);
			const artifacts = (await artifactsResponse.json()).artifacts ?? [];
			const match = artifacts.find((candidate) => candidate.name === artifact && !candidate.expired);
			if (!match) continue;
			const archiveResponse = await api(`/actions/artifacts/${match.id}/zip`);
			const value = readJsonFromArtifactArchive(Buffer.from(await archiveResponse.arrayBuffer()));
			const path = resolve(output, `${collected.length}.json`);
			writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
			collected.push({ runId: run.id, path });
		} catch {
			// 单个历史 artifact 损坏或过期时，继续尝试更早的 run。
		}
	}
	return collected;
}

export async function runCli(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	try {
		const history = await collectHistory(options);
		const summary = `## Budget history\n- budget_history: available\n- budget_history_collected: ${history.length}\n`;
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
		process.stdout.write(summary);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unavailable";
		const summary = `## Budget history\n- budget_history: unavailable\n- budget_history_reason: ${reason}\n`;
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
		process.stdout.write(summary);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCli();
