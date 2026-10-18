import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, link, lstat, open, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	MAX_PROJECT_FILE_CHUNK_BYTES,
	type ProjectDirectoryListing,
	type ProjectFileChunk,
	type ProjectUpload,
	type ServerEvent,
} from "@lystar/code-web-protocol";
import { logRuntimeConnection } from "./connection-log.ts";
import { collectZipEntries, createZipArchive } from "./project-file-archive.ts";
import {
	isInside,
	ProjectFileError,
	projectEntryPath,
	projectMutableEntryPath,
	relativePath,
	validateFileName,
} from "./project-file-paths.ts";
import { ProjectFileWatcher } from "./project-file-watcher.ts";

const UPLOAD_IDLE_MS = 120_000;

type FileEvent = Extract<ServerEvent, { type: "project_files_changed" }>;

interface WatchSubscription {
	cwds: Set<string>;
	send(event: FileEvent): Promise<void>;
}

interface ProjectWatch {
	watcher: ProjectFileWatcher;
	subscribers: Map<string, WatchSubscription>;
}

interface UploadState {
	owner: string;
	handle: FileHandle;
	temporaryPath: string;
	target: string;
	path: string;
	byteLength: number;
	pending: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	signal: AbortSignal;
}

export class ProjectFiles {
	private readonly watchers = new Map<string, ProjectWatch>();
	private readonly uploads = new Map<string, UploadState>();
	private readonly archives = new Set<Promise<{ path: string; entryCount: number }>>();

	async list(cwd: string, input: string): Promise<ProjectDirectoryListing> {
		const directory = await projectEntryPath(cwd, input);
		if (directory.kind !== "directory") throw new ProjectFileError(400, "file_not_directory", "目标不是目录");
		const entries: ProjectDirectoryListing["entries"] = [];
		for (const entry of await readdir(directory.path, { withFileTypes: true })) {
			let path = join(directory.path, entry.name);
			let kind: "directory" | "file";
			if (entry.isDirectory()) kind = "directory";
			else if (entry.isFile()) kind = "file";
			else if (entry.isSymbolicLink()) {
				try {
					path = await realpath(path);
					if (!isInside(directory.root, path)) continue;
					const info = await stat(path);
					if (!info.isDirectory() && !info.isFile()) continue;
					kind = info.isDirectory() ? "directory" : "file";
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
					continue;
				}
			} else continue;
			entries.push({
				name: entry.name,
				path: relativePath(directory.root, path),
				hidden: entry.name.startsWith("."),
				kind,
			});
		}
		entries.sort(
			(left, right) =>
				Number(right.kind === "directory") - Number(left.kind === "directory") ||
				left.name.localeCompare(right.name),
		);
		return {
			path: relativePath(directory.root, directory.path),
			...(directory.path === directory.root
				? {}
				: { parent: relativePath(directory.root, dirname(directory.path)) }),
			home: "",
			entries,
		};
	}

