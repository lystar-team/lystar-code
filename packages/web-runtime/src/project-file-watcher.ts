import { EventEmitter } from "node:events";
import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const CHANGE_DEBOUNCE_MS = 150;
const CHANGE_MAX_WAIT_MS = 1000;
const MAX_CHANGE_PATHS = 256;
const RESCAN_DELAY_MS = 25;
// 每个目录占用一个原生监听器；依赖目录不参与刷新，避免监听树随 node_modules 线性增长。
const IGNORED_DIRECTORY_NAMES = new Set([
	"node_modules",
	"bower_components",
	".pnpm-store",
	".yarn",
	".venv",
	"venv",
	"__pycache__",
	".gradle",
	".tox",
]);
// 单项目监听目录上限。触顶后停止新增监听并报告一次，避免主线程被监听器创建和关闭拖死。
const MAX_WATCHED_DIRECTORIES = 10_000;
// 关闭原生监听器仍会占用主线程；分片关闭把单次阻塞控制在有限范围。
const CLOSE_BATCH_SIZE = 50;

interface WatchedDirectory {
	path: string;
	prefix: string;
	gitMetadata: boolean;
	watcher: FSWatcher;
	children: Set<WatchedDirectory>;
	parent?: WatchedDirectory;
	timer?: ReturnType<typeof setTimeout>;
	scanning?: Promise<void>;
	dirty: boolean;
	closed: boolean;
}

interface GitMetadataWatch {
	gitdir: string;
	commonDir: string;
	directories: WatchedDirectory[];
}

export interface ProjectFileWatcherStats {
	directories: number;
	ignoredDirectories: number;
	limited: boolean;
}

export type ProjectFileWatcherDiagnostic = (event: string, fields: Record<string, unknown>) => void;

