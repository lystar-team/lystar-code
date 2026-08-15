import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const workflowPath = new URL("../.github/workflows/gui-release.yml", import.meta.url);
const sidecarPath = new URL("../packages/gui/scripts/build-sidecar.mjs", import.meta.url);

export function guiReleaseSigningErrors(workflow, sidecar) {
	const errors = [];
	for (const required of [
		"workflow_dispatch:",
		'"gui-preflight/**"',
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
	const macBuild = workflow.match(
		/- name: Build native GUI bundle \(macOS ad-hoc signed\)([\s\S]*?)(?=\n\s{6}- name:)/,
	)?.[1];
	if (!macBuild) errors.push("missing macOS GUI build step");
	else if (macBuild.includes("--no-sign")) errors.push("macOS GUI build must not use --no-sign");
	const releaseJob = workflow.match(/\n  release:\n([\s\S]*)$/)?.[1];
	if (!releaseJob?.includes("if: startsWith(github.ref, 'refs/tags/gui-v')")) {
		errors.push("GUI release job must only run for gui-v tags");
	}
	if (!workflow.includes("APPLE_SIGNING_IDENTITY=-")) errors.push("macOS ad-hoc signing identity is not configured");
	if (!sidecar.includes('run("codesign", [...signArgs, outputPath])')) {
		errors.push("Darwin GUI Host is not signed before embedding");
	}
	if (!sidecar.includes("PI_GUI_REMOTE_HOST_PLATFORMS")) {
		errors.push("GUI Remote Host platform selection is missing");
	}
	return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const errors = guiReleaseSigningErrors(readFileSync(workflowPath, "utf8"), readFileSync(sidecarPath, "utf8"));
	if (errors.length > 0) throw new Error(errors.join("\n"));
	console.log("GUI macOS ad-hoc signing workflow is consistent");
}
