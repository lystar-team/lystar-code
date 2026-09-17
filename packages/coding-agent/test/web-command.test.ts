import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	reconcileWebServicesAfterUpdate,
	runWebCommand,
	runWebControlCommand,
	runWebPermissionsCommand,
	runWebServiceCommand,
} from "../src/cli/web-command.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCliMode = process.env.LYSTAR_CLI_MODE;

afterEach(() => {
	vi.useRealTimers();
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

	it("manages the development frontend with Gateway and Runtime service actions", async () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-development-test";
		process.env.LYSTAR_CLI_MODE = "development";
		const runWebServiceAction = vi.fn(async () => ({
			enabled: true,
			profile: "development",
			frontend: { running: true },
			gateway: { running: true },
			runtime: { running: true },
		}));
		const output = vi.spyOn(console, "log").mockImplementation(() => {});

		await runWebServiceCommand(["restart"], {
			gatewayModule: { runWebServiceAction },
			gatewayInvocation: { command: "/usr/bin/node", args: ["gateway"], cwd: "/tmp" },
			runtimeInvocation: { command: "/usr/bin/node", args: ["runtime"], cwd: "/tmp" },
		});

		expect(runWebServiceAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "restart",
				configFileName: "web-dev-config.json",
				frontendInvocation: expect.objectContaining({
					command: join(dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm"),
					args: ["run", "dev", "--workspace=@lystar/code-web"],
				}),
				frontendPort: 2420,
			}),
		);
		expect(output).toHaveBeenCalledWith("开发 Web 前端、Gateway 和 Runtime 服务已启动。");
	});

	it("reconciles post-update services with the explicit target version instead of the stale updater version", async () => {
		const agentDir = join(tmpdir(), `lystar-web-update-version-${process.pid}-${Date.now()}`);
		mkdirSync(join(agentDir, "web"), { recursive: true });
		writeFileSync(join(agentDir, "web", "service-state.json"), "{}\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const stableLauncher =
			process.platform === "win32"
				? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent", "bin", "lc.cmd")
				: join(homedir(), ".local", "bin", "lc");
		const runWebServiceAction = vi.fn(async () => ({
			enabled: true,
			profile: "default",
			serviceVersion: "0.85.2-lystar.1",
			gateway: { running: true },
			runtime: { running: true },
		}));
		try {
			await reconcileWebServicesAfterUpdate("0.85.2-lystar.1", "0.85.1-lystar.12", {
				gatewayModule: { runWebServiceAction },
				gatewayInvocation: { command: stableLauncher, args: ["web", "--foreground"], cwd: agentDir },
				runtimeInvocation: { command: stableLauncher, args: ["web-runtime", "serve"], cwd: agentDir },
			});

			expect(runWebServiceAction).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "reconcile",
					serviceVersion: "0.85.2-lystar.1",
					previousServiceVersion: "0.85.1-lystar.12",
				}),
			);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("retries the target version when the first post-update reconcile recovers the old service", async () => {
		vi.useFakeTimers();
		const agentDir = join(tmpdir(), `lystar-web-update-retry-${process.pid}-${Date.now()}`);
		mkdirSync(join(agentDir, "web"), { recursive: true });
		writeFileSync(join(agentDir, "web", "service-state.json"), "{}\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const stableLauncher =
			process.platform === "win32"
				? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "LYStarAgent", "bin", "lc.cmd")
				: join(homedir(), ".local", "bin", "lc");
		const runWebServiceAction = vi
			.fn()
			.mockResolvedValueOnce({
				enabled: true,
				profile: "default",
				serviceVersion: "0.85.1-lystar.12",
				recovered: {
					targetVersion: "0.85.2-lystar.1",
					serviceVersion: "0.85.1-lystar.12",
					reason: "Gateway 尚未就绪",
				},
				gateway: { running: true },
				runtime: { running: true },
			})
			.mockResolvedValueOnce({
				enabled: true,
				profile: "default",
				serviceVersion: "0.85.2-lystar.1",
				gateway: { running: true },
				runtime: { running: true },
			});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const operation = reconcileWebServicesAfterUpdate("0.85.2-lystar.1", "0.85.1-lystar.12", {
				gatewayModule: { runWebServiceAction },
				gatewayInvocation: { command: stableLauncher, args: ["web", "--foreground"], cwd: agentDir },
				runtimeInvocation: { command: stableLauncher, args: ["web-runtime", "serve"], cwd: agentDir },
			});
			await vi.runAllTimersAsync();
			await operation;
			expect(runWebServiceAction).toHaveBeenCalledTimes(2);
			expect(runWebServiceAction).toHaveBeenLastCalledWith(
				expect.objectContaining({ serviceVersion: "0.85.2-lystar.1" }),
			);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
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

	it("runs the local permission setup after an interactive macOS service reconcile", async () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-macos-reconcile";
		const platform = process.platform;
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const runWebServiceAction = vi.fn(async () => ({ gateway: { running: true }, runtime: { running: true } }));
		const runMacosPermissionsCommand = vi.fn(async () => ({ platform: "darwin", supported: true, permissions: [] }));
		vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await runWebServiceCommand(["reconcile", "--upgrade"], {
				gatewayModule: { runWebServiceAction },
				permissionsGatewayModule: { runMacosPermissionsCommand },
				gatewayInvocation: { command: "/usr/bin/node", args: ["gateway"], cwd: "/tmp" },
				runtimeInvocation: { command: "/usr/bin/node", args: ["runtime"], cwd: "/tmp" },
			});

			expect(runMacosPermissionsCommand).toHaveBeenCalledWith({
				action: "setup",
				agentDir: "/tmp/lystar-web-command-macos-reconcile",
				onlyIfRequired: true,
			});
		} finally {
			Object.defineProperty(process, "platform", { configurable: true, value: platform });
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
		}
	});

	it("does not fail a completed macOS service upgrade when the permission follow-up fails", async () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-macos-permission-failure";
		const platform = process.platform;
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		const runWebServiceAction = vi.fn(async () => ({ gateway: { running: true }, runtime: { running: true } }));
		const runMacosPermissionsCommand = vi.fn(async () => {
			throw new Error("等待 macOS 登录钥匙串密码超过 30 秒");
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(
				runWebServiceCommand(["reconcile", "--upgrade"], {
					gatewayModule: { runWebServiceAction },
					permissionsGatewayModule: { runMacosPermissionsCommand },
					gatewayInvocation: { command: "/usr/bin/node", args: ["gateway"], cwd: "/tmp" },
					runtimeInvocation: { command: "/usr/bin/node", args: ["runtime"], cwd: "/tmp" },
				}),
			).resolves.toMatchObject({ gateway: { running: true }, runtime: { running: true } });
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("不影响当前版本继续运行"));
		} finally {
			Object.defineProperty(process, "platform", { configurable: true, value: platform });
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdinIsTTY });
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdoutIsTTY });
		}
	});

	it("dispatches macOS permission commands through the bundled Gateway module", async () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-web-command-permissions-test";
		const status = { platform: "darwin", supported: true, permissions: [] };
		const runMacosPermissionsCommand = vi.fn(async () => status);
		const output = vi.spyOn(console, "log").mockImplementation(() => {});

		await runWebPermissionsCommand(["status"], { runMacosPermissionsCommand });

		expect(runMacosPermissionsCommand).toHaveBeenCalledWith({
			action: "status",
			agentDir: "/tmp/lystar-web-command-permissions-test",
		});
		expect(output).toHaveBeenCalledWith(JSON.stringify(status, null, "\t"));
	});

	it("development command reports the independent Runtime port", async () => {
		process.env.LYSTAR_CLI_MODE = "development";
		const output = vi.spyOn(console, "log").mockImplementation(() => {});

		await runWebCommand(["--help"]);

		expect(output).toHaveBeenCalledWith(expect.stringContaining("Web 默认端口：2422；Runtime 默认端口：2423。"));
		expect(output).toHaveBeenCalledWith(expect.stringContaining("开发前端（Vite HMR）：http://127.0.0.1:2420"));
		expect(output).toHaveBeenCalledWith(
			expect.stringContaining("lcd web 会启动并托管 Vite HMR 前端、Gateway 和 Runtime"),
		);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("lcd web runtime status|stop|start|restart"));
	});
});
