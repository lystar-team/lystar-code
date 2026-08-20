import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../coding-agent/src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../coding-agent/src/core/agent-session-services.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import type { RustTuiStartupInput } from "../../coding-agent/src/rust-tui-frontend.ts";
import { createRustTuiEndpoint, runEmbeddedRustTui } from "../src/rust-tui-frontend.ts";

const clientFixture = fileURLToPath(new URL("./fixtures/embedded-rust-client.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function setEnvironment(name: string, value: string | undefined): void {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	cleanups.push(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
}

function endpointDirectories(root = tmpdir()): string[] {
	return readdirSync(root)
		.filter((name) => name.startsWith("lystar-rust-tui-"))
		.sort();
}

function expectCapturedEndpointRemoved(path: string): void {
	const endpoint = readFileSync(path, "utf8");
	expect(existsSync(endpoint)).toBe(false);
	expect(existsSync(dirname(endpoint))).toBe(false);
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

interface FrontendFixture {
	tempDir: string;
	cwd: string;
	agentDir: string;
	sessionPath: string;
	client: string;
	endpointCapturePath: string;
	runtime: AgentSessionRuntime;
	setBinary(path: string): void;
	setClientMode(mode: string): void;
	factoryCalls(): number;
	run(startupInput?: RustTuiStartupInput): ReturnType<typeof runEmbeddedRustTui>;
}

async function createFrontendFixture(): Promise<FrontendFixture> {
	const systemTemp = tmpdir();
	const tempDir = mkdtempSync(join(systemTemp, "lystar-embedded-rust-"));
	const endpointRoot = mkdtempSync(join(systemTemp, "lrt-"));
	const cwd = join(tempDir, "project");
	const agentDir = join(tempDir, "agent");
	const sessionPath = join(tempDir, "session.jsonl");
	const client = join(tempDir, "lystar-tui");
	const endpointCapturePath = join(tempDir, "endpoint.txt");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		sessionPath,
		`${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "embedded-rust",
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
	writeFileSync(
		client,
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(tsxImport)} ${shellQuote(clientFixture)} "$@"\n`,
	);
	chmodSync(client, 0o700);
	setEnvironment("PI_RUST_TUI_BINARY", client);
	setEnvironment("PI_EMBEDDED_CLIENT_MODE", "normal");
	setEnvironment("PI_EMBEDDED_ENDPOINT_CAPTURE_PATH", endpointCapturePath);
	setEnvironment("TMPDIR", endpointRoot);

	const manager = SessionManager.open(sessionPath);
	let factoryCallCount = 0;
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		factoryCallCount++;
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager });
	factoryCallCount = 0;
	cleanups.push(async () => {
		if (SessionManager.isWriterLocked(sessionPath)) await runtime.dispose();
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(endpointRoot, { recursive: true, force: true });
	});

	return {
		tempDir,
		cwd,
		agentDir,
		sessionPath,
		client,
		endpointCapturePath,
		runtime,
		setBinary: (path) => setEnvironment("PI_RUST_TUI_BINARY", path),
		setClientMode: (mode) => setEnvironment("PI_EMBEDDED_CLIENT_MODE", mode),
		factoryCalls: () => factoryCallCount,
		run: (startupInput) =>
			runEmbeddedRustTui({
				runtime,
				createRuntime,
				agentDir,
				launchOptions: { sessionPath, mode: "regular", exitOutput: "resume-hint", reduceMotion: false },
				startupInput,
			}),
	};
}

