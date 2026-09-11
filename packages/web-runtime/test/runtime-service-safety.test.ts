import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeService, restartRuntimeService } from "../src/runtime-service.ts";
import { installWebService, stopWebService } from "../src/service-manager.ts";

const state = vi.hoisted(() => ({
	reachable: true,
	pid: 4321,
	manager: "systemd-user",
	operations: [] as Array<{ status: string; operationId: string }>,
	pendingUiRequests: [] as unknown[],
	readSnapshot: false,
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
	RuntimeProtocolClient: class {
		async connect() {}
		getSnapshot() {
			return { connected: true };
		}
		async request() {
			state.readSnapshot = true;
			return { operations: state.operations, pendingUiRequests: state.pendingUiRequests };
		}
		async close() {}
	},
}));
vi.mock("../src/service-manager.ts", () => ({
	currentProcessInvocation: () => ({ program: "/test/lc", args: [], cwd: "/test/agent" }),
	getWebServiceStatus: () => ({
		kind: "runtime",
		installed: true,
		running: state.reachable,
		manager: state.manager,
		pid: state.pid,
	}),
	installWebService: vi.fn(() => {
		expect(state.readSnapshot).toBe(true);
		state.reachable = true;
	}),
	stopWebService: vi.fn(() => {
		expect(state.readSnapshot).toBe(true);
		state.reachable = false;
	}),
	ensureWebService: vi.fn(() => {
		state.reachable = true;
	}),
	removeWebService: vi.fn(),
	webServiceDiagnostic: vi.fn(),
}));

beforeEach(() => {
	state.reachable = true;
	state.pid = 4321;
	state.manager = "systemd-user";
	state.operations = [];
	state.pendingUiRequests = [];
	state.readSnapshot = false;
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
	it("checks idle state before stopping and reinstalling", async () => {
		await installRuntimeService("/test/runtime.sock");
		expect(stopWebService).toHaveBeenCalledOnce();
		expect(installWebService).toHaveBeenCalledOnce();
	});
	it("restarts a macOS Runtime through launchd without a background sudo prompt", async () => {
		state.manager = "launch-daemon";
		const result = await restartRuntimeService("/test/runtime.sock");
		expect(process.kill).toHaveBeenCalledWith(4321, "SIGUSR2");
		expect(result.pid).toBe(4322);
		expect(stopWebService).not.toHaveBeenCalled();
	});
	it("does not signal a busy macOS Runtime", async () => {
		state.manager = "launch-daemon";
		state.operations = [{ status: "running", operationId: "active" }];
		await expect(restartRuntimeService("/test/runtime.sock")).rejects.toMatchObject({ code: "host_busy" });
		expect(process.kill).not.toHaveBeenCalledWith(expect.anything(), "SIGUSR2");
	});
});
