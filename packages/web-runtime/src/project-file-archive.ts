import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, link, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";
import { isInside, ProjectFileError, relativePath } from "./project-file-paths.ts";

interface ZipSourceEntry {
	path: string;
	archivePath: string;
	directory: boolean;
	mode: number;
	modifiedAt: Date;
}

interface ZipCentralEntry extends ZipSourceEntry {
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	localOffset: number;
	method: number;
}

const ZIP_MAX_VALUE = 0xffffffff;
const ZIP_MAX_ENTRIES = 0xffff;

function zipDateTime(date: Date): { date: number; time: number } {
	const year = Math.min(2107, Math.max(1980, date.getFullYear()));
	return {
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
	};
}

async function writeZipBuffer(handle: FileHandle, position: number, value: Buffer): Promise<number> {
	let offset = 0;
	while (offset < value.length) {
		const result = await handle.write(value, offset, value.length - offset, position + offset);
		offset += result.bytesWritten;
	}
	return position + value.length;
}

export async function collectZipEntries(
	root: string,
	selections: ReadonlyArray<{ path: string; kind: "file" | "directory" }>,
	signal?: AbortSignal,
): Promise<ZipSourceEntry[]> {
	const unique = [...new Map(selections.map((entry) => [entry.path, entry])).values()].sort(
		(left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path),
	);
	const roots = unique.filter(
		(entry) =>
			!unique.some(
				(candidate) =>
					candidate.path !== entry.path && candidate.kind === "directory" && isInside(candidate.path, entry.path),
			),
	);
	const result: ZipSourceEntry[] = [];
	const archivePaths = new Set<string>();
	const visitedDirectories = new Set<string>();
	const append = (entry: ZipSourceEntry) => {
		if (archivePaths.has(entry.archivePath)) return;
		if (result.length >= ZIP_MAX_ENTRIES) {
			throw new ProjectFileError(413, "archive_entry_limit", "ZIP 内文件数量超过 65535 个");
		}
		archivePaths.add(entry.archivePath);
		result.push(entry);
	};
	const visit = async (path: string, archivePath: string): Promise<void> => {
		signal?.throwIfAborted();
		const canonicalPath = await realpath(path);
		if (!isInside(root, canonicalPath)) return;
		const info = await stat(canonicalPath);
		const normalizedPath = archivePath.replaceAll("\\", "/").replace(/^\/+/, "");
		if (info.isDirectory()) {
			const directoryPath = normalizedPath.endsWith("/") ? normalizedPath : `${normalizedPath}/`;
			append({
				path: canonicalPath,
				archivePath: directoryPath,
				directory: true,
				mode: info.mode,
				modifiedAt: info.mtime,
			});
			if (visitedDirectories.has(canonicalPath)) return;
			visitedDirectories.add(canonicalPath);
			const children = await readdir(canonicalPath, { withFileTypes: true });
			children.sort((left, right) => left.name.localeCompare(right.name));
			for (const child of children) {
				const childCandidate = resolve(canonicalPath, child.name);
				let childPath: string;
				try {
					childPath = await realpath(childCandidate);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
					continue;
				}
				if (!isInside(root, childPath)) continue;
				await visit(childPath, normalizedPath ? `${normalizedPath}/${child.name}` : child.name);
			}
			return;
		}
		if (!info.isFile()) return;
		append({
			path: canonicalPath,
			archivePath: normalizedPath,
			directory: false,
			mode: info.mode,
			modifiedAt: info.mtime,
		});
	};
	for (const selection of roots) await visit(selection.path, relativePath(root, selection.path));
	return result;
}

