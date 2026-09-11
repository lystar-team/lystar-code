import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWebCommand, runWebControlCommand, runWebServiceCommand } from "../src/cli/web-command.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCliMode = process.env.LYSTAR_CLI_MODE;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalCliMode === undefined) delete process.env.LYSTAR_CLI_MODE;
	else process.env.LYSTAR_CLI_MODE = originalCliMode;
});

describe("Web control commands", () => {
	it.each(["gateway", "runtime"] as const)("controls the bundled %s service directly", async (component) => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-test";
		delete process.env.LYSTAR_CLI_MODE;
		const runWebComponentAction = vi.fn(async () => ({
			kind: component,
			installed: true,
			running: true,
		}));

		await runWebControlCommand([component, "restart"], { gatewayModule: { runWebComponentAction } });

		expect(runWebComponentAction).toHaveBeenCalledWith(
			expect.objectContaining({
				component,
				action: "restart",
				agentDir: "/tmp/lystar-web-command-test",
				configFileName: undefined,
			}),
		);
	});

	it("reports component failures without calling the Gateway HTTP API", async () => {
		const runWebComponentAction = vi.fn(async () => {
			throw Object.assign(new Error("Runtime busy"), { code: "host_busy" });
		});
		vi.stubGlobal("fetch", vi.fn());

		await expect(
			runWebControlCommand(["runtime", "restart"], { gatewayModule: { runWebComponentAction } }),
		).rejects.toMatchObject({ code: "host_busy" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("forwards force only to stop and restart actions", async () => {
		const runWebComponentAction = vi.fn(async () => ({ kind: "runtime", running: true }));

		await runWebControlCommand(["runtime", "restart", "--force"], {
			gatewayModule: { runWebComponentAction },
		});

		expect(runWebComponentAction).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
		await expect(
			runWebControlCommand(["runtime", "status", "--force"], { gatewayModule: { runWebComponentAction } }),
		).rejects.toThrow("用法");
	});

	it("prints the selected component status", async () => {
		const status = { kind: "runtime", running: true, reachable: true, responsive: true };
		const runWebComponentAction = vi.fn(async () => status);
		const output = vi.spyOn(console, "log").mockImplementation(() => {});

		await runWebControlCommand(["runtime", "status"], { gatewayModule: { runWebComponentAction } });

		expect(output).toHaveBeenCalledWith(JSON.stringify(status, null, "\t"));
	});

	it("dispatches service actions with independent service versions", async () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-test";
		delete process.env.LYSTAR_CLI_MODE;
		const stableLauncher =
			process.platform === "win32"
				? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent", "bin", "lc.cmd")
				: join(homedir(), ".local", "bin", "lc");
		const gatewayInvocation = { command: stableLauncher, args: ["web", "--foreground"], cwd: "/tmp" };
		const runtimeInvocation = { command: stableLauncher, args: ["web-runtime", "serve"], cwd: "/tmp" };
		const runWebServiceAction = vi.fn(async () => ({
			enabled: true,
			profile: "default",
			serviceVersion: "0.85.2-lystar.1",
			gateway: { running: true },
			runtime: { running: true },
		}));

		await runWebServiceCommand(["status", "--non-interactive"], {
			gatewayModule: { runWebServiceAction },
			gatewayInvocation,
			runtimeInvocation,
			serviceVersion: "0.85.2-lystar.1",
			previousServiceVersion: "0.85.1-lystar.1",
		});

		expect(runWebServiceAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "status",
				agentDir: "/tmp/lystar-web-command-test",
				configFileName: undefined,
				serviceVersion: "0.85.2-lystar.1",
				previousServiceVersion: "0.85.1-lystar.1",
				interactiveAdmin: false,
			}),
		);
	});

	it("reports a recovered service version without rejecting the application update", async () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-recovery-test";
		delete process.env.LYSTAR_CLI_MODE;
		const stableLauncher =
			process.platform === "win32"
				? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent", "bin", "lc.cmd")
				: join(homedir(), ".local", "bin", "lc");
		const gatewayInvocation = { command: stableLauncher, args: ["web", "--foreground"], cwd: "/tmp" };
		const runtimeInvocation = { command: stableLauncher, args: ["web-runtime", "serve"], cwd: "/tmp" };
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runWebServiceAction = vi.fn(async () => ({
			enabled: true,
			profile: "default",
			serviceVersion: "0.85.1-lystar.1",
			recovered: {
				targetVersion: "0.85.2-lystar.1",
				serviceVersion: "0.85.1-lystar.1",
				reason: "health check failed",
			},
			gateway: { running: true },
			runtime: { running: true },
		}));

		await runWebServiceCommand(["reconcile", "--upgrade", "--non-interactive"], {
			gatewayModule: { runWebServiceAction },
			gatewayInvocation,
			runtimeInvocation,
			serviceVersion: "0.85.2-lystar.1",
			previousServiceVersion: "0.85.1-lystar.1",
		});

		expect(warning).toHaveBeenCalledWith(expect.stringContaining("已恢复服务版本 0.85.1-lystar.1"));
	});

	it("uses a separate Runtime port for the development command", async () => {
		process.env.LYSTAR_CLI_MODE = "development";
		const output = vi.spyOn(console, "log").mockImplementation(() => {});

		await runWebCommand(["--help"]);

		expect(output).toHaveBeenCalledWith(expect.stringContaining("Web 默认端口：2422；Runtime 默认端口：2423。"));
	});
});
