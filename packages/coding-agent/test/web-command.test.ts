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
	it.each(["gateway", "runtime"] as const)("uses the bundled Gateway module for %s restart", async (service) => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-test";
		delete process.env.LYSTAR_CLI_MODE;
		const loadWebConfig = vi.fn(async () => ({
			host: "127.0.0.1",
			allowedHosts: [],
			port: 1420,
			password: "web-password",
		}));
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		await runWebControlCommand([service, "restart"], { gatewayModule: { loadWebConfig } });

		expect(loadWebConfig).toHaveBeenCalledWith(process.env.PI_CODING_AGENT_DIR, undefined);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:1420/api/diagnostics/actions",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: `restart-${service}` }),
			}),
		);
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
