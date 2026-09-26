import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError, WebApi } from "../src/adapters/host-protocol/api.ts";

class UploadRequest {
	static requests: UploadRequest[] = [];
	readonly upload: {
		onprogress?: (event: { lengthComputable: boolean; loaded: number }) => void;
		onload?: () => void;
	} = {};
	onerror?: () => void;
	onabort?: () => void;
	onload?: () => void;
	status = 0;
	responseText = "";
	url = "";
	headers = new Map<string, string>();
	body?: File;

	constructor() {
		UploadRequest.requests.push(this);
	}
	open(_method: string, url: string) {
		this.url = url;
	}
	setRequestHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}
	send(body: File) {
		this.body = body;
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	UploadRequest.requests.length = 0;
});

describe("prompt attachment upload", () => {
	it("reports transferred bytes and waits for server acceptance", async () => {
		const storage = new Map<string, string>();
		storage.set("lystar.web.token", "test-token");
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		});
		vi.stubGlobal("XMLHttpRequest", UploadRequest);
		const file = new File(["large-file"], "large.txt", { type: "text/plain" });
		const progress = vi.fn();
		const settled = vi.fn();
		const result = new WebApi().uploadFile(file, progress).then(settled);
		const request = UploadRequest.requests[0];
		expect(request?.url).toBe("/api/uploads/file");
		expect(request?.body).toBe(file);
		expect(request?.headers.get("authorization")).toBe("Bearer test-token");
		request?.upload.onprogress?.({ lengthComputable: true, loaded: 4 });
		request?.upload.onload?.();
		expect(progress.mock.calls).toEqual([
			[4, false],
			[file.size, true],
		]);
		expect(settled).not.toHaveBeenCalled();
		if (!request) throw new Error("缺少上传请求");
		request.status = 201;
		request.responseText = JSON.stringify({ path: "/tmp/file", mimeType: "text/plain", byteLength: file.size });
		request.onload?.();
		await result;
		expect(settled).toHaveBeenCalledWith({ path: "/tmp/file", mimeType: "text/plain", byteLength: file.size });
	});

	it("reports server errors and unauthorized responses", async () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		});
		vi.stubGlobal("XMLHttpRequest", UploadRequest);
		const file = new File(["large-file"], "large.txt");
		const rejected = new WebApi().uploadFile(file, vi.fn());
		const first = UploadRequest.requests[0];
		if (!first) throw new Error("缺少上传请求");
		first.status = 413;
		first.responseText = JSON.stringify({ error: { message: "单个文件不能超过 1 GB" } });
		first.onload?.();
		await expect(rejected).rejects.toThrow("单个文件不能超过 1 GB");

		const unauthorized = new WebApi().uploadFile(file, vi.fn());
		const second = UploadRequest.requests[1];
		if (!second) throw new Error("缺少上传请求");
		second.status = 401;
		second.onload?.();
		await expect(unauthorized).rejects.toBeInstanceOf(UnauthorizedError);
	});
});
