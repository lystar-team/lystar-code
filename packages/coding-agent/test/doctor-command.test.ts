import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDoctorCommand } from "../src/cli/doctor-command.ts";
import { getToolRecoveryLessonDiagnostics } from "../src/core/tool-recovery/lessons-store.ts";
import { main } from "../src/main.ts";

const tempDirs: string[] = [];
let agentDir: string;
let originalAgentDir: string | undefined;
let originalExitCode: typeof process.exitCode;

function createTempDir(): string {
	const directory = join(tmpdir(), `pi-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	tempDirs.push(directory);
	return directory;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		process.exitCode = undefined;
		await main(args);
		return {
			stdout: log.mock.calls.map(([message]) => String(message)).join("\n"),
			stderr: error.mock.calls.map(([message]) => String(message)).join("\n"),
			exitCode: process.exitCode,
		};
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

beforeEach(() => {
	agentDir = createTempDir();
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	originalExitCode = process.exitCode;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.exitCode = undefined;
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("doctor CLI", () => {
	it("parses only the supported JSON option", () => {
		expect(parseDoctorCommand(["doctor"])).toEqual({ json: false });
		expect(parseDoctorCommand(["doctor", "--json"])).toEqual({ json: true });
		expect(() => parseDoctorCommand(["doctor", "--verbose"])).toThrow("doctor 不支持参数");
	});

	it("reports standalone diagnostics without creating an AgentSession", async () => {
		const result = await runCli(["doctor", "--json"]);
		expect(result).toMatchObject({ stderr: "", exitCode: undefined });
		const report = JSON.parse(result.stdout) as {
			recovery: { sessionActive: boolean; activeCircuits: number; metrics: object };
			lessons: { available: boolean; counts: Record<string, number> };
			frontend: { implementation: string; modes: string[]; rust: { b0Status: string; integration: string } };
		};
		expect(report.recovery).toEqual({ sessionActive: false, activeCircuits: 0, metrics: {} });
		expect(report.lessons).toEqual({
			available: true,
			counts: { candidate: 0, verified: 0, active: 0, disabled: 0, expired: 0 },
		});
		expect(report.frontend).toEqual({
			implementation: "typescript",
			modes: ["regular", "fullscreen"],
			rust: { b0Status: "stop", integration: "not_integrated" },
		});
	});

	it("does not repair or disclose a damaged lesson store", async () => {
		const recoveryDir = join(agentDir, "tool-recovery");
		mkdirSync(recoveryDir, { recursive: true });
		writeFileSync(
			join(recoveryDir, "lessons.json"),
			'{"guidance":"private guidance /private/session.jsonl OPENAI_API_KEY=sk-test-secret"}',
		);
		const diagnostic = await getToolRecoveryLessonDiagnostics(agentDir);
		expect(diagnostic).toMatchObject({ available: false, error: { code: "lesson_store_corrupt" } });
		expect(readdirSync(recoveryDir)).toEqual(["lessons.json"]);

		const result = await runCli(["doctor", "--json"]);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).not.toContain("private guidance");
		expect(result.stdout).not.toContain("/private/session.jsonl");
		expect(result.stdout).not.toContain("sk-test-secret");
		expect(JSON.parse(result.stdout)).toMatchObject({
			lessons: { available: false, error: { code: "lesson_store_corrupt" } },
		});
	});
});