export async function createZipArchive(
	outputPath: string,
	entries: readonly ZipSourceEntry[],
	signal?: AbortSignal,
): Promise<void> {
	const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(temporaryPath, "wx", 0o600);
		let position = 0;
		const centralEntries: ZipCentralEntry[] = [];
		for (const entry of entries) {
			signal?.throwIfAborted();
			const name = Buffer.from(entry.archivePath, "utf8");
			if (name.length > ZIP_MAX_ENTRIES) throw new ProjectFileError(413, "archive_path_too_long", "ZIP 内路径过长");
			if (position > ZIP_MAX_VALUE) throw new ProjectFileError(413, "archive_too_large", "ZIP 文件超过 4 GiB 上限");
			const timestamp = zipDateTime(entry.modifiedAt);
			const localOffset = position;
			const method = entry.directory ? 0 : 8;
			const flags = entry.directory ? 0x0800 : 0x0808;
			const localHeader = Buffer.alloc(30);
			localHeader.writeUInt32LE(0x04034b50, 0);
			localHeader.writeUInt16LE(20, 4);
			localHeader.writeUInt16LE(flags, 6);
			localHeader.writeUInt16LE(method, 8);
			localHeader.writeUInt16LE(timestamp.time, 10);
			localHeader.writeUInt16LE(timestamp.date, 12);
			localHeader.writeUInt16LE(name.length, 26);
			position = await writeZipBuffer(handle, position, localHeader);
			position = await writeZipBuffer(handle, position, name);

			let checksum = 0;
			let compressedSize = 0;
			let uncompressedSize = 0;
			if (!entry.directory) {
				const checksumStream = new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						uncompressedSize += data.length;
						checksum = crc32(data, checksum) >>> 0;
						if (uncompressedSize > ZIP_MAX_VALUE) {
							callback(new ProjectFileError(413, "archive_entry_too_large", "ZIP 内单个文件超过 4 GiB 上限"));
							return;
						}
						callback(null, data);
					},
				});
				const output = new Writable({
					write(chunk: Buffer, _encoding, callback) {
						const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						void writeZipBuffer(handle!, position, data)
							.then((nextPosition) => {
								position = nextPosition;
								compressedSize += data.length;
								if (compressedSize > ZIP_MAX_VALUE || position > ZIP_MAX_VALUE) {
									callback(new ProjectFileError(413, "archive_too_large", "ZIP 文件超过 4 GiB 上限"));
									return;
								}
								callback();
							})
							.catch((error) => callback(error as Error));
					},
				});
				await pipeline(createReadStream(entry.path), checksumStream, createDeflateRaw(), output, { signal });
				const descriptor = Buffer.alloc(16);
				descriptor.writeUInt32LE(0x08074b50, 0);
				descriptor.writeUInt32LE(checksum, 4);
				descriptor.writeUInt32LE(compressedSize, 8);
				descriptor.writeUInt32LE(uncompressedSize, 12);
				position = await writeZipBuffer(handle, position, descriptor);
			}
			centralEntries.push({ ...entry, crc: checksum, compressedSize, uncompressedSize, localOffset, method });
		}

		const centralOffset = position;
		for (const entry of centralEntries) {
			const name = Buffer.from(entry.archivePath, "utf8");
			const timestamp = zipDateTime(entry.modifiedAt);
			const header = Buffer.alloc(46);
			header.writeUInt32LE(0x02014b50, 0);
			header.writeUInt16LE(0x0314, 4);
			header.writeUInt16LE(20, 6);
			header.writeUInt16LE(entry.directory ? 0x0800 : 0x0808, 8);
			header.writeUInt16LE(entry.method, 10);
			header.writeUInt16LE(timestamp.time, 12);
			header.writeUInt16LE(timestamp.date, 14);
			header.writeUInt32LE(entry.crc, 16);
			header.writeUInt32LE(entry.compressedSize, 20);
			header.writeUInt32LE(entry.uncompressedSize, 24);
			header.writeUInt16LE(name.length, 28);
			header.writeUInt32LE((((entry.mode & 0xffff) << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38);
			header.writeUInt32LE(entry.localOffset, 42);
			position = await writeZipBuffer(handle, position, header);
			position = await writeZipBuffer(handle, position, name);
		}
		const centralSize = position - centralOffset;
		if (centralOffset > ZIP_MAX_VALUE || centralSize > ZIP_MAX_VALUE) {
			throw new ProjectFileError(413, "archive_too_large", "ZIP 文件超过 4 GiB 上限");
		}
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(centralEntries.length, 8);
		end.writeUInt16LE(centralEntries.length, 10);
		end.writeUInt32LE(centralSize, 12);
		end.writeUInt32LE(centralOffset, 16);
		await writeZipBuffer(handle, position, end);
		await handle.sync();
		await handle.close();
		handle = undefined;
		try {
			signal?.throwIfAborted();
			await link(temporaryPath, outputPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new ProjectFileError(409, "archive_name_conflict", "项目根目录下已有同名 ZIP 文件");
			}
			throw error;
		}
	} finally {
		await handle?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
	}
}