function missingPath(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

// 只为目录创建原生监听器，避免递归监听为每个文件维护和清理监听树。
export class ProjectFileWatcher extends EventEmitter {
	readonly ready: Promise<void>;
	private readonly root: string;
	private readonly onChange: (paths: string[]) => void;
	private readonly onDiagnostic?: ProjectFileWatcherDiagnostic;
	private rootDirectory?: WatchedDirectory;
	private rootIdentity?: string;
	private readonly parentWatcher?: FSWatcher;
	private rootTimer?: ReturnType<typeof setTimeout>;
	private rootScanning?: Promise<void>;
	private rootDirty = false;
	private readonly gitMetadata = new Map<string, GitMetadataWatch>();
	private readonly paths = new Set<string>();
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private maxWaitTimer?: ReturnType<typeof setTimeout>;
	private directoryCount = 0;
	private ignoredDirectories = 0;
	private limited = false;
	private closeQueue: WatchedDirectory[] = [];
	private closeScheduled = false;
	private closed = false;

	constructor(root: string, onChange: (paths: string[]) => void, onDiagnostic?: ProjectFileWatcherDiagnostic) {
		super();
		this.root = resolve(root);
		this.onChange = onChange;
		this.onDiagnostic = onDiagnostic;
		if (dirname(this.root) !== this.root) {
			this.parentWatcher = watch(dirname(this.root), { persistent: false }, (_eventType, filename) => {
				if (!filename || String(filename) === basename(this.root)) this.scheduleRootScan();
			});
			this.parentWatcher.on("error", (error) => {
				if (!this.closed) this.emit("error", error);
			});
		}
		this.ready = this.scanRoot();
		void this.ready.then(
			() => this.queueChange(""),
			(error: unknown) => {
				if (!this.closed) this.emit("error", error);
			},
		);
	}

	stats(): ProjectFileWatcherStats {
		return {
			directories: this.directoryCount,
			ignoredDirectories: this.ignoredDirectories,
			limited: this.limited,
		};
	}

	private queueChange(path: string): void {
		if (this.closed) return;
		if (!this.paths.has("")) {
			if (!path || (!this.paths.has(path) && this.paths.size >= MAX_CHANGE_PATHS)) {
				this.paths.clear();
				this.paths.add("");
			} else this.paths.add(path);
		}
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => this.flush(), CHANGE_DEBOUNCE_MS);
		this.debounceTimer.unref?.();
		if (!this.maxWaitTimer) {
			this.maxWaitTimer = setTimeout(() => this.flush(), CHANGE_MAX_WAIT_MS);
			this.maxWaitTimer.unref?.();
		}
	}

	private flush(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
		this.debounceTimer = undefined;
		this.maxWaitTimer = undefined;
		if (this.closed || this.paths.size === 0) return;
		const paths = [...this.paths];
		this.paths.clear();
		this.onChange(paths);
	}

	private scheduleRootScan(): void {
		if (this.closed || this.rootTimer) return;
		this.rootTimer = setTimeout(() => {
			this.rootTimer = undefined;
			void this.scanRoot().catch((error: unknown) => this.emit("error", error));
		}, RESCAN_DELAY_MS);
		this.rootTimer.unref?.();
	}

	private scanRoot(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.rootDirty = true;
		if (this.rootScanning) return this.rootScanning;
		const pending = this.reconcileRoot().finally(() => {
			if (this.rootScanning === pending) this.rootScanning = undefined;
		});
		this.rootScanning = pending;
		return pending;
	}

	private async reconcileRoot(): Promise<void> {
		while (this.rootDirty && !this.closed) {
			this.rootDirty = false;
			let identity: string | undefined;
			try {
				const info = await stat(this.root);
				if (info.isDirectory()) identity = `${info.dev}:${info.ino}`;
			} catch (error) {
				if (!missingPath(error)) throw error;
			}
			if (this.closed) return;
			if (identity === this.rootIdentity && !this.rootDirectory?.closed) continue;
			if (this.rootDirectory) this.retireDirectory(this.rootDirectory);
			this.rootDirectory = undefined;
			this.rootIdentity = undefined;
			this.closeGitMetadata();
			this.queueChange("");
			if (!identity) continue;
			try {
				this.rootDirectory = this.watchDirectory(this.root, "", false);
				this.rootIdentity = identity;
				await this.scan(this.rootDirectory);
			} catch (error) {
				if (!missingPath(error)) throw error;
				this.rootDirty = true;
			}
		}
	}

	private watchDirectory(
		path: string,
		prefix: string,
		gitMetadata: boolean,
		parent?: WatchedDirectory,
	): WatchedDirectory {
		const watcher = watch(path, { persistent: false }, (eventType, filename) => {
			if (directory.closed || this.closed) return;
			const name = filename ? String(filename) : "";
			if (gitMetadata && !parent?.gitMetadata && name === "objects") return;
			const changed = name ? join(path, name) : path;
			this.queueChange(gitMetadata ? prefix : [prefix, name].filter(Boolean).join("/"));
			if (eventType !== "rename" && (gitMetadata || name !== ".git")) return;
			if (directory === this.rootDirectory) this.scheduleRootScan();
			for (const child of directory.children) {
				if (!name || child.path === changed) this.retireDirectory(child);
			}
			if (!directory.timer) {
				directory.timer = setTimeout(() => {
					directory.timer = undefined;
					void this.scan(directory).catch((error: unknown) => {
						if (!this.closed) this.emit("error", error);
					});
				}, RESCAN_DELAY_MS);
				directory.timer.unref?.();
			}
		});
		const directory: WatchedDirectory = {
			path,
			prefix,
			gitMetadata,
			watcher,
			children: new Set(),
			parent,
			dirty: false,
			closed: false,
		};
		this.directoryCount += 1;
		watcher.on("error", (error) => {
			if (!directory.closed && !this.closed) this.emit("error", error);
		});
		return directory;
	}

	private scan(directory: WatchedDirectory): Promise<void> {
		if (directory.closed || this.closed) return Promise.resolve();
		directory.dirty = true;
		if (directory.scanning) return directory.scanning;
		const pending = this.reconcile(directory).finally(() => {
			if (directory.scanning === pending) directory.scanning = undefined;
		});
		directory.scanning = pending;
		return pending;
	}

	private async reconcile(directory: WatchedDirectory): Promise<void> {
		while (directory.dirty && !directory.closed && !this.closed) {
			directory.dirty = false;
			let entries: Dirent<string>[];
			try {
				entries = await readdir(directory.path, { withFileTypes: true });
			} catch (error) {
				if (!missingPath(error)) throw error;
				this.retireDirectory(directory);
				if (directory === this.rootDirectory) this.scheduleRootScan();
				return;
			}
			if (directory.closed || this.closed) return;
			if (!directory.gitMetadata) await this.syncGitMetadata(directory, entries);
			const childPaths = new Set<string>();
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				// .git/objects 只承载对象写入，不参与工作区刷新。
				if (directory.gitMetadata && entry.name === "objects") continue;
				if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
					this.ignoredDirectories += 1;
					continue;
				}
				childPaths.add(join(directory.path, entry.name));
			}
			for (const child of directory.children) {
				if (childPaths.delete(child.path)) continue;
				this.retireDirectory(child);
			}
			for (const path of childPaths) {
				if (directory.closed || this.closed) return;
				if (this.directoryCount >= MAX_WATCHED_DIRECTORIES) {
					if (!this.limited) {
						this.limited = true;
						this.onDiagnostic?.("project_watcher_limited", {
							root: this.root,
							limit: MAX_WATCHED_DIRECTORIES,
						});
					}
					break;
				}
				const metadata = directory.gitMetadata || basename(path) === ".git";
				const prefix = directory.gitMetadata ? directory.prefix : relative(this.root, path).split(sep).join("/");
				let child: WatchedDirectory;
				try {
					child = this.watchDirectory(path, prefix, metadata, directory);
				} catch (error) {
					if (missingPath(error)) continue;
					throw error;
				}
				directory.children.add(child);
				await this.scan(child);
			}
		}
	}

	private async syncGitMetadata(directory: WatchedDirectory, entries: Dirent<string>[]): Promise<void> {
		const marker = join(directory.path, ".git");
		const previous = this.gitMetadata.get(marker);
		let gitdir: string | undefined;
		let commonDir: string | undefined;
		try {
			if (entries.some((entry) => entry.name === ".git" && entry.isFile())) {
				const pointer = (await readFile(marker, "utf8")).trim();
				if (pointer.startsWith("gitdir:")) {
					gitdir = resolve(directory.path, pointer.slice("gitdir:".length).trim());
					commonDir = gitdir;
					try {
						commonDir = resolve(gitdir, (await readFile(join(gitdir, "commondir"), "utf8")).trim());
					} catch (error) {
						if (!missingPath(error)) throw error;
					}
				}
			}
		} catch (error) {
			if (!missingPath(error)) throw error;
		}
		if (this.closed || directory.closed) return;
		if (previous?.gitdir === gitdir && previous?.commonDir === commonDir) return;
		if (previous) {
			for (const watched of previous.directories) this.retireDirectory(watched);
			this.gitMetadata.delete(marker);
		}
		if (!gitdir || !commonDir) return;
		const state: GitMetadataWatch = { gitdir, commonDir, directories: [] };
		this.gitMetadata.set(marker, state);
		for (const path of new Set([gitdir, commonDir])) {
			if (this.closed || directory.closed) return;
			try {
				const watched = this.watchDirectory(path, [directory.prefix, ".git"].filter(Boolean).join("/"), true);
				state.directories.push(watched);
				await this.scan(watched);
			} catch (error) {
				if (!missingPath(error)) throw error;
			}
		}
		this.queueChange([directory.prefix, ".git"].filter(Boolean).join("/"));
	}

	/** 立即标记为关闭并从树中移除；原生监听器分片释放，不阻塞调用线程。 */
	private retireDirectory(directory: WatchedDirectory): void {
		if (directory.closed) return;
		const pending: WatchedDirectory[] = [directory];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current || current.closed) continue;
			current.closed = true;
			if (current.timer) clearTimeout(current.timer);
			current.parent?.children.delete(current);
			const metadata = this.gitMetadata.get(join(current.path, ".git"));
			if (metadata) {
				this.gitMetadata.delete(join(current.path, ".git"));
				pending.push(...metadata.directories);
			}
			pending.push(...current.children);
			current.children.clear();
			this.directoryCount = Math.max(0, this.directoryCount - 1);
			this.closeQueue.push(current);
		}
		this.scheduleClose();
	}

	private scheduleClose(): void {
		if (this.closeScheduled || this.closeQueue.length === 0) return;
		this.closeScheduled = true;
		const timer = setImmediate(() => {
			this.closeScheduled = false;
			const batch = this.closeQueue.splice(0, CLOSE_BATCH_SIZE);
			for (const directory of batch) {
				try {
					directory.watcher.close();
				} catch {
					// 监听器可能已由运行环境关闭；关闭失败不影响后续释放。
				}
			}
			this.scheduleClose();
		});
		timer.unref?.();
	}

	private closeGitMetadata(): void {
		for (const state of this.gitMetadata.values()) {
			for (const directory of state.directories) this.retireDirectory(directory);
		}
		this.gitMetadata.clear();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.rootTimer) clearTimeout(this.rootTimer);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
		this.rootTimer = undefined;
		this.debounceTimer = undefined;
		this.maxWaitTimer = undefined;
		this.paths.clear();
		this.parentWatcher?.close();
		const roots = [
			this.rootDirectory,
			...[...this.gitMetadata.values()].flatMap((state) => state.directories),
		].filter((directory): directory is WatchedDirectory => Boolean(directory));
		this.rootDirectory = undefined;
		this.gitMetadata.clear();
		for (const root of roots) this.retireDirectory(root);
	}
}
