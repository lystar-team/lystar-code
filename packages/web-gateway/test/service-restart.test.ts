import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as webRuntime from "@lystar/code-web-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebConfigStore } from "../src/config.ts";
import { runWebServiceAction, runWebSessionStop } from "../src/gateway-service.ts";

const state = vi.hoisted(() => ({ gatewayRunning: true, runtimeRunning: true, busy: true }));
vi.mock("@lystar/code-web-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof webRuntime>();
	return {
		...actual,
		getWebServiceStatus: vi.fn((spec: { kind: string }) => ({
			kind: spec.kind,
			installed: true,
			running: state.gatewayRunning,
			manager: "systemd-user",
		})),
		getRuntimeServiceStatus: vi.fn(async (endpoint: string) => ({
			kind: "runtime",
			endpoint,
			installed: true,
			running: state.runtimeRunning,
			reachable: state.runtimeRunning,
			responsive: state.runtimeRunning,
			manager: "systemd-user",
		})),
		stopWebService: vi.fn(() => {
			state.gatewayRunning = false;
		}),
		stopRuntimeService: vi.fn(async (_endpoint: string, force: boolean) => {
			if (!force && state.busy) throw Object.assign(new Error("Runtime busy"), { code: "host_busy" });
			state.runtimeRunning = false;
			state.busy = false;
		}),
		stopRuntimeSession: vi.fn(async () => true),
		assertRuntimeIdle: vi.fn(async () => {
			if (state.busy) throw Object.assign(new Error("Runtime busy"), { code: "host_busy" });
		}),
		ensureRuntimeService: vi.fn(async () => {
			state.runtimeRunning = true;
		}),
		installRuntimeService: vi.fn(async () => {
			state.runtimeRunning = true;
		}),
		ensureWebService: vi.fn(() => {
			state.gatewayRunning = true;
		}),
		installWebService: vi.fn(() => {
			state.gatewayRunning = true;
		}),
	};
});

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

async function serviceOptions(configFileName?: string) {
	const agentDir = await mkdtemp(join(tmpdir(), "lystar-web-service-restart-"));
	directories.push(agentDir);
	await new WebConfigStore(agentDir, join(agentDir, configFileName ?? "web-config.json")).save({
		host: "127.0.0.1",
		port: configFileName ? 2422 : 1420,
		runtimePort: configFileName ? 2423 : 1422,
		password: "test-password",
	});
	return {
		agentDir,
		...(configFileName ? { configFileName } : {}),
		gatewayInvocation: { command: process.execPath, args: ["web", "--foreground"], cwd: agentDir },
		runtimeInvocation: { command: process.execPath, args: ["web-runtime", "serve"], cwd: agentDir },
	};
}

describe("Web service restart", () => {
	it.each([undefined, "web-dev-config.json"])(
		"stops a single session on the configured Runtime for %s",
		async (configFileName) => {
			const options = await serviceOptions(configFileName);
			await expect(runWebSessionStop({ ...options, sessionId: "session-123" })).resolves.toBe(true);
			expect(webRuntime.stopRuntimeSession).toHaveBeenCalledWith(
				configFileName ? "tcp://127.0.0.1:2423" : "tcp://127.0.0.1:1422",
				"session-123",
			);
			expect(webRuntime.stopRuntimeService).not.toHaveBeenCalled();
		},
	);

	it("reinstalls development services with the current invocation on restart", async () => {
		state.gatewayRunning = true;
		state.runtimeRunning = true;
		state.busy = true;
		const options = await serviceOptions("web-dev-config.json");
		const frontendInvocation = { command: "npm", args: ["run", "dev"], cwd: options.agentDir };
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true, host: "connected" })),
		);

		await runWebServiceAction({
			...options,
			frontendInvocation,
			frontendPort: 2420,
			action: "restart",
		});

		expect(webRuntime.installRuntimeService).toHaveBeenCalledWith("tcp://127.0.0.1:2423", false, {
			profile: "development",
			invocation: {
				program: options.runtimeInvocation.command,
				args: options.runtimeInvocation.args,
				cwd: options.runtimeInvocation.cwd,
			},
			agentDir: options.agentDir,
			environment: expect.objectContaining({ LYSTAR_CLI_MODE: "development" }),
		});
		expect(webRuntime.installWebService).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "gateway",
				profile: "development",
				invocation: expect.objectContaining({ program: options.gatewayInvocation.command }),
			}),
			{ interactiveAdmin: false },
		);
		expect(webRuntime.installWebService).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "frontend",
				profile: "development",
				invocation: {
					program: frontendInvocation.command,
					args: frontendInvocation.args,
					cwd: frontendInvocation.cwd,
				},
			}),
			{ interactiveAdmin: false },
		);
		expect(webRuntime.ensureRuntimeService).not.toHaveBeenCalled();
		expect(webRuntime.ensureWebService).not.toHaveBeenCalled();
	});

	it.each([undefined, "web-dev-config.json"])(
		"forces active Runtime sessions to stop for %s",
		async (configFileName) => {
			state.gatewayRunning = true;
			state.runtimeRunning = true;
			state.busy = true;
			const options = await serviceOptions(configFileName);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({ ok: true, host: "connected" })),
			);
			await expect(runWebServiceAction({ ...options, action: "stop" })).rejects.toMatchObject({ code: "host_busy" });
			expect(webRuntime.stopWebService).not.toHaveBeenCalled();
			const status = await runWebServiceAction({ ...options, action: "restart" });

			expect(webRuntime.stopWebService).toHaveBeenCalledWith(
				expect.objectContaining({ kind: "gateway" }),
				true,
				expect.anything(),
			);
			expect(webRuntime.stopRuntimeService).toHaveBeenLastCalledWith(
				configFileName ? "tcp://127.0.0.1:2423" : "tcp://127.0.0.1:1422",
				true,
				configFileName ? "development" : undefined,
				expect.anything(),
				false,
				options.agentDir,
			);
			expect(vi.mocked(webRuntime.stopWebService).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(webRuntime.stopRuntimeService).mock.invocationCallOrder.at(-1)!,
			);
			expect(status).toMatchObject({ gateway: { running: true }, runtime: { running: true } });
		},
	);
});
