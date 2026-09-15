import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getMacosPermissionsStatus,
	requestMacosPermission,
	runMacosPermissionsSetup,
} from "../src/macos-permissions.ts";

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
	existsSync: (path: string) => files.has(path),
	mkdirSync: vi.fn(),
	readFileSync: (path: string) => {
		const value = files.get(path);
		if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return value;
	},
	rmSync: vi.fn(),
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

	it("skips unavailable Git, SSH, and security tools without blocking setup", () => {
		const status = getMacosPermissionsStatus("/tmp/lystar-agent");
		const keychain = status.permissions.find((permission) => permission.id === "keychain");
		expect(keychain).toMatchObject({ state: "unsupported", canRequest: false });
		expect(keychain?.message).toContain("已跳过");

		expect(() => requestMacosPermission("keychain", "/tmp/lystar-agent")).not.toThrow();
		expect(files.has("/tmp/lystar-agent/web/macos-permissions.json")).toBe(true);
	});

	it("completes keychain setup when Git and SSH are absent", () => {
		vi.mocked(spawnSync).mockImplementation((command) => {
			if (command === "/usr/bin/sudo") return success();
			if (command === "/usr/bin/osascript") return success("true");
			if (command === "/usr/bin/security") return success();
			return unavailable();
		});

		const before = getMacosPermissionsStatus("/tmp/lystar-agent");
		expect(before.permissions.find((permission) => permission.id === "keychain")).toMatchObject({
			state: "required",
			canRequest: true,
		});

		const after = requestMacosPermission("keychain", "/tmp/lystar-agent");
		expect(after.permissions.find((permission) => permission.id === "keychain")).toMatchObject({
			state: "granted",
		});
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
			message: expect.stringContaining("Runtime"),
		});
	});

	it("grants keychain status only after a Runtime LaunchAgent reads the synthetic credential", () => {
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		files.set("/tmp/lystar-agent/web/bin/git-credential-lystar", "wrapper");
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "/usr/bin/sudo") return success();
			if (command === "/usr/bin/osascript") return success("true");
			if (command === "git" && args?.[0] === "--version") return success();
			if (command === "/usr/bin/git") return success();
			if (command === "/usr/bin/security") return success();
			if (command === "/bin/launchctl" && args?.[0] === "bootstrap") {
				const script = [...files.entries()].find(([path]) => path.endsWith(".sh"))?.[1];
				const resultPath = script?.match(/> '([^']+\.result)'/u)?.[1];
				if (resultPath) files.set(resultPath, "ok\n");
				return success();
			}
			if (command === "/bin/launchctl") return success();
			return unavailable();
		});
		try {
			const status = requestMacosPermission("keychain", "/tmp/lystar-agent");
			expect(status.permissions.find((permission) => permission.id === "keychain")).toMatchObject({
				state: "granted",
			});
			expect(files.get("/tmp/lystar-agent/web/macos-permissions.json")).toContain('"keychainProbeVersion": 2');
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
		}
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
