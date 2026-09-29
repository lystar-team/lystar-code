import { PassThrough, Writable } from "node:stream";
import { type ClientMessage, encodeClientMessage, RUNTIME_PROTOCOL_VERSION } from "@lystar/code-web-protocol";
import { describe, expect, it } from "vitest";
import type { WebRuntimeService } from "../src/service.ts";
import {
	createBoundedWriter,
	MAX_RUNTIME_WRITE_BYTES,
	runRuntimeStream,
	writeBounded,
} from "../src/stream-transport.ts";

function slowStream() {
	return new Writable({ highWaterMark: 1, write() {} });
}

async function waitForSignal(signal: Promise<void>, message: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			signal,
			new Promise<void>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), 1000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("Runtime 发送生命周期", () => {
	it("只读请求最多并发四个，空出名额后继续执行", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let signalFour!: () => void;
		const fourStarted = new Promise<void>((resolve) => {
			signalFour = resolve;
		});
		let signalFive!: () => void;
		const fiveStarted = new Promise<void>((resolve) => {
			signalFive = resolve;
		});
		let active = 0;
		let maxActive = 0;
		const started: string[] = [];
		const service = {
			createConnection() {
				return {
					async handle(message: ClientMessage) {
						if (message.type !== "request") return;
						active++;
						maxActive = Math.max(maxActive, active);
						started.push(message.id);
						if (started.length === 4) signalFour();
						if (started.length === 5) signalFive();
						if (message.id === "read-1") await firstGate;
						else await gate;
						active--;
					},
					async close() {},
				};
			},
		} as unknown as WebRuntimeService;
		const running = runRuntimeStream(service, input, output);
		try {
			input.write(
				encodeClientMessage({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "client" }),
			);
			for (let index = 1; index <= 5; index++)
				input.write(
					encodeClientMessage({
						type: "request",
						id: `read-${index}`,
						request: { command: "get_operation", operationId: `op-${index}` },
					}),
				);
			await waitForSignal(fourStarted, "只读请求未并发执行");
			expect(started).toHaveLength(4);
			expect(maxActive).toBe(4);
			releaseFirst();
			await waitForSignal(fiveStarted, "空出并发名额后第五个请求未执行");
			expect(maxActive).toBe(4);
		} finally {
			releaseFirst();
			release();
			input.end();
			await running;
			output.destroy();
		}
	});

	it("会话列表与安全读取重叠，但会话列表彼此串行且后续有序请求等待读取结束", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		let releaseBefore!: () => void;
		let releaseListOne!: () => void;
		let releaseListTwo!: () => void;
		const beforeGate = new Promise<void>((resolve) => {
			releaseBefore = resolve;
		});
		const listOneGate = new Promise<void>((resolve) => {
			releaseListOne = resolve;
		});
		const listTwoGate = new Promise<void>((resolve) => {
			releaseListTwo = resolve;
		});
		const signals = new Map<string, () => void>();
		const started = new Map<string, Promise<void>>();
		for (const id of ["before", "list-1", "read", "list-2", "read-after-list", "after"]) {
			started.set(
				id,
				new Promise<void>((resolve) => {
					signals.set(id, resolve);
				}),
			);
		}
		const events: string[] = [];
		const service = {
			createConnection() {
				return {
					async handle(message: ClientMessage) {
						if (message.type !== "request") return;
						events.push(`${message.id}:start`);
						signals.get(message.id)?.();
						if (message.id === "before") await beforeGate;
						if (message.id === "list-1") await listOneGate;
						if (message.id === "list-2") await listTwoGate;
						events.push(`${message.id}:end`);
					},
					async close() {},
				};
			},
		} as unknown as WebRuntimeService;
		const running = runRuntimeStream(service, input, output);
		const send = (message: ClientMessage) => input.write(encodeClientMessage(message));
		try {
			send({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "client" });
			send({ type: "request", id: "before", request: { command: "room_project_list", cwd: "/project" } });
			send({ type: "request", id: "list-1", request: { command: "list_sessions", cwd: "/project" } });
			send({ type: "request", id: "read", request: { command: "get_operation", operationId: "op" } });
			send({ type: "request", id: "list-2", request: { command: "list_sessions", cwd: "/project" } });
			send({ type: "request", id: "read-after-list", request: { command: "get_operation", operationId: "other" } });
			send({ type: "request", id: "after", request: { command: "room_project_list", cwd: "/project" } });
			await waitForSignal(started.get("before")!, "前序请求未启动");
			expect(events).toEqual(["before:start"]);
			releaseBefore();
			await waitForSignal(started.get("read")!, "安全读取未与会话列表重叠");
			await waitForSignal(started.get("read-after-list")!, "第二个列表堵住了后面的安全读取");
			expect(events).toContain("list-1:start");
			expect(events).not.toContain("list-2:start");
			expect(events).not.toContain("after:start");
			releaseListOne();
			await waitForSignal(started.get("list-2")!, "第二个会话列表未启动");
			expect(events).not.toContain("after:start");
			releaseListTwo();
			await waitForSignal(started.get("after")!, "后续有序请求未启动");
			expect(events.indexOf("list-2:end")).toBeLessThan(events.indexOf("after:start"));
		} finally {
			releaseBefore();
			releaseListOne();
			releaseListTwo();
			input.end();
			await running;
			output.destroy();
		}
	});

	it("批次处理失败后不启动排队读取和后续写入", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started: string[] = [];
		const service = {
			createConnection() {
				return {
					async handle(message: ClientMessage) {
						if (message.type !== "request") return;
						started.push(message.id);
						if (message.id === "read-1") throw new Error("read failed");
						if (message.request.command === "get_operation") await gate;
					},
					async close() {},
				};
			},
		} as unknown as WebRuntimeService;
		const running = runRuntimeStream(service, input, output);
		const assertion = expect(running).rejects.toThrow("read failed");
		try {
			input.write(
				encodeClientMessage({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "client" }),
			);
			for (let index = 1; index <= 5; index++)
				input.write(
					encodeClientMessage({
						type: "request",
						id: `read-${index}`,
						request: { command: "get_operation", operationId: `op-${index}` },
					}),
				);
			input.write(
				encodeClientMessage({
					type: "request",
					id: "write",
					request: { command: "room_project_list", cwd: "/project" },
				}),
			);
			await waitForSignal(assertion, "批次失败后连接未结束");
			release();
			await Promise.resolve();
			expect(started).toContain("read-1");
			expect(started).not.toContain("read-5");
			expect(started).not.toContain("write");
		} finally {
			release();
			input.destroy();
			output.destroy();
			await running.catch(() => {});
		}
	});

	it("项目会话列表与安全读取和同类列表重叠，有序请求仍等待批次结束", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		let releaseFirstProject!: () => void;
		let releaseSecondProject!: () => void;
		const firstProjectGate = new Promise<void>((resolve) => {
			releaseFirstProject = resolve;
		});
		const secondProjectGate = new Promise<void>((resolve) => {
			releaseSecondProject = resolve;
		});
		let signalFirstProject!: () => void;
		let signalSecondProject!: () => void;
		let signalRead!: () => void;
		let signalAfter!: () => void;
		const firstProjectStarted = new Promise<void>((resolve) => {
			signalFirstProject = resolve;
		});
		const secondProjectStarted = new Promise<void>((resolve) => {
			signalSecondProject = resolve;
		});
		const readStarted = new Promise<void>((resolve) => {
			signalRead = resolve;
		});
		const afterStarted = new Promise<void>((resolve) => {
			signalAfter = resolve;
		});
		const handled: string[] = [];
		const service = {
			createConnection() {
				return {
					async handle(message: ClientMessage) {
						if (message.type !== "request") return;
						handled.push(message.id);
						if (message.id === "project-1") {
							signalFirstProject();
							await firstProjectGate;
						}
						if (message.id === "project-2") {
							signalSecondProject();
							await secondProjectGate;
						}
						if (message.id === "read") signalRead();
						if (message.id === "after") signalAfter();
					},
					async close() {},
				};
			},
		} as unknown as WebRuntimeService;
		const running = runRuntimeStream(service, input, output);
		try {
			input.write(
				encodeClientMessage({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "client" }),
			);
			input.write(
				encodeClientMessage({
					type: "request",
					id: "project-1",
					request: { command: "list_project_sessions", cwd: "/project" },
				}),
			);
			input.write(
				encodeClientMessage({
					type: "request",
					id: "read",
					request: { command: "get_operation", operationId: "op" },
				}),
			);
			input.write(
				encodeClientMessage({
					type: "request",
					id: "project-2",
					request: { command: "list_project_sessions", cwd: "/project" },
				}),
			);
			input.write(
				encodeClientMessage({
					type: "request",
					id: "after",
					request: { command: "room_project_list", cwd: "/project" },
				}),
			);
			await waitForSignal(firstProjectStarted, "项目会话列表未启动");
			await waitForSignal(secondProjectStarted, "第二个项目会话列表仍在等待第一个列表");
			await waitForSignal(readStarted, "安全读取仍在等待项目会话列表");
			expect(handled).toEqual(expect.arrayContaining(["project-1", "project-2", "read"]));
			expect(handled).not.toContain("after");
			releaseFirstProject();
			releaseSecondProject();
			await waitForSignal(afterStarted, "后续有序请求未等待会话列表批次结束");
		} finally {
			releaseFirstProject();
			releaseSecondProject();
			input.end();
			await running;
			output.destroy();
		}
	});
	it("控制读取优先于第四个项目会话列表并保留一个读槽", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		let releaseProjects!: () => void;
		const projectsGate = new Promise<void>((resolve) => {
			releaseProjects = resolve;
		});
		const signals = new Map<string, () => void>();
		const started = new Map<string, Promise<void>>();
		for (const id of ["project-1", "project-2", "project-3", "project-4", "control", "after"]) {
			started.set(
				id,
				new Promise<void>((resolve) => {
					signals.set(id, resolve);
				}),
			);
		}
		const handled: string[] = [];
		const service = {
			createConnection() {
				return {
					async handle(message: ClientMessage) {
						if (message.type !== "request") return;
						handled.push(message.id);
						signals.get(message.id)?.();
						if (message.id.startsWith("project-")) await projectsGate;
					},
					async close() {},
				};
			},
		} as unknown as WebRuntimeService;
		const running = runRuntimeStream(service, input, output);
		const send = (message: ClientMessage) => input.write(encodeClientMessage(message));
		try {
			send({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "client" });
			for (let index = 1; index <= 4; index++)
				send({
					type: "request",
					id: `project-${index}`,
					request: { command: "list_project_sessions", cwd: `/project-${index}` },
				});
			send({ type: "request", id: "control", request: { command: "get_about" } });
			send({ type: "request", id: "after", request: { command: "room_project_list", cwd: "/project" } });
			for (const id of ["project-1", "project-2", "project-3", "control"])
				await waitForSignal(started.get(id)!, `${id} 未启动`);
			expect(handled).not.toContain("project-4");
			expect(handled).not.toContain("after");
			releaseProjects();
			await waitForSignal(started.get("project-4")!, "第四个项目会话列表未启动");
			await waitForSignal(started.get("after")!, "读批次结束后后续请求未启动");
		} finally {
			releaseProjects();
			input.end();
			await running;
			output.destroy();
		}
	});
	it("历史读取不等待前面的会话打开完成", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		let releaseAcquire: () => void = () => {};
		const acquireGate = new Promise<void>((resolve) => {
			releaseAcquire = resolve;
		});
		let acquireFinished = false;
		let markReadStarted: () => void = () => {};
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const service = {
			createConnection() {
				return {
					async handle(message: ClientMessage) {
						if (message.type !== "request") return;
						if (message.request.command === "acquire_session") {
							await acquireGate;
							acquireFinished = true;
						} else if (message.request.command === "read_transcript") {
							markReadStarted();
						}
					},
					async close() {},
				};
			},
		} as unknown as WebRuntimeService;
		const running = runRuntimeStream(service, input, output);

		input.write(
			encodeClientMessage({
				type: "hello",
				version: RUNTIME_PROTOCOL_VERSION,
				clientInstanceId: "client",
			}),
		);
		input.write(
			encodeClientMessage({
				type: "request",
				id: "acquire",
				request: { command: "acquire_session", sessionPath: "/session.jsonl", clientInstanceId: "client" },
			}),
		);
		input.write(
			encodeClientMessage({
				type: "request",
				id: "transcript",
				request: { command: "read_transcript", sessionPath: "/session.jsonl", limit: 120 },
			}),
		);

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				readStarted,
				new Promise<void>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("历史读取仍在等待会话打开")), 500);
				}),
			]);
			expect(acquireFinished).toBe(false);
		} finally {
			if (timer) clearTimeout(timer);
			releaseAcquire();
			input.end();
			await running;
			output.destroy();
		}
	});
	it("等待会话获取时，同一连接仍能处理快照和另一个会话获取", async () => {
		const input = new PassThrough();
		const output = new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		});
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const handled: string[] = [];
		const service = {
			createConnection() {
				return {
					async handle(message: ClientMessage) {
						if (message.type !== "request") return;
						handled.push(message.id);
						if (message.id === "first") await firstGate;
						if (message.id === "second") await secondGate;
					},
					async close() {},
				};
			},
		} as unknown as WebRuntimeService;
		const running = runRuntimeStream(service, input, output);
		const send = (message: ClientMessage) => input.write(encodeClientMessage(message));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			send({ type: "hello", version: RUNTIME_PROTOCOL_VERSION, clientInstanceId: "client" });
			send({
				type: "request",
				id: "first",
				request: { command: "acquire_session", sessionPath: "/first", clientInstanceId: "client" },
			});
			send({
				type: "request",
				id: "second",
				request: { command: "acquire_session", sessionPath: "/second", clientInstanceId: "client" },
			});
			send({ type: "request", id: "snapshot", request: { command: "get_snapshot" } });
			await Promise.race([
				new Promise<void>((resolve) => {
					const check = () => {
						if (handled.includes("first") && handled.includes("second") && handled.includes("snapshot"))
							resolve();
						else setTimeout(check, 1);
					};
					check();
				}),
				new Promise<void>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("会话获取阻塞了其他请求")), 500);
				}),
			]);
			expect(handled).toEqual(["first", "second", "snapshot"]);
		} finally {
			if (timer) clearTimeout(timer);
			releaseFirst();
			releaseSecond();
			input.end();
			await running;
			output.destroy();
		}
	});
	it("等待 drain 时关闭会结束写入", async () => {
		const stream = slowStream();
		const write = writeBounded(stream, Buffer.from("中文"));
		const assertion = expect(write).rejects.toThrow("关闭");
		stream.destroy();
		await assertion;
	});
	it("超出队列字节上限会结束全部排队写入", async () => {
		const stream = slowStream();
		const send = createBoundedWriter(stream);
		const first = send(Buffer.alloc(MAX_RUNTIME_WRITE_BYTES));
		const second = send(Buffer.from("x"));
		const results = await Promise.allSettled([first, second]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(stream.destroyed).toBe(true);
	});
	it("串行发送保持顺序，另一个连接不受慢消费者影响", async () => {
		const slow = slowStream();
		const slowSend = createBoundedWriter(slow);
		const blocked = slowSend(Buffer.from("blocked"));
		const assertion = expect(blocked).rejects.toThrow("关闭");
		const chunks: string[] = [];
		const fast = new Writable({
			write(chunk, _encoding, done) {
				chunks.push(chunk.toString());
				done();
			},
		});
		const send = createBoundedWriter(fast);
		await Promise.all([send(Buffer.from("一")), send(Buffer.from("二"))]);
		expect(chunks).toEqual(["一", "二"]);
		slow.destroy();
		await assertion;
		fast.destroy();
	});
});
