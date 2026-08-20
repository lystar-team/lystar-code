import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../coding-agent/src/core/agent-session-runtime.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../coding-agent/src/core/agent-session-services.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import { runEmbeddedRustTui } from "../src/rust-tui-frontend.ts";

const fixture = fileURLToPath(new URL("./fixtures/embedded-rust-client.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("embedded Rust TUI frontend", () => {
	test.runIf(process.platform !== "win32")(
		"adopts the existing Runtime through the in-process Host",
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "lystar-embedded-rust-"));
			const cwd = join(tempDir, "project");
			const agentDir = join(tempDir, "agent");
			const sessionPath = join(tempDir, "session.jsonl");
			const client = join(tempDir, "lystar-tui");
			const preAcquireClient = join(tempDir, "lystar-tui-pre-acquire");
			const startupExpectedPath = join(tempDir, "startup-input.json");
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
				`#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(tsxImport)} ${shellQuote(fixture)} "$@"\n`,
			);
			writeFileSync(preAcquireClient, "#!/bin/sh\nexit 7\n");
			chmodSync(client, 0o700);
			chmodSync(preAcquireClient, 0o700);
			const previousBinary = process.env.PI_RUST_TUI_BINARY;
			const previousStartupExpectedPath = process.env.PI_EMBEDDED_STARTUP_EXPECTED_PATH;
			process.env.PI_RUST_TUI_BINARY = client;
			const startupInput = {
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
			process.env.PI_EMBEDDED_STARTUP_EXPECTED_PATH = startupExpectedPath;
			cleanups.push(() => {
				if (previousBinary === undefined) delete process.env.PI_RUST_TUI_BINARY;
				else process.env.PI_RUST_TUI_BINARY = previousBinary;
				if (previousStartupExpectedPath === undefined) delete process.env.PI_EMBEDDED_STARTUP_EXPECTED_PATH;
				else process.env.PI_EMBEDDED_STARTUP_EXPECTED_PATH = previousStartupExpectedPath;
				rmSync(tempDir, { recursive: true, force: true });
			});

			const manager = SessionManager.open(sessionPath);
			let factoryCalls = 0;
			const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
				factoryCalls++;
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
			factoryCalls = 0;
			process.env.PI_RUST_TUI_BINARY = preAcquireClient;
			const preAcquireResult = await runEmbeddedRustTui({
				runtime,
				createRuntime,
				agentDir,
				launchOptions: { sessionPath, mode: "regular", exitOutput: "resume-hint", reduceMotion: false },
			});
			expect(preAcquireResult).toEqual({
				handled: false,
				reason: "Rust TUI 在接管 Session 前退出（code=7, signal=null）",
			});
			expect(factoryCalls).toBe(0);
			expect(SessionManager.isWriterLocked(sessionPath)).toBe(true);

			process.env.PI_RUST_TUI_BINARY = client;
			const result = await runEmbeddedRustTui({
				runtime,
				createRuntime,
				agentDir,
				launchOptions: { sessionPath, mode: "regular", exitOutput: "resume-hint", reduceMotion: false },
				startupInput,
			});

			expect(result).toEqual({ handled: true, exitCode: 0 });
			expect(factoryCalls).toBe(0);
			expect(SessionManager.isWriterLocked(sessionPath)).toBe(false);
		},
		20_000,
	);
});
