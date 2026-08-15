import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const workflowPath = new URL("../.github/workflows/gui-release.yml", import.meta.url);
const sidecarPath = new URL("../packages/gui/scripts/build-sidecar.mjs", import.meta.url);
const collectorPath = new URL("./collect-gui-beta-artifact.mjs", import.meta.url);

const platforms = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"];
const pinnedAction = /^[\w/-]+@[0-9a-f]{40}$/;

function parseWorkflow(workflow, errors) {
	const document = parseDocument(workflow);
	if (document.errors.length > 0) {
		errors.push(`invalid GUI release workflow YAML: ${document.errors.map((error) => error.message).join("; ")}`);
		return {};
	}
	const value = document.toJS();
	if (!value || typeof value !== "object") {
		errors.push("invalid GUI release workflow root");
		return {};
	}
	return value;
}

function steps(job) {
	return Array.isArray(job?.steps) ? job.steps : [];
}

function step(job, name) {
	return steps(job).find((candidate) => candidate?.name === name);
}

function command(stepValue) {
	return typeof stepValue?.run === "string" ? stepValue.run : "";
}

function hasReadOnlyPermissions(permissions) {
	return !permissions || Object.values(permissions).every((value) => value === "read" || value === "none");
}

function matchingPlatformMatrices(jobs) {
	return Object.entries(jobs ?? {}).filter(([, job]) => {
		const include = job?.strategy?.matrix?.include;
		if (!Array.isArray(include)) return false;
		const matrixPlatforms = include.map((entry) => entry?.platform).filter(Boolean);
		return platforms.every((platform) => matrixPlatforms.includes(platform));
	});
}

