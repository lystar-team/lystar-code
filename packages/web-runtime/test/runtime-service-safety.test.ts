import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertRuntimeIdle,
	createRuntimeServiceSpec,
	installRuntimeService,
	restartRuntimeService,
} from "../src/runtime-service.ts";
import { installWebService, stopWebService } from "../src/service-manager.ts";

const state = vi.hoisted(() => ({
	reachable: true,
	installed: true,
	pid: 4321,
	manager: "systemd-user",
	connected: true,
	operations: [] as Array<{ status: string; operationId: string }>,
	pendingUiRequests: [] as unknown[],
	sessions: [] as Array<{ path: string; activity: string; phase: string }>,
	readSnapshot: false,
	requiredProtocolVersion: 7,
	attemptedProtocolVersions: [] as number[],
}));
vi.mock("node:fs", () => ({
	readFileSync: () => String(state.pid),
	mkdirSync: vi.fn(),
	unlinkSync: vi.fn(),
	writeFileSync: vi.fn(),
}));
vi.mock("../src/runtime-adapter.ts", () => ({ getRuntimeAgentDir: () => "/test/agent" }));
vi.mock("../src/ipc.ts", () => ({
	probeIpcRuntime: async () => ({ reachable: state.reachable }),
	connectRuntimeEndpoint: async () => new EventEmitter(),
	defaultRuntimeEndpoint: () => "/test/runtime.sock",
}));
vi.mock("@lystar/code-web-protocol", () => ({
	RUNTIME_PROTOCOL_VERSION: 7,
	RuntimeProtocolClient: class {
		private readonly protocolVersion: number;

		constructor(_transport: unknown, _clientInstanceId: string, options: { protocolVersion?: number } = {}) {
			this.protocolVersion = options.protocolVersion ?? 7;
			state.attemptedProtocolVersions.push(this.protocolVersion);
		}

		async connect() {}
		getSnapshot() {
			if (!state.connected) return { connected: false, lastError: "Runtime unresponsive" };
			if (this.protocolVersion !== state.requiredProtocolVersion) {
				return {
					connected: false,
					lastError: `Web Runtime Protocol ${this.protocolVersion} is unsupported; Host requires ${state.requiredProtocolVersion}`,
				};
			}
			return { connected: true };
		}
		async request() {
			state.readSnapshot = true;
			return { operations: state.operations, pendingUiRequests: state.pendingUiRequests, sessions: state.sessions };
		}
		async close() {}
	},
}));
vi.mock("../src/service-manager.ts", () => ({
	currentProcessInvocation: () => ({ program: "/test/lc", args: [], cwd: "/test/agent" }),
	getWebServiceStatus: () => ({
		kind: "runtime",
		installed: state.installed,
		running: state.reachable,
		manager: state.manager,
		pid: state.pid,
	}),
	installWebService: vi.fn(() => {
		expect(state.readSnapshot).toBe(true);
		state.installed = true;
		state.reachable = true;
		state.connected = true;
	}),
	stopWebService: vi.fn((_spec, force: boolean) => {
		if (force) expect(state.readSnapshot).toBe(false);
		else expect(state.readSnapshot).toBe(true);
		state.reachable = false;
		state.connected = false;
	}),
	ensureWebService: vi.fn(() => {
		state.reachable = true;
		state.connected = true;
	}),
	removeWebService: vi.fn(),
	webServiceDiagnostic: vi.fn(),
}));

