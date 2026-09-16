import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getMacosGitKeychainRequirement,
	getMacosPermissionsStatus,
	requestMacosPermission,
	runMacosPermissionsSetup,
} from "../src/macos-permissions.ts";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	existsSync: (path: string) => files.has(path),
	mkdirSync: vi.fn(),
	readFileSync: (path: string) => {
		const value = files.get(path);
		if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return value;
	},
	rmSync: (path: string) => files.delete(path),
	writeFileSync: (path: string, value: string) => files.set(path, value),
}));

const originalPlatform = process.platform;
const success = (stdout = "") => ({ status: 0, stdout, stderr: "", signal: null, output: [], pid: 1 });
const unavailable = () => ({
	status: null,
	stdout: "",
	stderr: "",
	signal: null,
	output: [],
	pid: 1,
	error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
});

describe("macOS keychain permission discovery", () => {
	beforeEach(() => {
		files.clear();
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		vi.mocked(spawnSync).mockImplementation((command) => {
			if (command === "/usr/bin/sudo") return success();
			if (command === "/usr/bin/osascript") return success("true");
			return unavailable();
		});
	});

	it("skips unavailable Git, SSH, and security tools without blocking setup", async () => {
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		try {
			const status = getMacosPermissionsStatus("/tmp/lystar-agent");
			const keychain = status.permissions.find((permission) => permission.id === "keychain");
			expect(keychain).toMatchObject({ state: "unsupported", canRequest: false });
			expect(keychain?.message).toContain("已跳过");

			await runMacosPermissionsSetup("/tmp/lystar-agent");
			expect(files.has("/tmp/lystar-agent/web/macos-permissions.json")).toBe(true);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
		}
	});

	it("rejects direct keychain requests outside the terminal setup flow", () => {
		expect(() => requestMacosPermission("keychain", "/tmp/lystar-agent")).toThrow("lc web permissions setup");
	});

	it("completes keychain setup when Git and SSH are absent", async () => {
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		vi.mocked(spawnSync).mockImplementation((command) => {
			if (command === "/usr/bin/sudo") return success();
			if (command === "/usr/bin/osascript") return success("true");
			if (command === "/usr/bin/security") return success();
			return unavailable();
		});
		try {
			const before = getMacosPermissionsStatus("/tmp/lystar-agent");
			expect(before.permissions.find((permission) => permission.id === "keychain")).toMatchObject({
				state: "required",
				canRequest: true,
			});

			const after = await runMacosPermissionsSetup("/tmp/lystar-agent");
			expect(after.permissions.find((permission) => permission.id === "keychain")).toMatchObject({
				state: "granted",
			});
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
		}
	});

	it("does not trust a legacy keychain marker without a Runtime readback probe", () => {
		files.set("/tmp/lystar-agent/web/macos-permissions.json", JSON.stringify({ keychainInitializedAt: Date.now() }));
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "/usr/bin/sudo") return success();
			if (command === "/usr/bin/osascript") return success("true");
			if (command === "git" && args?.[0] === "--version") return success();
			if (command === "/usr/bin/security") return success();
			return unavailable();
		});

		const status = getMacosPermissionsStatus("/tmp/lystar-agent");
		expect(status.permissions.find((permission) => permission.id === "keychain")).toMatchObject({
			state: "required",
			message: expect.stringContaining("本机终端"),
		});
	});

	it("reads the login-keychain password once and batch-authorizes every matching HTTPS credential", async () => {
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		const helperPath = "/mock/git-core/git-credential-osxkeychain";
		const readKeychainPassword = vi.fn(async () => "login-password");
		let securityInput = "";
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		files.set(helperPath, "helper-v1");
		files.set(
			"/tmp/lystar-agent/web/projects.json",
			JSON.stringify({
				projects: [{ cwd: "/tmp/project-a" }, { cwd: "/tmp/project-b" }, { cwd: "/tmp/project-c" }],
			}),
		);
		vi.mocked(spawnSync).mockImplementation((command, args, options) => {
			if (command === "/usr/bin/sudo") return success();
			if (command === "/usr/bin/osascript") return success("true");
			if (command === "git" && args?.[0] === "--version") return success();
			if (command === "/usr/bin/git" && args?.[0] === "--exec-path") return success("/mock/git-core");
			if (command === "git" && args?.[0] === "-C" && args?.[2] === "remote" && args.length === 3)
				return success("origin");
			if (command === "git" && args?.[0] === "-C" && args?.[2] === "remote" && args?.[3] === "get-url") {
				return success(
					args[1] === "/tmp/project-b"
						? "https://github.com/lystar/b.git"
						: `https://gitee.com/lystar/${args[1] === "/tmp/project-a" ? "a" : "c"}.git`,
				);
			}
			if (command === "/usr/bin/security" && args?.[0] === "login-keychain")
				return success('"/mock/login.keychain-db"');
			if (command === "/usr/bin/security" && args?.[0] === "dump-keychain") {
				return success(`keychain: "/mock/login.keychain-db"
class: "inet"
attributes:
    "acct"<blob>="gitee-primary"
    "path"<blob>="/lystar/a.git"
    "ptcl"<uint32>="htps"
    "srvr"<blob>="gitee.com"
keychain: "/mock/login.keychain-db"
class: "inet"
attributes:
    "acct"<blob>="gitee-secondary"
    "path"<blob>="/lystar/c.git"
    "ptcl"<uint32>="htps"
    "srvr"<blob>="gitee.com"
keychain: "/mock/login.keychain-db"
class: "inet"
attributes:
    "acct"<blob>="github-account"
    "ptcl"<uint32>="htps"
    "srvr"<blob>="github.com"`);
			}
			if (command === "/usr/bin/security" && args?.[0] === "-i") {
				securityInput = String(options?.input ?? "");
				return success();
			}
			if (command === "/usr/bin/security") return success();
			if (command === "/usr/bin/codesign") return success();
			if (command === "/bin/launchctl" && args?.[0] === "bootstrap") {
				const script = [...files.entries()].find(([path]) => path.endsWith(".sh"))?.[1];
				expect(script).toContain('$1 == "password" && length($2) > 0');
				expect(script).toContain("END { exit password ? 0 : 1 }");
				expect(script).not.toContain("exit username && password");
				const resultPath = script?.match(/> '([^']+\.result)'/u)?.[1];
				if (resultPath) files.set(resultPath, "ok\n");
				return success();
			}
			if (command === "/bin/launchctl") return success();
			return unavailable();
		});
		try {
			const status = await runMacosPermissionsSetup("/tmp/lystar-agent", { readKeychainPassword });
			expect(readKeychainPassword).toHaveBeenCalledTimes(1);
			expect(securityInput).toContain('unlock-keychain -p "login-password"');
			expect(securityInput.match(/set-internet-password-partition-list/gu)).toHaveLength(3);
			const securityInteractiveCall = vi
				.mocked(spawnSync)
				.mock.calls.find(([command, args]) => command === "/usr/bin/security" && args?.[0] === "-i");
			expect(securityInteractiveCall?.[1]).not.toContain("login-password");
			expect(status.permissions.find((permission) => permission.id === "keychain")).toMatchObject({
				state: "granted",
			});
			expect(files.get("/tmp/lystar-agent/web/macos-permissions.json")).toContain('"keychainProbeVersion": 4');
			expect(files.get("/tmp/lystar-agent/web/git-keychain-authorization.helper")).toBe(`${helperPath}\n`);
			expect(files.get("/tmp/lystar-agent/web/git-keychain-authorization.hosts")).toBe("gitee.com\ngithub.com\n");
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
		}
	});

	it("blocks a new HTTPS remote until the local setup authorizes its host", () => {
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "git" && args?.[0] === "-C" && args?.[2] === "remote" && args.length === 3)
				return success("origin");
			if (command === "git" && args?.[0] === "-C" && args?.[2] === "remote" && args?.[3] === "get-url")
				return success("https://gitee.com/lystar/project.git");
			return unavailable();
		});

		expect(getMacosGitKeychainRequirement("/tmp/project", "/tmp/lystar-agent")).toMatchObject({
			required: true,
			hosts: ["gitee.com"],
			message: expect.stringContaining("lc web permissions setup"),
		});
	});

	it("continues setup without waiting for terminal input and remembers the terminal application", async () => {
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		const termProgram = process.env.TERM_PROGRAM;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		process.env.TERM_PROGRAM = "iTerm.app";
		let accessibilityChecks = 0;
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "/usr/bin/sudo") return success();
			if (command !== "/usr/bin/osascript") return unavailable();
			const script = Array.isArray(args) ? String(args.at(-1) ?? "") : "";
			if (script.includes("AXIsProcessTrustedWithOptions")) return success("false");
			if (script.includes("AXIsProcessTrusted()")) {
				accessibilityChecks += 1;
				return success(accessibilityChecks === 1 ? "false" : "true");
			}
			if (script.includes("CGPreflightScreenCaptureAccess")) return unavailable();
			return success();
		});
		try {
			const status = await runMacosPermissionsSetup("/tmp/lystar-agent");
			expect(status.permissions.find((permission) => permission.id === "accessibility")).toMatchObject({
				state: "granted",
			});
			expect(status.permissions.find((permission) => permission.id === "automation")).toMatchObject({
				state: "granted",
			});
			expect(status.permissions.find((permission) => permission.id === "screen-recording")?.message).toContain(
				"添加“iTerm”",
			);
			expect(files.get("/tmp/lystar-agent/web/macos-permissions.json")).toContain('"terminalApplication": "iTerm"');
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
			if (termProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = termProgram;
		}
	});
});

afterAll(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
});
