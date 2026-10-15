import { EventEmitter } from "node:events";
import { type Dirent, type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

interface WatchedDirectory {
	path: string;
	watcher: FSWatcher;
	children: Set<WatchedDirectory>;
	parent?: WatchedDirectory;
	timer?: ReturnType<typeof setTimeout>;
	scanning?: Promise<void>;
	dirty: boolean;
	closed: boolean;
}

// 只为目录创建原生监听器，避免 Node 递归监听在主线程为每个文件维护和清理监听树。
export class ProjectFileWatcher extends EventEmitter {
	readonly ready: Promise<void>;
	private readonly root: string;
	private readonly rootDirectory: WatchedDirectory;
	private readonly onChange: (eventType: string, filename: string) => void;
	private closed = false;

	constructor(root: string, onChange: (eventType: string, filename: string) => void) {
		super();
		this.root = root;
		this.onChange = onChange;
		this.rootDirectory = this.watchDirectory(root);
		this.ready = this.scan(this.rootDirectory);
		void this.ready.then(
			() => {
				if (!this.closed) this.onChange("rename", "");
			},
			(error: unknown) => this.emit("error", error),
		);
	}

	private watchDirectory(path: string, parent?: WatchedDirectory): WatchedDirectory {
		const watcher = watch(path, { persistent: false }, (eventType, filename) => {
			if (directory.closed || this.closed) return;
			const changed = filename ? join(path, String(filename)) : path;
			const displayPath = relative(this.root, changed).split(sep).join("/");
			if (displayPath === ".git/objects" || displayPath.startsWith(".git/objects/")) return;
			this.onChange(eventType, displayPath);
			if (eventType !== "rename") return;
			// 同路径删除后重建时，旧监听器仍指向旧 inode，需要重新绑定该子目录。
			for (const child of directory.children) {
				if (child.path === changed) this.closeDirectory(child);
			}
			if (directory.timer) clearTimeout(directory.timer);
			directory.timer = setTimeout(() => {
				directory.timer = undefined;
				void this.scan(directory).catch((error: unknown) => this.emit("error", error));
			}, 25);
			directory.timer.unref?.();
		});
		const directory: WatchedDirectory = { path, watcher, children: new Set(), parent, dirty: false, closed: false };
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
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				this.closeDirectory(directory);
				return;
			}
			if (directory.closed || this.closed) return;
			const childPaths = new Set(
				entries.filter((entry) => entry.isDirectory()).map((entry) => join(directory.path, entry.name)),
			);
			for (const child of directory.children) {
				if (childPaths.delete(child.path)) continue;
				this.closeDirectory(child);
			}
			for (const path of childPaths) {
				if (directory.closed || this.closed) return;
				if (relative(this.root, path).split(sep).join("/") === ".git/objects") continue;
				let child: WatchedDirectory;
				try {
					child = this.watchDirectory(path, directory);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				directory.children.add(child);
				await this.scan(child);
			}
		}
	}

	private closeDirectory(directory: WatchedDirectory): void {
		if (directory.closed) return;
		directory.closed = true;
		if (directory.timer) clearTimeout(directory.timer);
		for (const child of directory.children) this.closeDirectory(child);
		directory.children.clear();
		directory.parent?.children.delete(directory);
		directory.watcher.close();
	}

	close(): void {
		this.closed = true;
		this.closeDirectory(this.rootDirectory);
	}
}