beforeEach(() => {
	state.reachable = true;
	state.installed = true;
	state.pid = 4321;
	state.manager = "systemd-user";
	state.connected = true;
	state.operations = [];
	state.pendingUiRequests = [];
	state.sessions = [];
	state.readSnapshot = false;
	state.requiredProtocolVersion = 7;
	state.attemptedProtocolVersions = [];
	vi.clearAllMocks();
	vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
		if (signal === "SIGUSR2") state.pid++;
		return true;
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("Runtime update and restart safety", () => {
	it.each(["accepted", "running", "waiting_for_input"])(
		"does not reinstall a Runtime with %s work",
		async (status) => {
			state.operations = [{ status, operationId: "active" }];
			await expect(installRuntimeService("/test/runtime.sock")).rejects.toMatchObject({ code: "host_busy" });
			expect(stopWebService).not.toHaveBeenCalled();
			expect(installWebService).not.toHaveBeenCalled();
		},
	);
	it("does not reinstall a Runtime with a pending interaction", async () => {
		state.pendingUiRequests = [{}];
		await expect(installRuntimeService("/test/runtime.sock")).rejects.toMatchObject({ code: "host_busy" });
		expect(stopWebService).not.toHaveBeenCalled();
	});
	it("does not reinstall a Runtime whose Session is active through a companion client", async () => {
		state.sessions = [{ path: "/test/session.jsonl", activity: "running", phase: "turn" }];
		await expect(installRuntimeService("/test/runtime.sock")).rejects.toMatchObject({
			code: "host_busy",
			activeSessions: ["/test/session.jsonl"],
		});
		expect(stopWebService).not.toHaveBeenCalled();
	});
	it("checks a legacy Runtime with the protocol version it requires", async () => {
		state.requiredProtocolVersion = 4;

		await assertRuntimeIdle("/test/runtime.sock");

		expect(state.attemptedProtocolVersions).toEqual([7, 4]);
		expect(state.readSnapshot).toBe(true);
	});
	it("preserves busy Runtime protection across a protocol upgrade", async () => {
		state.requiredProtocolVersion = 4;
		state.operations = [{ status: "running", operationId: "active" }];

		await expect(assertRuntimeIdle("/test/runtime.sock")).rejects.toMatchObject({ code: "host_busy" });

		expect(state.attemptedProtocolVersions).toEqual([7, 4]);
		expect(state.readSnapshot).toBe(true);
	});
	it("passes the Runtime Profile to the managed process environment", () => {
		const spec = createRuntimeServiceSpec("tcp://127.0.0.1:2423", {
			profile: "development",
			agentDir: "/test/agent",
		});
		expect(spec.environment?.PI_WEB_SERVICE_PROFILE).toBe("development");
		expect(spec.macosSession).toBe("gui");
	});
	it("checks idle state before stopping and reinstalling", async () => {
		await installRuntimeService("/test/runtime.sock");
		expect(stopWebService).toHaveBeenCalledOnce();
		expect(installWebService).toHaveBeenCalledOnce();
	});
	it("installs and restarts a detached development Runtime", async () => {
		state.manager = "detached";
		state.installed = false;

		const result = await restartRuntimeService("/test/runtime.sock", "development", {
			program: "/test/lc",
			args: ["web-runtime", "serve"],
			cwd: "/test/agent",
		});

		expect(stopWebService).toHaveBeenCalledOnce();
		expect(installWebService).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ installed: true, responsive: true });
	});

	it("restarts a macOS Runtime LaunchAgent through launchd without a background sudo prompt", async () => {
		state.manager = "launch-agent";
		const result = await restartRuntimeService("/test/runtime.sock");
		expect(process.kill).toHaveBeenCalledWith(4321, "SIGUSR2");
		expect(result.pid).toBe(4322);
		expect(stopWebService).not.toHaveBeenCalled();
	});
	it("force-recovers a Runtime whose port accepts connections but protocol handshake is broken", async () => {
		state.connected = false;

		const result = await restartRuntimeService("/test/runtime.sock");

		expect(stopWebService).toHaveBeenCalledWith(expect.anything(), true, expect.anything());
		expect(result.responsive).toBe(true);
	});

	it("does not signal a busy macOS Runtime", async () => {
		state.manager = "launch-daemon";
		state.operations = [{ status: "running", operationId: "active" }];
		await expect(restartRuntimeService("/test/runtime.sock")).rejects.toMatchObject({ code: "host_busy" });
		expect(process.kill).not.toHaveBeenCalledWith(expect.anything(), "SIGUSR2");
	});
});
