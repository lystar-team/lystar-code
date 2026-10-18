import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

// 开发态把每个模块的 sourcemap 直接内联进响应体，整页加载会多传十几 MB。
// 这里把内联 map 改成外链：浏览器只在 DevTools 打开时才按需取 map，正常加载不再传输。
// 同时给 dev 响应加压缩，跨机（内网穿透）访问时体积能再降一个量级。只作用于开发服务器，
// 不参与生产构建，也不改变任何运行行为。
const SOURCE_MAP_MARKER = "//# sourceMappingURL=data:application/json";
const SOURCE_MAP_ENDPOINT = "/@dev-sourcemap";
const OPTIMIZED_DEP_PATH = /(?:^|\/)\.vite[^/]*\/deps\//u;
const COMPRESSIBLE_CONTENT_TYPE = /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml)|image\/svg\+xml)/iu;
const MIN_COMPRESS_BYTES = 1024;
const MAX_SOURCE_MAP_ENTRIES = 2000;
const MAX_SOURCE_MAP_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
// 只接管开发服务器自己生成的模块与文档响应，避开 /api、/ws 代理和静态资源流。
const DELIVERABLE_PATH = /\.(?:m?[jt]sx?|css|map)$/u;
const DELIVERABLE_PREFIX = /^\/@(?:vite|react-refresh)/u;

type BodyBuffer = Buffer<ArrayBufferLike>;
type RawWrite = (chunk?: unknown, encoding?: unknown, callback?: unknown) => boolean;
type RawEnd = (chunk?: unknown, encoding?: unknown, callback?: unknown) => unknown;

const compressedCache = new Map<string, BodyBuffer>();
const sourceMaps = new Map<string, string>();
let compressedBytes = 0;
let sourceMapBytes = 0;

function isDeliverableRequest(url: string, method: string | undefined): boolean {
	if (method !== undefined && method !== "GET" && method !== "HEAD") return false;
	const path = url.split("?")[0]!;
	if (path === "/" || path.endsWith(".html")) return true;
	return DELIVERABLE_PATH.test(path) || DELIVERABLE_PREFIX.test(path);
}

function acceptsEncoding(header: string | undefined, encoding: string): boolean {
	if (!header) return false;
	for (const entry of header.split(",")) {
		const [name, ...parameters] = entry.trim().split(";");
		const token = name?.trim().toLowerCase();
		if (token !== encoding && token !== "*") continue;
		const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
		if (quality && Number.parseFloat(quality.slice(2)) === 0) continue;
		return true;
	}
	return false;
}

function appendVary(response: ServerResponse, value: string): void {
	const current = response.getHeader("vary");
	if (current === undefined) {
		response.setHeader("vary", value);
		return;
	}
	const values = (Array.isArray(current) ? current : [String(current)]).flatMap((entry) => entry.split(","));
	if (!values.some((entry) => entry.trim().toLowerCase() === value)) {
		response.setHeader("vary", `${values.join(", ")}, ${value}`);
	}
}

function toBuffer(chunk: unknown, encoding: unknown): BodyBuffer {
	if (Buffer.isBuffer(chunk)) return chunk;
	return Buffer.from(chunk as string, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined);
}

function externalizeSourceMap(body: BodyBuffer, url: string): BodyBuffer {
	if (!body.includes(SOURCE_MAP_MARKER)) return body;
	const text = body.toString("utf8");
	const marker = text.lastIndexOf(SOURCE_MAP_MARKER);
	if (marker > 0 && text[marker - 1] !== "\n" && text[marker - 1] !== "\r") return body;
	const headerEnd = text.indexOf(",", marker + SOURCE_MAP_MARKER.length);
	if (headerEnd < 0) return body;
	const header = text.slice(marker + SOURCE_MAP_MARKER.length, headerEnd);
	if (!/^(?:;charset=[^;,\r\n]+)?;base64$/u.test(header)) return body;
	// base64 可能达到数十 MB；只对短头部使用正则，避免扫描 payload 时耗尽调用栈。
	const encoded = text.slice(headerEnd + 1).trimEnd();
	if (encoded.includes("\n") || encoded.includes("\r")) return body;
	const path = url.split("?")[0]!;
	let target: string;
	if (OPTIMIZED_DEP_PATH.test(path)) {
		// 依赖预打包目录里已经有一份同名 .map，dev server 会直接提供。
		target = `${path}.map`;
	} else {
		const decoded = Buffer.from(encoded, "base64").toString("utf8");
		sourceMapBytes -= sourceMaps.get(url)?.length ?? 0;
		sourceMaps.set(url, decoded);
		sourceMapBytes += decoded.length;
		while (sourceMaps.size > MAX_SOURCE_MAP_ENTRIES || sourceMapBytes > MAX_SOURCE_MAP_BYTES) {
			const oldest = sourceMaps.entries().next().value!;
			sourceMaps.delete(oldest[0]);
			sourceMapBytes -= oldest[1].length;
		}
		target = `${SOURCE_MAP_ENDPOINT}?url=${encodeURIComponent(url)}`;
	}
	return Buffer.from(`${text.slice(0, marker)}//# sourceMappingURL=${target}\n`, "utf8");
}