describe("embedded Rust TUI frontend", () => {
	test("creates a unique Windows named-pipe endpoint without a filesystem directory", () => {
		const first = createRustTuiEndpoint("win32");
		const second = createRustTuiEndpoint("win32");

		expect(first.endpoint).toMatch(/^\\\\\.\\pipe\\lystar-rust-tui-\d+-[0-9a-f-]{36}$/);
		expect(first.directory).toBeUndefined();
		expect(second.endpoint).not.toBe(first.endpoint);
	});

	test.runIf(process.platform !== "win32")(
		"keeps the existing Runtime when the sidecar is missing or not executable",
		async () => {
			const fixture = await createFrontendFixture();
			const directoriesBefore = endpointDirectories();

			fixture.setBinary(join(fixture.tempDir, "missing-lystar-tui"));
			expect(await fixture.run()).toEqual({ handled: false, reason: "未找到 lystar-tui sidecar" });

			const nonExecutable = join(fixture.tempDir, "not-executable");
			writeFileSync(nonExecutable, "not executable\n");
			chmodSync(nonExecutable, 0o600);
			fixture.setBinary(nonExecutable);
			expect(await fixture.run()).toEqual({ handled: false, reason: "未找到 lystar-tui sidecar" });

			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(true);
			expect(endpointDirectories()).toEqual(directoriesBefore);
		},
		20_000,
	);

	test.runIf(process.platform !== "win32")(
		"returns a pre-acquire failure when the Host endpoint directory cannot be created",
		async () => {
			const fixture = await createFrontendFixture();
			const systemTemp = tmpdir();
			const directoriesBefore = endpointDirectories(systemTemp);
			const blockedTemp = join(fixture.tempDir, "blocked-tmp");
			writeFileSync(blockedTemp, "file");
			setEnvironment("TMPDIR", blockedTemp);

			const result = await fixture.run();
			expect(result.handled).toBe(false);
			expect(result.handled ? "" : result.reason).toContain("无法创建 Host 临时目录");
			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(true);
			expect(endpointDirectories(systemTemp)).toEqual(directoriesBefore);
		},
		20_000,
	);

	test.runIf(process.platform !== "win32")(
		"cleans the endpoint and keeps the Runtime when the sidecar cannot spawn",
		async () => {
			const fixture = await createFrontendFixture();
			const directoriesBefore = endpointDirectories();
			fixture.setBinary(fixture.cwd);

			const result = await fixture.run();
			expect(result.handled).toBe(false);
			expect(result.handled ? "" : result.reason).toContain("无法启动 project");
			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(true);
			expect(endpointDirectories()).toEqual(directoriesBefore);
		},
		20_000,
	);

	test.runIf(process.platform !== "win32").each([
		["pre-acquire-exit-7", "Rust TUI 在接管 Session 前退出（code=7, signal=null）"],
		["hello-version", "Rust TUI 在接管 Session 前退出（code=8, signal=null）"],
		["malformed-frame", "Rust TUI 在接管 Session 前退出（code=9, signal=null）"],
	])(
		"rejects %s before ownership transfer",
		async (mode, reason) => {
			const fixture = await createFrontendFixture();
			fixture.setClientMode(mode);

			expect(await fixture.run()).toEqual({ handled: false, reason });
			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(true);
			expectCapturedEndpointRemoved(fixture.endpointCapturePath);
		},
		20_000,
	);

	test.runIf(process.platform !== "win32")(
		"adopts the existing Runtime and delivers acquire-scoped startup input",
		async () => {
			const fixture = await createFrontendFixture();
			const startupExpectedPath = join(fixture.tempDir, "startup-input.json");
			const startupInput: RustTuiStartupInput = {
				batchId: "embedded-startup",
				prompts: [
					{
						text: "startup text",
						images: [{ data: "cGl4ZWw=", mimeType: "image/png" }],
					},
					{ text: "follow-up startup text" },
				],
			};
			writeFileSync(startupExpectedPath, JSON.stringify(startupInput));
			setEnvironment("PI_EMBEDDED_STARTUP_EXPECTED_PATH", startupExpectedPath);

			expect(await fixture.run(startupInput)).toEqual({ handled: true, exitCode: 0 });
			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(false);
			expectCapturedEndpointRemoved(fixture.endpointCapturePath);
		},
		20_000,
	);

	test.runIf(process.platform !== "win32").each([
		["acquire-exit-17", 17],
		["acquire-sigterm", 1],
	])(
		"does not allow fallback after ownership transfer: %s",
		async (mode, expectedExitCode) => {
			const fixture = await createFrontendFixture();
			fixture.setClientMode(mode);

			expect(await fixture.run()).toEqual({ handled: true, exitCode: expectedExitCode });
			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(false);
			expectCapturedEndpointRemoved(fixture.endpointCapturePath);
		},
		20_000,
	);

	test.runIf(process.platform !== "win32")(
		"releases a claimed Runtime when Host binding fails during acquire",
		async () => {
			const fixture = await createFrontendFixture();
			(
				fixture.runtime.session as unknown as {
					bindExtensions(): Promise<void>;
				}
			).bindExtensions = async () => {
				throw new Error("bind failed");
			};

			expect(await fixture.run()).toEqual({ handled: true, exitCode: 3 });
			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(false);
			expectCapturedEndpointRemoved(fixture.endpointCapturePath);
		},
		20_000,
	);

	test.runIf(process.platform !== "win32")(
		"executes an accepted operation once and cleans ownership after disconnect",
		async () => {
			const fixture = await createFrontendFixture();
			const markerPath = join(fixture.tempDir, "operation-marker.txt");
			fixture.setClientMode("run-bash-disconnect");
			setEnvironment("PI_EMBEDDED_OPERATION_MARKER_PATH", markerPath);

			expect(await fixture.run()).toEqual({ handled: true, exitCode: 0 });
			await waitFor("accepted Shell marker", () => existsSync(markerPath));
			expect(readFileSync(markerPath, "utf8")).toBe("once\n");
			expect(fixture.factoryCalls()).toBe(0);
			expect(SessionManager.isWriterLocked(fixture.sessionPath)).toBe(false);
			expectCapturedEndpointRemoved(fixture.endpointCapturePath);
		},
		20_000,
	);
});
