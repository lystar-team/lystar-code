import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureWebService,
	getWebServiceStatus,
	installWebService,
	removeWebService,
	stopWebService,
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

const runtimeSpec: WebServiceSpec = {
	...spec,
	kind: "runtime",
	macosSession: "gui",
	invocation: {
		program: "/test/user space/bin/lc.cmd",
		args: ["web-runtime", "serve"],
		cwd: "/test/user space/agent",
	},
};

beforeEach(() => {
	files.clear();
	vi.mocked(spawnSync).mockReset();
	vi.mocked(spawnSync).mockReturnValue(success());
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	vi.restoreAllMocks();
});

describe("platform service lifecycle", () => {
	it("queues a systemd stop before force-killing and waits for the unit to stop", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		files.set(getWebServiceStatus(spec).servicePath!, "unit");
		let stopRequested = false;
		let killed = false;
		let stopped = false;
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command !== "systemctl") return success();
			if (args?.includes("is-active")) return stopped ? failure("inactive") : success("active");
			if (args?.[1] === "stop" && args.includes("--no-block")) {
				stopRequested = true;
				return success();
			}
			if (args?.[1] === "kill") {
				expect(stopRequested).toBe(true);
				killed = true;
				return success();
			}
			if (args?.[1] === "stop") {
				expect(killed).toBe(true);
				stopped = true;
			}
			return success();
		});

		expect(stopWebService(spec, true).running).toBe(false);
		expect(stopped).toBe(true);
	});

	it("accepts a systemd unit that stops before the force-kill request", () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		files.set(getWebServiceStatus(spec).servicePath!, "unit");
		let stopped = false;
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "systemctl" && args?.includes("is-active"))
				return stopped ? failure("inactive") : success("active");
			if (command === "systemctl" && args?.[1] === "stop") stopped = true;
			if (command === "systemctl" && args?.[1] === "kill") return failure("unit has no processes");
			return success();
		});

		expect(stopWebService(spec, true).running).toBe(false);
	});

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
			"/usr/bin/sudo",
			expect.arrayContaining(["-n", expect.stringContaining("web-service-admin"), "kickstart"]),
			expect.anything(),
		);
		expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args?.includes("bootstrap"))).toBe(false);
	});

	it("force-stops a macOS LaunchAgent process before unloading it", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		files.set(getWebServiceStatus(runtimeSpec).servicePath!, "plist");
		vi.mocked(spawnSync).mockImplementation((command, args) =>
			command === "launchctl" && args?.[0] === "print" ? success("pid = 4321") : success(),
		);
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		stopWebService(runtimeSpec, true);

		expect(kill).toHaveBeenCalledWith(4321, "SIGKILL");
		expect(spawnSync).toHaveBeenCalledWith(
			"/bin/launchctl",
			expect.arrayContaining(["bootout", expect.stringMatching(/^gui\/\d+\//u)]),
			expect.anything(),
		);
	});

	it("installs the macOS Runtime as a user LaunchAgent", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		installWebService(runtimeSpec);
		const status = getWebServiceStatus(runtimeSpec);
		expect(status.manager).toBe("launch-agent");
		expect(status.servicePath).toContain("/Library/LaunchAgents/com.lystar.web-runtime");
		const plist = files.get(status.servicePath!);
		expect(plist).not.toContain("<key>UserName</key>");
		expect(spawnSync).toHaveBeenCalledWith(
			"/bin/launchctl",
			expect.arrayContaining(["bootstrap", expect.stringMatching(/^gui\/\d+$/u), status.servicePath]),
			expect.anything(),
		);
	});

	it("creates log directories and obtains macOS authorization on the terminal", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		let helperInstalled = false;
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "/usr/bin/sudo" && args?.at(-1) === "status") {
				return helperInstalled ? success() : failure("authorization missing");
			}
			if (command === "sudo" && args?.includes("/etc/sudoers.d/lystar-web-service-1000")) {
				helperInstalled = true;
			}
			return success();
		});
		installWebService(spec, { interactiveAdmin: true });
		expect(mkdirSync).toHaveBeenCalledWith("/test/user space/agent/web", expect.anything());
		expect(spawnSync).toHaveBeenCalledWith("sudo", ["-v"], { stdio: "inherit" });
		const plist = [...files.values()].find((value) => value.includes("<plist"));
		expect(plist).toContain("<key>WorkingDirectory</key><string>/test/user space/agent</string>");
		expect(plist).toContain("/test/user space/agent/web/bin");
		expect(files.get("/test/user space/agent/web/bin/sudo")).toContain("web-service-admin");
		const osascriptWrapper = files.get("/test/user space/agent/web/bin/osascript");
		const credentialWrapper = files.get("/test/user space/agent/web/bin/git-credential-lystar");
		const securityWrapper = files.get("/test/user space/agent/web/bin/security");
		const sshWrapper = files.get("/test/user space/agent/web/bin/ssh");
		expect(osascriptWrapper).toContain("administrator");
		expect(credentialWrapper).toContain("git-keychain-authorization.helper");
		expect(credentialWrapper).toContain('"$helper" "$@"');
		expect(securityWrapper).toContain("等待钥匙串授权超过 30 秒");
		expect(sshWrapper).toContain("BatchMode=yes");
		for (const wrapper of [osascriptWrapper, securityWrapper]) {
			expect(wrapper).toContain("exec 3<&0");
			expect(wrapper).toContain("<&3 &");
		}
		const helper = files.get("/test/user space/agent/web/services/web-service-admin-1000");
		expect(helper).toContain('exec /usr/bin/sudo -n "$@"');
		const { spawnSync: actualSpawnSync } =
			await vi.importActual<typeof import("node:child_process")>("node:child_process");
		expect(actualSpawnSync("/bin/bash", ["-n"], { input: helper, encoding: "utf8" }).status).toBe(0);
		for (const wrapper of [osascriptWrapper, credentialWrapper, securityWrapper, sshWrapper]) {
			expect(actualSpawnSync("/bin/bash", ["-n"], { input: wrapper, encoding: "utf8" }).status).toBe(0);
		}
	});

	it("updates the macOS helper through the existing silent authorization", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		installWebService(spec);
		expect(spawnSync).toHaveBeenCalledWith(
			"/usr/bin/sudo",
			expect.arrayContaining(["-n", expect.stringContaining("web-service-admin"), "upgrade"]),
			expect.anything(),
		);
		expect(vi.mocked(spawnSync).mock.calls.some(([command, args]) => command === "sudo" && args?.[0] === "-v")).toBe(
			false,
		);
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

	it("force-stops a Windows service process tree instead of waiting for graceful shutdown", () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		let killed = false;
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "sc.exe" && args?.[0] === "query")
				return success(killed ? "STATE : 1 STOPPED" : "STATE : 4 RUNNING");
			if (command === "sc.exe" && args?.[0] === "queryex") return success("PID : 4321");
			if (command === "taskkill") killed = true;
			return success();
		});

		stopWebService(spec, true);

		expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "4321", "/T", "/F"], expect.anything());
		expect(killed).toBe(true);
	});

	it("removes a legacy macOS Runtime LaunchDaemon during LaunchAgent uninstall", () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		const legacyPath = `/Library/LaunchDaemons/com.lystar.web-runtime.${process.getuid?.() ?? 0}.plist`;
		files.set(legacyPath, "legacy");
		vi.mocked(spawnSync).mockImplementation((command, args) => {
			if (command === "launchctl" && args?.[0] === "print" && String(args[1]).startsWith("gui/")) {
				return failure("Could not find service");
			}
			return success();
		});

		removeWebService(runtimeSpec);

		expect(spawnSync).toHaveBeenCalledWith(
			"/usr/bin/sudo",
			expect.arrayContaining(["-n", expect.stringContaining("web-service-admin"), "remove", legacyPath]),
			expect.anything(),
		);
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