	async rename(cwd: string, path: string, name: string): Promise<{ path: string }> {
		validateFileName(name);
		const source = await projectMutableEntryPath(cwd, path);
		if (basename(source.path) === name) return { path: relativePath(source.root, source.path) };
		const target = resolve(dirname(source.path), name);
		try {
			await lstat(target);
			throw new ProjectFileError(409, "file_name_conflict", "同一目录下已有同名文件或目录");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await rename(source.path, target);
		return { path: relativePath(source.root, target) };
	}

	async delete(cwd: string, paths: readonly string[]): Promise<{ paths: string[] }> {
		const entries = await Promise.all(paths.map((path) => projectMutableEntryPath(cwd, path)));
		const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
		const roots = unique.filter(
			(entry) =>
				!unique.some(
					(candidate) =>
						candidate.path !== entry.path &&
						candidate.kind === "directory" &&
						isInside(candidate.path, entry.path),
				),
		);
		for (const entry of roots) await rm(entry.path, { recursive: entry.kind === "directory", force: false });
		return { paths: roots.map((entry) => relativePath(entry.root, entry.path)) };
	}

	async archive(
		cwd: string,
		paths: readonly string[],
		name: string,
		signal?: AbortSignal,
	): Promise<{ path: string; entryCount: number }> {
		const pending = (async () => {
			if (!name.toLowerCase().endsWith(".zip") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
				throw new ProjectFileError(400, "archive_name_invalid", "ZIP 文件名必须以 .zip 结尾且不能包含路径分隔符");
			}
			const sources = await Promise.all(paths.map((path) => projectEntryPath(cwd, path.trim())));
			const root = sources[0].root;
			const outputPath = resolve(root, name);
			try {
				await stat(outputPath);
				throw new ProjectFileError(409, "archive_name_conflict", "项目根目录下已有同名 ZIP 文件");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const entries = await collectZipEntries(root, sources, signal);
			if (entries.length === 0) throw new ProjectFileError(400, "archive_empty", "选中内容没有可压缩文件");
			await createZipArchive(outputPath, entries, signal);
			return { path: name, entryCount: entries.length };
		})();
		this.archives.add(pending);
		try {
			return await pending;
		} finally {
			this.archives.delete(pending);
		}
	}

	async readChunk(
		cwd: string,
		path: string,
		offset: number,
		limit: number,
		contentVersion?: string,
	): Promise<ProjectFileChunk> {
		const file = await projectEntryPath(cwd, path);
		if (file.kind !== "file") throw new ProjectFileError(400, "file_not_regular", "目标不是普通文件");
		const handle = await open(file.path, "r");
		try {
			const info = await handle.stat();
			const version = createHash("sha256")
				.update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
				.digest("hex");
			if (contentVersion && contentVersion !== version)
				throw new ProjectFileError(409, "project_file_conflict", "文件已被外部修改，请重新下载");
			if (offset > info.size) throw new ProjectFileError(409, "project_file_conflict", "文件大小已变化，请重新下载");
			const bytes = Buffer.allocUnsafe(Math.min(limit, MAX_PROJECT_FILE_CHUNK_BYTES, info.size - offset));
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
			if (bytesRead === 0 && offset < info.size)
				throw new ProjectFileError(409, "project_file_conflict", "文件大小已变化，请重新下载");
			return {
				contentRef: file.path,
				name: basename(file.path),
				contentVersion: version,
				offset,
				nextOffset: offset + bytesRead,
				byteLength: info.size,
				data: bytes.subarray(0, bytesRead).toString("base64"),
				encoding: "base64",
				done: offset + bytesRead >= info.size,
			};
		} finally {
			await handle.close();
		}
	}

	async startUpload(
		owner: string,
		cwd: string,
		path: string,
		name: string,
		signal: AbortSignal,
	): Promise<ProjectUpload> {
		validateFileName(name);
		const directory = await projectEntryPath(cwd, path);
		if (directory.kind !== "directory")
			throw new ProjectFileError(400, "upload_target_not_directory", "上传目标不是目录");
		const target = join(directory.path, name);
		try {
			await lstat(target);
			throw new ProjectFileError(409, "file_name_conflict", "同一目录下已有同名文件或目录");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		signal.throwIfAborted();
		const uploadId = randomUUID();
		const temporaryPath = join(directory.path, `.${name}.${process.pid}.${uploadId}.upload`);
		const handle = await open(temporaryPath, "wx", 0o644);
		if (signal.aborted) {
			await handle.close();
			await unlink(temporaryPath).catch(() => {});
			signal.throwIfAborted();
		}
		const upload: UploadState = {
			owner,
			handle,
			temporaryPath,
			target,
			path: relativePath(directory.root, target),
			byteLength: 0,
			pending: Promise.resolve(),
			signal,
		};
		this.uploads.set(uploadId, upload);
		this.touchUpload(uploadId, upload);
		return { uploadId, path: upload.path, byteLength: 0 };
	}

	private touchUpload(uploadId: string, upload: UploadState): void {
		if (upload.timer) clearTimeout(upload.timer);
		upload.timer = setTimeout(() => {
			void this.cancelUpload(upload.owner, uploadId);
		}, UPLOAD_IDLE_MS);
		upload.timer.unref?.();
	}

	async writeUpload(
		owner: string,
		uploadId: string,
		offset: number,
		data: string,
		done: boolean,
	): Promise<ProjectUpload> {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.owner !== owner) throw new ProjectFileError(404, "upload_not_found", "上传已结束或已中断");
		const pending = upload.pending.then(async () => {
			upload.signal.throwIfAborted();
			if (this.uploads.get(uploadId) !== upload)
				throw new ProjectFileError(404, "upload_not_found", "上传已结束或已中断");
			if (offset !== upload.byteLength)
				throw new ProjectFileError(409, "upload_offset_conflict", "上传分块顺序不一致");
			this.touchUpload(uploadId, upload);
			const bytes = Buffer.from(data, "base64");
			await upload.handle.writeFile(bytes);
			upload.byteLength += bytes.byteLength;
			if (done) {
				await upload.handle.close();
				upload.signal.throwIfAborted();
				if (this.uploads.get(uploadId) !== upload)
					throw new ProjectFileError(404, "upload_not_found", "上传已结束或已中断");
				try {
					await link(upload.temporaryPath, upload.target);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST")
						throw new ProjectFileError(409, "file_name_conflict", "同一目录下已有同名文件或目录");
					throw error;
				}
				this.uploads.delete(uploadId);
				if (upload.timer) clearTimeout(upload.timer);
				await unlink(upload.temporaryPath);
			}
			return { uploadId, path: upload.path, byteLength: upload.byteLength };
		});
		upload.pending = pending.then(
			() => {},
			() => {},
		);
		try {
			return await pending;
		} catch (error) {
			await this.cancelUpload(owner, uploadId);
			throw error;
		}
	}

	async cancelUpload(owner: string, uploadId: string): Promise<{ cancelled: boolean }> {
		const upload = this.uploads.get(uploadId);
		if (!upload || upload.owner !== owner) return { cancelled: false };
		this.uploads.delete(uploadId);
		if (upload.timer) clearTimeout(upload.timer);
		await upload.pending;
		await upload.handle.close().catch(() => {});
		await unlink(upload.temporaryPath).catch(() => {});
		return { cancelled: true };
	}

	async watch(
		owner: string,
		cwd: string,
		send: (event: FileEvent) => Promise<void>,
		signal: AbortSignal,
	): Promise<{ watching: boolean }> {
		const requestedCwd = resolve(cwd);
		for (const watched of this.watchers.values()) {
			if (watched.subscribers.get(owner)?.cwds.has(requestedCwd)) return { watching: true };
		}
		const root = await realpath(requestedCwd);
		signal.throwIfAborted();
		let watched = this.watchers.get(root);
		if (!watched) {
			const subscribers = new Map<string, WatchSubscription>();
			const watcher = new ProjectFileWatcher(root, (paths) => {
				for (const subscriber of subscribers.values()) {
					for (const path of subscriber.cwds)
						void subscriber.send({ type: "project_files_changed", cwd: path, paths }).catch(() => {});
				}
			});
			watched = { watcher, subscribers };
			const current = watched;
			watcher.on("error", (error: Error) => {
				logRuntimeConnection("project_watcher_failed", { cwd: root, error: error.message });
				if (this.watchers.get(root) === current) this.watchers.delete(root);
				watcher.close();
			});
			this.watchers.set(root, watched);
		}
		let subscription = watched.subscribers.get(owner);
		if (!subscription) {
			subscription = { cwds: new Set(), send };
			watched.subscribers.set(owner, subscription);
		}
		subscription.cwds.add(requestedCwd);
		await send({ type: "project_files_changed", cwd: requestedCwd, paths: [""] });
		return { watching: true };
	}

	unwatch(owner: string, cwd?: string): { watching: boolean } {
		for (const [root, watched] of this.watchers) {
			const subscription = watched.subscribers.get(owner);
			if (!subscription) continue;
			if (cwd === undefined) watched.subscribers.delete(owner);
			else {
				subscription.cwds.delete(resolve(cwd));
				if (subscription.cwds.size === 0) watched.subscribers.delete(owner);
			}
			if (watched.subscribers.size === 0) {
				this.watchers.delete(root);
				watched.watcher.close();
			}
		}
		return { watching: false };
	}

	async release(owner: string): Promise<void> {
		this.unwatch(owner);
		await Promise.all(
			[...this.uploads].filter(([, upload]) => upload.owner === owner).map(([id]) => this.cancelUpload(owner, id)),
		);
	}

	async dispose(): Promise<void> {
		for (const watched of this.watchers.values()) watched.watcher.close();
		this.watchers.clear();
		await Promise.all([...this.uploads].map(([id, upload]) => this.cancelUpload(upload.owner, id)));
		await Promise.allSettled(this.archives);
	}
}