export function guiReleaseSigningErrors(workflow, sidecar, collector = "") {
	const errors = [];
	const parsed = parseWorkflow(workflow, errors);
	const jobs = parsed.jobs && typeof parsed.jobs === "object" ? parsed.jobs : {};
	const trigger = parsed.on;
	if (!trigger || typeof trigger !== "object" || Object.keys(trigger).length !== 1 || !("workflow_dispatch" in trigger)) {
		errors.push("GUI release must only use workflow_dispatch");
	}
	if (workflow.includes("refs/tags/gui-v") || workflow.includes('"gui-v*"')) {
		errors.push("GUI release must not be triggered by gui-v tags");
	}
	if (workflow.includes("gui-preflight/**")) {
		errors.push("GUI release must not rebuild the same commit through a preflight branch");
	}
	if (parsed?.concurrency?.group !== "gui-release-${{ github.sha }}" || parsed?.concurrency?.["cancel-in-progress"] !== false) {
		errors.push("GUI release must serialize runs for the same SHA without cancellation");
	}
	if (parsed?.permissions?.contents !== "read" || !hasReadOnlyPermissions(parsed.permissions)) {
		errors.push("GUI release default permissions must be read-only");
	}

	for (const action of workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
		if (!pinnedAction.test(action[1])) errors.push(`GUI release action must use a full commit SHA: ${action[1]}`);
	}

	const verify = jobs["verify-ci"];
	if (!verify || verify?.permissions?.actions !== "read" || verify?.permissions?.contents !== "read") {
		errors.push("GUI verification job must only read actions and contents");
	}
	if (
		verify?.outputs?.version !== "${{ steps.gui-version.outputs.version }}" ||
		verify?.outputs?.tag !== "${{ steps.gui-version.outputs.tag }}" ||
		verify?.outputs?.skip !== "${{ steps.existing-release.outputs.skip }}"
	) {
		errors.push("GUI verification job must expose version, tag, and duplicate-release outputs");
	}
	const versionStep = step(verify, "Read GUI version from the selected ref");
	if (!command(versionStep).includes("./packages/gui/package.json") || !command(versionStep).includes("tag=gui-v$version")) {
		errors.push("GUI release must derive its tag from packages/gui/package.json on the selected ref");
	}
	const existingRelease = step(verify, "Skip an already published GUI version");
	if (
		!command(existingRelease).includes("git ls-remote") ||
		!command(existingRelease).includes("gh release view") ||
		!command(existingRelease).includes("skip=true")
	) {
		errors.push("GUI release must exit before the matrix when its tag or release already exists");
	}
	const waitForCi = step(verify, "Wait for successful main CI for this commit");
	if (
		waitForCi?.if !== "steps.existing-release.outputs.skip != 'true'" ||
		!command(waitForCi).includes("head_sha=${GITHUB_SHA}") ||
		!command(waitForCi).includes('head_branch == "main"')
	) {
		errors.push("GUI release must wait for successful main CI for its exact SHA");
	}

	for (const name of ["prepare-remote-hosts", "prepare-darwin-remote-hosts", "merge-remote-hosts", "build", "publish"]) {
		if (jobs[name]?.if !== "needs.verify-ci.outputs.skip != 'true'") {
			errors.push(`GUI ${name} job must not run after an existing tag or release is found`);
		}
	}

	const fullMatrices = matchingPlatformMatrices(jobs);
	if (fullMatrices.length !== 1 || fullMatrices[0]?.[0] !== "build") {
		errors.push("GUI release must contain exactly one five-platform build matrix");
	} else {
		const buildPlatforms = fullMatrices[0][1].strategy.matrix.include.map((entry) => entry.platform);
		if (buildPlatforms.length !== platforms.length || new Set(buildPlatforms).size !== platforms.length) {
			errors.push("GUI release build matrix must contain each platform exactly once");
		}
	}

	const build = jobs.build;
	if (!Array.isArray(build?.needs) || !build.needs.includes("merge-remote-hosts")) {
		errors.push("GUI build matrix must depend on the verified Remote Host set");
	}
	if (steps(build).filter((candidate) => /\bnpm ci\b/.test(command(candidate))).length !== 1) {
		errors.push("each GUI build matrix job may install dependencies only once");
	}
	const guiArtifactUpload = step(build, "Upload GUI release artifact");
	if (guiArtifactUpload?.uses !== "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" || guiArtifactUpload?.with?.path !== "${{ runner.temp }}/gui-release/*") {
		errors.push("GUI build matrix must upload its collected platform artifact");
	}
	const rustCache = step(build, "Cache Rust dependencies");
	const rustCachePaths = typeof rustCache?.with?.path === "string" ? rustCache.with.path : "";
	if (
		rustCache?.uses !== "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9" ||
		!String(rustCache?.with?.key).includes("${{ runner.os }}-${{ runner.arch }}-${{ env.RUST_VERSION }}-${{ hashFiles('packages/gui/src-tauri/Cargo.lock') }}") ||
		!rustCachePaths.includes("~/.cargo/registry") ||
		!rustCachePaths.includes("~/.cargo/git") ||
		rustCachePaths.includes("target/release/bundle")
	) {
		errors.push("GUI Rust cache must key on platform, architecture, toolchain, and Cargo.lock without caching final bundles");
	}
	for (const required of [
		'APPLE_SIGNING_IDENTITY: "-"',
		"PI_GUI_REMOTE_HOST_PLATFORMS: linux-arm64,linux-x64,windows-x64",
		"prepare-darwin-remote-hosts:",
		"merge-remote-hosts:",
		"Build native GUI bundle (macOS ad-hoc signed)",
		"Verify macOS ad-hoc signed DMG",
		"node packages/gui/scripts/verify-macos-bundle.mjs",
	]) {
		if (!workflow.includes(required)) errors.push(`missing GUI release signing contract: ${required}`);
	}
	const macBuild = step(build, "Build native GUI bundle (macOS ad-hoc signed)");
	if (!macBuild || command(macBuild).includes("--no-sign")) errors.push("macOS GUI build must not use --no-sign");
	if (!sidecar.includes('run("codesign", [...signArgs, outputPath])')) {
		errors.push("Darwin GUI Host is not signed before embedding");
	}
	if (!sidecar.includes("PI_GUI_REMOTE_HOST_PLATFORMS")) {
		errors.push("GUI Remote Host platform selection is missing");
	}
	if (!collector.includes("ELF machine mismatch") || !collector.includes("PE machine mismatch")) {
		errors.push("GUI release artifacts are not checked for Linux ELF and Windows PE architectures");
	}

	const publish = jobs.publish;
	if (!publish || !Array.isArray(publish.needs) || !publish.needs.includes("build")) {
		errors.push("GUI publish job must wait for the full build matrix");
	}
	if (publish?.environment !== "gui-release") errors.push("GUI publish job must require the gui-release environment approval");
	if (
		publish?.permissions?.contents !== "write" ||
		publish?.permissions?.["id-token"] !== "write" ||
		publish?.permissions?.attestations !== "write"
	) {
		errors.push("GUI publish job must have the required write and attestation permissions");
	}
	for (const [name, job] of Object.entries(jobs)) {
		if (name !== "publish" && !hasReadOnlyPermissions(job?.permissions)) {
			errors.push(`GUI ${name} job must not have write permissions`);
		}
	}
	const metadata = step(publish, "Generate GUI beta metadata");
	const artifactVerification = step(publish, "Verify GUI release artifacts and manifest");
	const attestation = step(publish, "Attest GUI release artifacts");
	if (!command(metadata).includes("generate-gui-beta-metadata.mjs") || !command(artifactVerification).includes("sha256sum -c") || !command(artifactVerification).includes("gui-release-manifest.json")) {
		errors.push("GUI publish job must verify artifacts, SHA256SUMS, and manifest before publishing");
	}
	if (
		attestation?.uses !== "actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be" ||
		!String(attestation?.with?.["subject-path"]).includes("gui-release/gui-release-manifest.json")
	) {
		errors.push("GUI publish job must attest release artifacts and manifest");
	}
	const tagSteps = Object.entries(jobs).flatMap(([name, job]) =>
		steps(job).filter((candidate) => command(candidate).includes("git tag")).map((candidate) => ({ name, candidate })),
	);
	if (tagSteps.length !== 1 || tagSteps[0].name !== "publish" || !command(tagSteps[0].candidate).includes("git tag -a")) {
		errors.push("GUI annotated tag must be created only in the publish job");
	} else {
		const publishSteps = steps(publish);
		if (
			publishSteps.indexOf(tagSteps[0].candidate) <= publishSteps.indexOf(metadata) ||
			publishSteps.indexOf(tagSteps[0].candidate) <= publishSteps.indexOf(artifactVerification) ||
			publishSteps.indexOf(tagSteps[0].candidate) <= publishSteps.indexOf(attestation)
		) {
			errors.push("GUI tag must be created after metadata, artifact, and provenance verification");
		}
	}
	const release = step(publish, "Publish GitHub prerelease");
	if (!command(release).includes("gh release create") || !command(release).includes("--latest=false")) {
		errors.push("GUI publish must create a prerelease without changing CLI Latest");
	}
	return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const errors = guiReleaseSigningErrors(
		readFileSync(workflowPath, "utf8"),
		readFileSync(sidecarPath, "utf8"),
		readFileSync(collectorPath, "utf8"),
	);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	console.log("GUI single-build release workflow is consistent");
}