function cachedEncoding(key: string | undefined, produce: () => BodyBuffer): BodyBuffer {
	if (key) {
		const hit = compressedCache.get(key);
		if (hit) return hit;
	}
	const value = produce();
	if (key) {
		compressedCache.set(key, value);
		compressedBytes += value.length;
		while (compressedBytes > MAX_COMPRESSED_BYTES) {
			const oldest = compressedCache.entries().next().value!;
			compressedCache.delete(oldest[0]);
			compressedBytes -= oldest[1].length;
		}
	}
	return value;
}

function compress(
	body: BodyBuffer,
	contentType: string,
	request: IncomingMessage,
	cacheKey: string | undefined,
): { body: BodyBuffer; encoding?: string } {
	if (body.length < MIN_COMPRESS_BYTES || !COMPRESSIBLE_CONTENT_TYPE.test(contentType)) return { body };
	const accepted = request.headers["accept-encoding"];
	const encoding = acceptsEncoding(accepted, "br") ? "br" : acceptsEncoding(accepted, "gzip") ? "gzip" : undefined;
	if (!encoding) return { body };
	const key = cacheKey === undefined ? undefined : `${cacheKey}|${encoding}`;
	const compressed = cachedEncoding(key, () =>
		encoding === "br"
			? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
			: gzipSync(body),
	);
	return { body: compressed, encoding };
}

function respondWithSourceMap(request: IncomingMessage, response: ServerResponse): void {
	const query = request.url?.split("?")[1] ?? "";
	const url = new URLSearchParams(query).get("url");
	const map = url ? sourceMaps.get(url) : undefined;
	if (map === undefined) {
		response.statusCode = 404;
		response.end();
		return;
	}
	response.statusCode = 200;
	response.setHeader("content-type", "application/json");
	const compressed = compress(Buffer.from(map, "utf8"), "application/json", request, undefined);
	response.setHeader("content-length", String(compressed.body.length));
	if (compressed.encoding) {
		response.setHeader("content-encoding", compressed.encoding);
		appendVary(response, "accept-encoding");
	}
	if (request.method === "HEAD") response.end();
	else response.end(compressed.body);
}

export function devDelivery(): Plugin {
	return {
		name: "lystar:web-dev-delivery",
		apply: (_config, environment) => environment.command === "serve" && !process.env.VITEST,
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const url = request.url;
				if (!url) return next();
				if (url.split("?")[0] === SOURCE_MAP_ENDPOINT) return respondWithSourceMap(request, response);
				if (!isDeliverableRequest(url, request.method)) return next();

				// 静态文件中间件会先 writeHead 再 pipe，这类响应保持原样转发，只改写 Vite 自己
				// 缓冲输出的模块响应，避免和流式响应争抢响应头。
				const rawWrite = response.write as unknown as RawWrite;
				const rawEnd = response.end as unknown as RawEnd;
				const rawWriteHead = response.writeHead;
				const chunks: BodyBuffer[] = [];
				let committed = false;
				let finished = false;
				response.writeHead = ((...args: unknown[]) => {
					committed = true;
					return (rawWriteHead as (...innerArgs: unknown[]) => ServerResponse).apply(response, args);
				}) as typeof response.writeHead;
				response.write = ((chunk?: unknown, encoding?: unknown) => {
					if (committed) return rawWrite.call(response, chunk, encoding);
					if (chunk !== undefined && chunk !== null && typeof chunk !== "function") chunks.push(toBuffer(chunk, encoding));
					return true;
				}) as typeof response.write;
				response.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
					if (finished) return response;
					finished = true;
					response.writeHead = rawWriteHead;
					response.write = rawWrite as unknown as typeof response.write;
					response.end = rawEnd as unknown as typeof response.end;
					const flush = (endChunk?: BodyBuffer) => {
						for (const buffered of chunks) rawWrite.call(response, buffered);
						chunks.length = 0;
						return rawEnd.call(response, endChunk, undefined, callback);
					};
					if (typeof chunk === "function") callback = chunk;
					else if (typeof encoding === "function") callback = encoding;
					if (committed || response.headersSent) return flush(chunk === undefined || typeof chunk === "function" ? undefined : toBuffer(chunk, encoding));
					if (chunk !== undefined && chunk !== null && typeof chunk !== "function") chunks.push(toBuffer(chunk, encoding));
					let body: BodyBuffer = Buffer.concat(chunks);
					const contentType = String(response.getHeader("content-type") ?? "");
					if (response.statusCode === 200 && body.length > 0) {
						if (contentType.includes("javascript")) body = externalizeSourceMap(body, url);
						if (response.getHeader("content-encoding") === undefined) {
							const etag = response.getHeader("etag");
							const cacheKey = typeof etag === "string" ? `${url}|${etag}` : undefined;
							const compressed = compress(body, contentType, request, cacheKey);
							body = compressed.body;
							if (compressed.encoding) {
								response.setHeader("content-encoding", compressed.encoding);
								appendVary(response, "accept-encoding");
							}
						}
						response.setHeader("content-length", String(body.length));
					}
					return rawEnd.call(response, body, undefined, callback);
				}) as typeof response.end;
				next();
			});
		},
	};
}
