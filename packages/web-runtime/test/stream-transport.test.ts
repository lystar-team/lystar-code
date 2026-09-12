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

describe("Runtime 发送生命周期", () => {
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
