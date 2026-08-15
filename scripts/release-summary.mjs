import { appendFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

function number(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function summarizeRelease({ release, sha, fullMatrixCount, artifacts = [], timings = {}, cacheHits = {} }) {
	if (!release) throw new Error("--release is required");
	if (!sha) throw new Error("--sha is required");

	const lines = [
		`## Release ${release}`,
		`- release_full_matrix_count{sha=${sha}}: ${number(fullMatrixCount)}`,
		`- release_wall_seconds: ${number(timings.wall)}`,
		`- release_build_seconds: ${number(timings.build)}`,
		`- release_cache_restore_seconds: ${timings.cache === "unavailable" ? "unavailable" : number(timings.cache)}`,
	];
	for (const artifact of artifacts) {
		const size = statSync(artifact.path).size;
		if (size <= 0) throw new Error(`Release artifact is empty: ${artifact.path}`);
		lines.push(`- release_artifact_bytes{platform=${artifact.platform}}: ${size}`);
	}
	for (const [cache, hit] of Object.entries(cacheHits)) {
		lines.push(`- release_cache_hit{cache=${cache}}: ${hit}`);
	}
	return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
	const options = { artifacts: [], timings: {}, cacheHits: {} };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--release") options.release = value;
		else if (argument === "--sha") options.sha = value;
		else if (argument === "--full-matrix-count") options.fullMatrixCount = value;
		else if (argument === "--artifact") {
			const separator = value.indexOf("=");
			if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid --artifact value: ${value}`);
			options.artifacts.push({ platform: value.slice(0, separator), path: value.slice(separator + 1) });
		} else if (argument === "--timing") {
			const [name, timing] = value.split("=", 2);
			options.timings[name] = timing;
		} else if (argument === "--cache-hit") {
			const [cache, hit] = value.split("=", 2);
			options.cacheHits[cache] = hit;
		} else throw new Error(`Unknown argument: ${argument}`);
		index++;
	}
	return options;
}

export function runCli(argv = process.argv.slice(2)) {
	const output = summarizeRelease(parseArguments(argv));
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
	process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
