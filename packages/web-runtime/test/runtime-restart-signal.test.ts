import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWebRuntimeCli } from "../src/cli-runner.ts";
import { closeIpcRuntime, serveIpcRuntime } from "../src/ipc.ts";
import { writeRuntimePid } from "../src/runtime-service.ts";

vi.mock("../src/ipc.ts", () => ({
	defaultRuntimeEndpoint: () => "/test/runtime.sock",
	serveIpcRuntime: vi.fn(async () => Object.assign(new EventEmitter(), { listening: true })),
	closeIpcRuntime: vi.fn(async (server: EventEmitter & { listening: boolean }) => {
		server.listening = false;
		server.emit("close");
	}),
	runIpcRelay: vi.fn(),
}));
vi.mock("../src/runtime-adapter.ts", () => ({
	CodingAgentRuntimeAdapter: class {},
	getRuntimeAgentDir: () => "/test/agent",
}));
vi.mock("../src/service.ts", () => ({
	WebRuntimeService: class {
		async dispose() {}
	},
}));
vi.mock("../src/stdio.ts", () => ({ runStdioRuntime: vi.fn() }));
vi.mock("../src/runtime-service.ts", () => ({
	clearRuntimePid: vi.fn(),
	writeRuntimePid: vi.fn(),
	ensureRuntimeService: vi.fn(),
	getRuntimeServiceStatus: vi.fn(),
	installRuntimeService: vi.fn(),
	removeRuntimeService: vi.fn(),
	stopRuntimeService: vi.fn(),
}));
const originalExitCode = process.exitCode;
afterEach(() => {
	process.exitCode = originalExitCode;
	vi.clearAllMocks();
});

describe("managed Runtime restart signal", () => {
	it.skipIf(process.platform === "win32")(
		"closes the Runtime and exits unsuccessfully so launchd restarts it",
		async () => {
			const running = runWebRuntimeCli(["serve"]);
			await vi.waitFor(() => expect(writeRuntimePid).toHaveBeenCalledOnce());
			expect(serveIpcRuntime).toHaveBeenCalledOnce();
			process.emit("SIGUSR2");
			await running;
			expect(process.exitCode).toBe(1);
			expect(closeIpcRuntime).toHaveBeenCalledOnce();
		},
	);
});
