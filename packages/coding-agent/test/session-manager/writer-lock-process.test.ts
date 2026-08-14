import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionSnapshot, SessionManager } from "../../src/core/session-manager.ts";

interface WorkerResult {
	ok: boolean;
	ready?: boolean;
	code?: string;
	retryable?: boolean;
}

function startWorker(mode: "hold" | "try", sessionPath: string): ChildProcessWithoutNullStreams {
	return spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			fileURLToPath(new URL("../fixtures/session-lock-worker.mjs", import.meta.url)),
			mode,
			sessionPath,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
}

function readWorkerResult(child: ChildProcessWithoutNullStreams): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			const line = stdout.split("\n").find(Boolean);
			if (line) resolve(JSON.parse(line) as WorkerResult);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (!stdout.trim()) reject(new Error(`worker exited ${code}: ${stderr}`));
		});
	});
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("SessionManager writer lock across processes", () => {
	let tempDir: string;
	let sessionPath: string;
	const children: ChildProcessWithoutNullStreams[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-session-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "writer-lock-test",
				timestamp: new Date().toISOString(),
				cwd: tempDir,
			})}\n`,
		);
	});

	afterEach(async () => {
		for (const child of children) {
			if (!child.killed) child.kill("SIGKILL");
		}
		await Promise.all(children.map((child) => waitForExit(child)));
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects a second writer, allows readers, and releases on dispose", async () => {
		const holder = startWorker("hold", sessionPath);
		children.push(holder);
		expect(await readWorkerResult(holder)).toEqual({ ok: true, ready: true });

		const contender = startWorker("try", sessionPath);
		children.push(contender);
		expect(await readWorkerResult(contender)).toEqual({
			ok: false,
			name: "SessionLockedError",
			code: "session_locked",
			retryable: true,
		});
		expect(readSessionSnapshot(sessionPath).header.id).toBe("writer-lock-test");

		holder.stdin.write("dispose\n");
		await waitForExit(holder);
		const successor = SessionManager.open(sessionPath);
		successor.appendSessionInfo("successor");
		successor.dispose();
		expect(readSessionSnapshot(sessionPath).entries.at(-1)).toMatchObject({
			type: "session_info",
			name: "successor",
		});
	});

	it("recovers a stale lock after the owner is killed", async () => {
		const holder = startWorker("hold", sessionPath);
		children.push(holder);
		expect(await readWorkerResult(holder)).toEqual({ ok: true, ready: true });
		holder.kill("SIGKILL");
		await waitForExit(holder);

		const staleTime = new Date(Date.now() - 121_000);
		utimesSync(`${sessionPath}.lock`, staleTime, staleTime);
		const recovered = SessionManager.open(sessionPath);
		recovered.appendSessionInfo("recovered");
		recovered.dispose();
		expect(readSessionSnapshot(sessionPath).entries.at(-1)).toMatchObject({
			type: "session_info",
			name: "recovered",
		});
	});
});
