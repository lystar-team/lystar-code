import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createBoundedWriter, MAX_RUNTIME_WRITE_BYTES, writeBounded } from "../src/stream-transport.ts";

function slowStream() {
	return new Writable({ highWaterMark: 1, write() {} });
}

describe("Runtime 发送生命周期", () => {
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
