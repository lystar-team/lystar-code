import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureUserCommandEnvironment,
	discoverUserShellCommandEnvironment,
	probeUserNodeToolchain,
	restoreUserCommandEnvironment,
} from "../src/user-execution-environment.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

describe("user execution environment", () => {
	it("captures command lookup variables without depending on a Node version manager", () => {
		expect(
			captureUserCommandEnvironment({
				Path: "/user/bin:/usr/bin",
				PATHEXT: ".EXE;.CMD",
				SHELL: "/bin/zsh",
				IGNORED_SECRET: "value",
			}),
		).toEqual({
			PATH: "/user/bin:/usr/bin",
			PATHEXT: ".EXE;.CMD",
			SHELL: "/bin/zsh",
			LYSTAR_USER_ENV_SOURCE: "process",
		});
	});

	it.skipIf(process.platform === "win32")("discovers PATH from the user's shell for legacy services", () => {
		const directory = temporaryDirectory("lystar-user-env-shell-");
		const shell = join(directory, "test-bash");
		writeFileSync(shell, '#!/bin/sh\nPATH="$DISCOVERED_PATH"\nexport PATH\nexec /bin/sh -c "$2"\n');
		chmodSync(shell, 0o755);
		const discoveredPath = [join(directory, "node-bin"), "/usr/bin"].join(delimiter);
		const env = { HOME: directory, SHELL: shell, DISCOVERED_PATH: discoveredPath };

		expect(discoverUserShellCommandEnvironment({ env, shellPath: shell })).toEqual({
			PATH: discoveredPath,
			SHELL: shell,
			LYSTAR_USER_ENV_SOURCE: "shell",
		});

		const serviceEnv: NodeJS.ProcessEnv = {
			...env,
			PATH: directory,
			LYSTAR_WEB_SERVICE_CHILD: "1",
			LYSTAR_USER_ENV_SOURCE: "process",
		};
		expect(restoreUserCommandEnvironment({ env: serviceEnv, shellPath: shell })).toBe(true);
		expect(serviceEnv.PATH).toBe(discoveredPath);
		expect(serviceEnv.LYSTAR_USER_ENV_SOURCE).toBe("shell");
	});

	it.skipIf(process.platform === "win32")("restores the macOS Web command wrapper after shell discovery", () => {
		const directory = temporaryDirectory("lystar-user-env-macos-");
		const shell = join(directory, "test-bash");
		writeFileSync(shell, '#!/bin/sh\nPATH="$DISCOVERED_PATH"\nexport PATH\nexec /bin/sh -c "$2"\n');
		chmodSync(shell, 0o755);
		const discoveredPath = [join(directory, "node-bin"), "/usr/bin"].join(delimiter);
		const commandBin = join(directory, "web-bin");
		const env: NodeJS.ProcessEnv = {
			HOME: directory,
			SHELL: shell,
			DISCOVERED_PATH: discoveredPath,
			PATH: directory,
			LYSTAR_WEB_SERVICE_CHILD: "1",
			LYSTAR_USER_ENV_SOURCE: "process",
			LYSTAR_WEB_COMMAND_BIN: commandBin,
		};
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			expect(restoreUserCommandEnvironment({ env, shellPath: shell })).toBe(true);
			expect(env.PATH).toBe(`${commandBin}:${discoveredPath}`);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
		}
	});

	it.skipIf(process.platform === "win32")("returns an unavailable toolchain when Node is not installed", () => {
		const directory = temporaryDirectory("lystar-user-env-empty-");
		expect(probeUserNodeToolchain({ PATH: directory })).toEqual({});
	});

	it.skipIf(process.platform === "win32")("probes the real Node and npm resolved from PATH", () => {
		const directory = temporaryDirectory("lystar-user-env-node-");
		const node = join(directory, "node");
		const npm = join(directory, "npm");
		writeFileSync(node, '#!/bin/sh\nprintf \'%s\\n\' \'{"version":"v24.18.0","executable":"/managed/node"}\'\n');
		writeFileSync(npm, "#!/bin/sh\nprintf '11.16.0\\n'\n");
		chmodSync(node, 0o755);
		chmodSync(npm, 0o755);

		expect(probeUserNodeToolchain({ PATH: directory })).toEqual({
			node: { version: "v24.18.0", executable: "/managed/node" },
			npmVersion: "11.16.0",
		});
	});
});
