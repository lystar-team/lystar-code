import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_TOKEN, GITHUB_OUTPUT } = process.env;
if (!GITHUB_API_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_RUN_ATTEMPT || !GITHUB_TOKEN || !GITHUB_OUTPUT) {
	throw new Error("Artifact wait requires the GitHub Actions run context");
}
const [producer, ...names] = process.argv.slice(2);
if (!producer || names.length === 0) throw new Error("Usage: wait-workflow-artifacts.mjs <producer job prefix> <artifact names...>");
const endpoint = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const deadline = Date.now() + 15 * 60_000;
async function readRunJson(path) {
	const response = await fetch(`${endpoint}${path}`, {
		headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Cannot inspect workflow artifacts: HTTP ${response.status}`);
	return response.json();
}
for (let attempt = 0; ; attempt++) {
	const { artifacts } = await readRunJson("/artifacts?per_page=100");
	const ready = names.map((name) => artifacts.find((entry) => entry.name === name && !entry.expired));
	if (ready.every(Boolean)) {
		appendFileSync(GITHUB_OUTPUT, `artifact-ids=${ready.map((entry) => entry.id).join(",")}\n`);
		console.log(`Artifacts are ready: ${names.join(", ")}`);
		break;
	}
	if (attempt % 6 === 0) {
		const { jobs } = await readRunJson(`/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`);
		const failed = jobs.find((job) => job.name.startsWith(producer) && job.status === "completed" && job.conclusion !== "success");
		if (failed) throw new Error(`${failed.name}: ${failed.conclusion}; stopping artifact consumer`);
		console.log(`Waiting for ${names.filter((_, index) => !ready[index]).join(", ")}`);
	}
	if (Date.now() >= deadline) throw new Error(`Workflow artifacts were not ready within 15 minutes: ${names.join(", ")}`);
	await setTimeout(5_000);
}
