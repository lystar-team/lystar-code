import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/**
 * Point the user home and the agent directory at an empty temporary directory.
 *
 * Session and package tests discover user skills, extensions, settings, and sessions through
 * `homedir()` and `PI_CODING_AGENT_DIR`. Without isolation those tests read the developer's own
 * resources and change behavior between machines. Call this once at test module scope.
 */
export function isolateUserHome(slug: string): void {
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let directory: string | undefined;

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), `pi-${slug}-home-`));
		process.env.HOME = directory;
		process.env.USERPROFILE = directory;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterAll(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	});
}
