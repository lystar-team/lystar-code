import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationSnapshot, RUNTIME_PROTOCOL_VERSION, type ServerMessage } from "@lystar/code-web-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRuntimeService } from "../src/service.ts";
import type { RuntimeAdapter, RuntimeSession } from "../src/types.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(holdAcceptedResponse = false) {
	const directory = mkdtempSync(join(tmpdir(), "web-stop-lifecycle-"));
	const sessionPath = join(directory, "session.jsonl");
	writeFileSync(sessionPath, "{}\n");
	const started = deferred();
	const promptRelease = deferred();
	const abortEntered = deferred();
	const abortRelease = deferred();
	const accepted = deferred();
	const responseRelease = deferred();
	let running = false;
	const prompt = vi.fn(async () => {
		running = true;
		started.resolve();
		await promptRelease.promise;
		running = false;
	});
	const abort = vi.fn(async () => {
		abortEntered.resolve();
		await abortRelease.promise;
		running = false;
		promptRelease.resolve();
	});
	const runtime = {
		sessionPath,
		getSnapshot: (writeAccess: "available" | "owned" | "controlled_elsewhere" | "locked_externally") => ({
			id: "session",
			path: sessionPath,
			cwd: directory,
			createdAt: 0,
			updatedAt: 0,
			phase: running ? "turn" : "idle",
			activity: running ? "running" : "idle",
			thinkingLevel: "off",
			attached: true,
			writeAccess,
			revision: 0,
			leafId: null,
			queuedSteerCount: 0,
			queuedFollowUpCount: 0,
			transcriptGeneration: "test",
			transcriptRevision: 0,
		}),
		prompt,
		abort,
		clearQueue: async () => ({ steering: [], followUp: [] }),
		onEvent: () => () => {},
		dispose: async () => {},
	} as unknown as RuntimeSession;
	const adapter = {
		getAbout: () => ({ productVersion: "test" }),
		openSession: async () => runtime,
		inspectSession: () => runtime.getSnapshot("available"),
		isSessionWriterLocked: () => false,
		listSessions: async () => [],
	} as unknown as RuntimeAdapter;
	const service = new WebRuntimeService(adapter, { agentDir: directory });
	const messages: ServerMessage[] = [];
	const owner = service.createConnection(async (message) => {
		messages.push(message);
		if (holdAcceptedResponse && message.type === "response" && message.id === "prompt-first") {
			accepted.resolve();
			await responseRelease.promise;
		}
	});
	const stopMessages: ServerMessage[] = [];
	const controller = service.createConnection(async (message) => {
		stopMessages.push(message);
	});
	cleanups.push(async () => {
		abortRelease.resolve();
		promptRelease.resolve();
		responseRelease.resolve();
		await owner.close();
		await controller.close();
		await service.dispose();
		rmSync(directory, { recursive: true, force: true });
	});
	await owner.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "owner" });
	await controller.handle({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "controller" });
	await owner.handle({
		type: "request",
		id: "acquire",
		request: { command: "acquire_session", sessionPath, clientInstanceId: "owner" },
	});
	const acquired = messages.find((message) => message.type === "response" && message.id === "acquire");
	expect(acquired).toMatchObject({ ok: true });
	if (acquired?.type !== "response" || !acquired.ok) throw new Error("没有取得会话");
	const leaseId = (acquired.result as { lease: { leaseId: string } }).lease.leaseId;
	const submit = (id: string) =>
		owner.handle({
			type: "request",
			id,
			request: {
				command: "prompt",
				sessionPath,
				leaseId,
				text: id,
				clientInstanceId: "owner",
				clientRequestId: id,
			},
		});
	const operation = () => {
		const response = messages.find((message) => message.type === "response" && message.id === "prompt-first");
		if (response?.type !== "response" || !response.ok) throw new Error("没有取得任务");
		return (response.result as { operation: OperationSnapshot }).operation;
	};
	const getOperation = async () => {
		const id = `inspect-${messages.length}`;
		await owner.handle({
			type: "request",
			id,
			request: { command: "get_operation", operationId: operation().operationId },
		});
		const response = messages.find((message) => message.type === "response" && message.id === id);
		if (response?.type !== "response" || !response.ok) throw new Error("没有取得任务状态");
		return response.result as OperationSnapshot;
	};
	return {
		owner,
		controller,
		messages,
		stopMessages,
		submit,
		getOperation,
		operation,
		leaseId,
		prompt,
		abort,
		started,
		promptRelease,
		abortEntered,
		abortRelease,
		accepted,
		responseRelease,
	};
}

describe("停止会话的 Runtime 终态", () => {
	for (const command of ["stop_session", "abort_operation"] as const) {
		it(`${command} 等待真实停止完成，重复取消去重且停止后可以提交任务`, async () => {
			const fixture = await setup();
			await fixture.submit("prompt-first");
			await fixture.started.promise;
			const cancel = (id: string) =>
				command === "stop_session"
					? fixture.controller.handle({ type: "request", id, request: { command, sessionId: "session" } })
					: fixture.owner.handle({
							type: "request",
							id,
							request: { command, operationId: fixture.operation().operationId, leaseId: fixture.leaseId },
						});
			const first = cancel("stop-first");
			await fixture.abortEntered.promise;
			const second = cancel("stop-second");
			fixture.promptRelease.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect((await fixture.getOperation()).status).toBe("running");
			expect(
				[...fixture.messages, ...fixture.stopMessages].some(
					(message) =>
						message.type === "event" &&
						message.event.type === "operation_updated" &&
						message.event.operation.status === "aborted",
				),
			).toBe(false);
			await fixture.submit("during-stop");
			expect(
				fixture.messages.find((message) => message.type === "response" && message.id === "during-stop"),
			).toMatchObject({ ok: false, error: { code: "session_operation_active" } });
			fixture.abortRelease.resolve();
			await Promise.all([first, second]);
			expect(fixture.abort).toHaveBeenCalledTimes(1);
			expect((await fixture.getOperation()).status).toBe("aborted");
			await fixture.submit("after-stop");
			await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalledTimes(2));
		});
	}

	it("停止已经接受但未调度的任务后，迟到响应不能重新启动它", async () => {
		const fixture = await setup(true);
		const accepted = fixture.submit("prompt-first");
		await fixture.accepted.promise;
		expect(fixture.operation().status).toBe("accepted");
		const stopping = fixture.controller.handle({
			type: "request",
			id: "stop",
			request: { command: "stop_session", sessionId: "session" },
		});
		await fixture.abortEntered.promise;
		fixture.abortRelease.resolve();
		await stopping;
		expect((await fixture.getOperation()).status).toBe("aborted");
		fixture.responseRelease.resolve();
		await accepted;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(fixture.prompt).not.toHaveBeenCalled();
		await fixture.submit("after-stop");
		await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalledTimes(1));
	});
});
