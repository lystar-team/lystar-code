import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureWebService,
	getWebServiceStatus,
	installWebService,
	removeWebService,
	type WebServiceSpec,
} from "../src/service-manager.ts";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", () => ({
	existsSync: (path: string) => files.has(path),
	mkdirSync: vi.fn(),
	readFileSync: (path: string) => {
		if (!files.has(path)) throw new Error("missing");
		return files.get(path);
	},
	writeFileSync: vi.fn((path: string, content: string) => {
		files.set(path, content);
	}),
	renameSync: (source: string, target: string) => {
		files.set(target, files.get(source)!);
		files.delete(source);
	},
	rmSync: (path: string) => files.delete(path),
	copyFileSync: (source: string, target: string) => {
		files.set(target, files.get(source)!);
	},
}));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const originalPlatform = process.platform;
const success = (stdout = "") => ({ status: 0, stdout, stderr: "", pid: 1, output: [], signal: null });
const failure = (stdout: string) => ({ ...success(stdout), status: 1 });
const spec: WebServiceSpec = {
	kind: "gateway",
	agentDir: "/test/user space/agent",
	invocation: { program: "/test/user space/bin/lc.cmd", args: ["web", "--foreground"], cwd: "/test/user space/agent" },
	environment: { LYSTAR_WEB_SERVICE_VERSION: "0.85.1-lystar.5" },
};

beforeEach(() => {
	files.clear();
	vi.mocked(spawnSync).mockReset();
	vi.mocked(spawnSync).mockReturnValue(success());
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("platform service lifecycle", () => {
	it("does not mark a loaded macOS daemon without a PID as running", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		const status = getWebServiceStatus(spec);
		expect(status.running).toBe(false);
		expect(status.persistent).toBe(true);
	});

	it("kickstarts an installed but exited macOS daemon instead of bootstrapping it again", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		const path = getWebServiceStatus(spec).servicePath!;
		files.set(path, "plist");
		ensureWebService(spec);
		expect(spawnSync).toHaveBeenCalledWith(
			"sudo",
			expect.arrayContaining(["-n", "launchctl", "kickstart"]),
			expect.anything(),
		);
		expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.includes("bootstrap"))).toBe(false);
	});

	it("creates log directories and obtains macOS authorization on the terminal", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		installWebService(spec, { interactiveAdmin: true });
		expect(mkdirSync).toHaveBeenCalledWith("/test/user space/agent/web", expect.anything());
		expect(spawnSync).toHaveBeenCalledWith("sudo", ["-v"], { stdio: "inherit" });
		const plist = [...files.values()].find((value) => value.includes("<plist"));
		expect(plist).toContain("<key>WorkingDirectory</key><string>/test/user space/agent</string>");
	});

	it("waits for Windows STOPPED and installs the requested version of the service host", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		files.set("/test/user space/versions/0.85.1-lystar.5/lystar-web-service.exe", "new-host");
		files.set("/test/user space/agent/web/services/lystar-web-service.exe", "old-host");
		let stopped = false;
		let queriesAfterStop = 0;
		vi.mocked(spawnSync).mockImplementation((_command, args) => {
			if (args?.[0] === "stop") stopped = true;
			if (args?.[0] === "query") {
				if (!stopped) return success("STATE : 4 RUNNING");
				queriesAfterStop++;
				return success(queriesAfterStop === 1 ? "STATE : 3 STOP_PENDING" : "STATE : 1 STOPPED");
			}
			if (args?.[0] === "config") expect(queriesAfterStop).toBeGreaterThanOrEqual(2);
			return success();
		});
		installWebService(spec);
		expect(files.get("/test/user space/agent/web/services/lystar-web-service-0.85.1-lystar.5.exe")).toBe("new-host");
		expect(files.get("/test/user space/agent/web/services/lystar-web-service.exe")).toBe("old-host");
	});

	it("does not require sudo to uninstall a macOS service that was never installed", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		vi.mocked(spawnSync).mockReturnValue(failure("Could not find service"));
		removeWebService(spec);
		expect(vi.mocked(spawnSync).mock.calls.every(([command]) => command === "launchctl")).toBe(true);
	});

	it("quotes the complete elevated Windows argument string", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		files.set("/test/user space/versions/0.85.1-lystar.5/lystar-web-service.exe", "host");
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "sc.exe" && args?.[0] === "query") return failure("1060");
			if (command === "sc.exe" && args?.[0] === "create") return failure("Access is denied");
			return success();
		});
		installWebService(spec);
		const script = vi
			.mocked(writeFileSync)
			.mock.calls.map(([, value]) => String(value))
			.find((value) => value.includes("Start-Process"));
		expect(script).toContain('create "LYStar Web Gateway"');
		expect(script).not.toContain("$arguments = @(");
	});
});
