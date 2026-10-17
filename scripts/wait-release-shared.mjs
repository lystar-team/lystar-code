import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_TOKEN, GITHUB_OUTPUT } = process.env;
if (!GITHUB_API_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID || !GITHUB_RUN_ATTEMPT || !GITHUB_TOKEN || !GITHUB_OUTPUT) {
	throw new Error("Shared build wait requires the GitHub Actions run context");
}
const name = `release-shared-${GITHUB_RUN_ATTEMPT}`;
const endpoint = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const deadline = Date.now() + 15 * 60_000;
async function readRunJson(path) {
	const response = await fetch(`${endpoint}${path}`, {
		headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Cannot inspect shared build: HTTP ${response.status}`);
	return response.json();
}
for (let attempt = 0; ; attempt++) {
	const { artifacts } = await readRunJson(`/artifacts?name=${name}&per_page=100`);
	const artifact = artifacts.find((entry) => entry.name === name && !entry.expired);
	if (artifact) {
		appendFileSync(GITHUB_OUTPUT, `artifact-id=${artifact.id}\n`);
		console.log(`Shared artifact is ready: ${artifact.id}`);
		break;
	}
	if (attempt % 6 === 0) {
		const { jobs } = await readRunJson(`/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`);
		const shared = jobs.find((job) => job.name === "Build shared JavaScript and Web");
		if (shared?.status === "completed" && shared.conclusion !== "success") {
			throw new Error(`Shared build ${shared.conclusion}; stopping platform packaging`);
		}
	}
	if (Date.now() >= deadline) throw new Error(`Shared artifact ${name} was not ready within 15 minutes`);
	if (attempt % 6 === 0) console.log(`Waiting for ${name}`);
	await setTimeout(5_000);
}
