import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	MAX_PROJECT_FILE_CHUNK_BYTES,
	type ProjectFileChunk,
	type ProjectUpload,
	type RuntimeProtocolClient,
} from "@lystar/code-web-protocol";

export async function uploadProjectFile(
	client: RuntimeProtocolClient,
	request: IncomingMessage,
	cwd: string,
	path: string,
	name: string,
): Promise<{ path: string; byteLength: number }> {
	let upload = await client.request<ProjectUpload>({ command: "start_project_upload", cwd, path, name });
	try {
		await pipeline(
			request,
			new Writable({
				highWaterMark: MAX_PROJECT_FILE_CHUNK_BYTES,
				write(chunk: Buffer, _encoding, callback) {
					void (async () => {
						for (let offset = 0; offset < chunk.length; offset += MAX_PROJECT_FILE_CHUNK_BYTES) {
							upload = await client.request<ProjectUpload>({
								command: "write_project_upload",
								uploadId: upload.uploadId,
								offset: upload.byteLength,
								data: chunk.subarray(offset, offset + MAX_PROJECT_FILE_CHUNK_BYTES).toString("base64"),
								done: false,
							});
						}
					})().then(
						() => callback(),
						(error: Error) => callback(error),
					);
				},
				final(callback) {
					void client
						.request<ProjectUpload>({
							command: "write_project_upload",
							uploadId: upload.uploadId,
							offset: upload.byteLength,
							data: "",
							done: true,
						})
						.then(
							(result) => {
								upload = result;
								callback();
							},
							(error: Error) => callback(error),
						);
				},
			}),
		);
		return { path: upload.path, byteLength: upload.byteLength };
	} catch (error) {
		await client.request({ command: "cancel_project_upload", uploadId: upload.uploadId }).catch(() => {});
		throw error;
	}
}

export async function downloadProjectFile(
	client: RuntimeProtocolClient,
	response: ServerResponse,
	cwd: string,
	path: string,
): Promise<void> {
	let chunk = await client.request<ProjectFileChunk>({
		command: "read_project_file_chunk",
		cwd,
		path,
		offset: 0,
		limit: MAX_PROJECT_FILE_CHUNK_BYTES,
	});
	const byteLength = chunk.byteLength;
	const contentVersion = chunk.contentVersion;
	const filename = encodeURIComponent(chunk.name).replace(
		/[!'()*]/gu,
		(value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	const source = Readable.from(
		(async function* () {
			let offset = 0;
			while (!response.destroyed) {
				const bytes = Buffer.from(chunk.data, "base64");
				if (
					chunk.offset !== offset ||
					chunk.nextOffset !== offset + bytes.length ||
					bytes.length > MAX_PROJECT_FILE_CHUNK_BYTES ||
					chunk.byteLength !== byteLength ||
					chunk.contentVersion !== contentVersion ||
					chunk.nextOffset > byteLength ||
					chunk.done !== (chunk.nextOffset === byteLength) ||
					(!chunk.done && bytes.length === 0)
				) {
					throw new Error("后台返回了无效的文件分块");
				}
				if (bytes.length > 0) yield bytes;
				if (chunk.done || response.destroyed) return;
				offset = chunk.nextOffset;
				chunk = await client.request<ProjectFileChunk>({
					command: "read_project_file_chunk",
					cwd,
					path,
					offset,
					limit: MAX_PROJECT_FILE_CHUNK_BYTES,
					contentVersion,
				});
			}
		})(),
		{ objectMode: false, highWaterMark: MAX_PROJECT_FILE_CHUNK_BYTES },
	);
	response.writeHead(200, {
		"Cache-Control": "no-store",
		"Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
		"Content-Length": String(byteLength),
		"Content-Type": "application/octet-stream",
	});
	try {
		await pipeline(source, response);
	} catch (error) {
		response.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}
