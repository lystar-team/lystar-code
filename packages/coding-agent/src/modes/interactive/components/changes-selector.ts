import {
	type Component,
	type Focusable,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { parseMouseEvent, WheelScrollNormalizer } from "../mouse.ts";
import { theme } from "../theme/theme.ts";
import { uiGlyphs } from "../ui-glyphs.ts";
import { keyText } from "./keybinding-hints.ts";
import type { TurnFileSummary } from "./turn-summary.ts";

export interface WorkspaceChangeFile {
	path: string;
	status: string;
	additions?: number;
	deletions?: number;
	diff?: string;
}

export interface ChangesSelectorData {
	turnFiles: TurnFileSummary[];
	workspaceFiles: WorkspaceChangeFile[];
	gitAvailable: boolean;
	loadWorkspaceDiff?: (path: string) => Promise<string | undefined>;
}

type ChangesScope = "turn" | "workspace";

function renderDiffLine(line: string): string {
	if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
	if (line.startsWith("@@")) return theme.fg("accent", line);
	return theme.fg("toolDiffContext", line);
}

function countLabel(file: TurnFileSummary | WorkspaceChangeFile): string {
	if (file.additions === undefined && file.deletions === undefined) return "";
	return `+${file.additions ?? 0}/-${file.deletions ?? 0}`;
}

export class ChangesSelectorComponent implements Component, Focusable {
	private _focused = false;
	private scope: ChangesScope;
	private selectedIndex = 0;
	private diffScrollTop = 0;
	private fullDiff = false;
	private lastListStart = 0;
	private lastListCount = 0;
	private lastFileStartIndex = 0;
	private loadingPath: string | undefined;
	private readonly loadedWorkspaceDiffs = new Set<string>();
	private readonly wheelScroll = new WheelScrollNormalizer();
	private readonly data: ChangesSelectorData;
	private readonly getHeight: () => number;
	private readonly requestRender: () => void;
	private readonly onCancel: () => void;
	private readonly overlayTop: number;

	constructor(options: {
		data: ChangesSelectorData;
		getHeight: () => number;
		requestRender: () => void;
		onCancel: () => void;
		overlayTop?: number;
	}) {
		this.data = options.data;
		this.getHeight = options.getHeight;
		this.requestRender = options.requestRender;
		this.onCancel = options.onCancel;
		this.overlayTop = options.overlayTop ?? 1;
		this.scope = this.data.turnFiles.length > 0 || !this.data.gitAvailable ? "turn" : "workspace";
		void this.ensureSelectedDiff();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {}

	private get files(): Array<TurnFileSummary | WorkspaceChangeFile> {
		return this.scope === "turn" ? this.data.turnFiles : this.data.workspaceFiles;
	}

	private get selectedFile(): TurnFileSummary | WorkspaceChangeFile | undefined {
		return this.files[this.selectedIndex];
	}

	private setScope(scope: ChangesScope): void {
		if (scope === "workspace" && !this.data.gitAvailable) return;
		this.scope = scope;
		this.selectedIndex = 0;
		this.diffScrollTop = 0;
		this.fullDiff = false;
		void this.ensureSelectedDiff();
	}

	private async ensureSelectedDiff(): Promise<void> {
		if (this.scope !== "workspace") return;
		const selected = this.selectedFile as WorkspaceChangeFile | undefined;
		if (!selected || selected.diff !== undefined || this.loadedWorkspaceDiffs.has(selected.path)) return;
		this.loadingPath = selected.path;
		this.requestRender();
		try {
			selected.diff = await this.data.loadWorkspaceDiff?.(selected.path);
			this.loadedWorkspaceDiffs.add(selected.path);
		} finally {
			if (this.loadingPath === selected.path) this.loadingPath = undefined;
			this.requestRender();
		}
	}

	render(width: number): string[] {
		const height = Math.max(4, this.getHeight() - 2);
		const files = this.files;
		const selected = this.selectedFile;
		const title = theme.bold(theme.fg("accent", "变更审阅"));
		const counts = theme.fg(
			"muted",
			`本轮触及 ${this.data.turnFiles.length} · 工作区全部 ${this.data.gitAvailable ? this.data.workspaceFiles.length : "--"}`,
		);
		const titleGap = Math.max(1, width - visibleWidth(title) - visibleWidth(counts));
		const lines = [truncateToWidth(`${title}${" ".repeat(titleGap)}${counts}`, width, "")];
		const scopeLine =
			`${this.scope === "turn" ? theme.bold(theme.fg("accent", "本轮触及")) : theme.fg("muted", "本轮触及")}` +
			`${theme.fg("dim", "  |  ")}` +
			`${this.scope === "workspace" ? theme.bold(theme.fg("accent", "工作区全部")) : theme.fg("muted", "工作区全部")}`;
		lines.push(truncateToWidth(scopeLine, width, ""));

		if (!this.fullDiff) {
			const maxList = Math.max(1, Math.min(7, Math.floor((height - 5) / 2), files.length || 1));
			const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxList / 2), files.length - maxList));
			const visibleFiles = files.slice(start, start + maxList);
			this.lastListStart = lines.length;
			this.lastListCount = visibleFiles.length;
			this.lastFileStartIndex = start;
			if (visibleFiles.length === 0) {
				lines.push(theme.fg("muted", this.scope === "turn" ? "  本轮没有文件修改" : "  工作区没有未提交变更"));
			} else {
				for (let offset = 0; offset < visibleFiles.length; offset++) {
					const file = visibleFiles[offset]!;
					const index = start + offset;
					const selectedMark = index === this.selectedIndex ? theme.fg("accent", uiGlyphs.prompt) : " ";
					const status = "status" in file ? `${file.status} ` : "";
					const count = countLabel(file);
					const suffix = count ? theme.fg("muted", count) : "";
					const prefix = `${selectedMark} ${theme.fg("muted", status)}`;
					const pathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix) - (suffix ? 2 : 0));
					lines.push(
						`${prefix}${truncateToWidth(theme.fg("text", file.path), pathWidth, "…")}${suffix ? `  ${suffix}` : ""}`,
					);
				}
			}
			lines.push(theme.fg("dim", "─".repeat(Math.max(1, width))));
		}

		const diffLines =
			this.loadingPath !== undefined && this.loadingPath === selected?.path
				? [theme.fg("muted", "正在读取 Diff...")]
				: selected?.diff
					? selected.diff.split("\n").map(renderDiffLine)
					: [theme.fg("muted", selected ? "这个文件没有可显示的结构化 Diff。" : "没有可审阅的文件。")];
		const reserved = lines.length + 2;
		const diffHeight = Math.max(1, height - reserved);
		const maxScroll = Math.max(0, diffLines.length - diffHeight);
		this.diffScrollTop = Math.min(this.diffScrollTop, maxScroll);
		for (const line of diffLines.slice(this.diffScrollTop, this.diffScrollTop + diffHeight)) {
			lines.push(truncateToWidth(line, width, "", true));
		}
		while (lines.length < height - 1) lines.push("");
		const mode = this.fullDiff ? "Enter 返回列表" : "Enter 查看完整 Diff";
		const hint = `${mode} · ${keyText("tui.select.up")}/${keyText("tui.select.down")} 选择 · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} 滚动 · Tab 切换范围 · ${keyText("tui.select.cancel")} 返回`;
		lines.push(truncateToWidth(theme.fg("dim", hint), width, "…"));
		return lines.slice(0, height);
	}

	handleInput(data: string): void {
		const mouse = parseMouseEvent(data);
		if (mouse) {
			if (mouse.shift) return;
			if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
				this.diffScrollTop = Math.max(
					0,
					this.diffScrollTop + this.wheelScroll.getDelta(mouse.button === "wheel-up" ? -1 : 1),
				);
			} else if (mouse.button === "left" && !mouse.released && !this.fullDiff) {
				const localRow = mouse.row - this.overlayTop;
				const offset = localRow - this.lastListStart;
				if (offset >= 0 && offset < this.lastListCount) {
					this.selectedIndex = this.lastFileStartIndex + offset;
					this.diffScrollTop = 0;
					void this.ensureSelectedDiff();
				}
			}
			this.requestRender();
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			this.setScope(this.scope === "turn" ? "workspace" : "turn");
		} else if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.tools.expand")) {
			this.fullDiff = !this.fullDiff;
			this.diffScrollTop = 0;
		} else if (kb.matches(data, "tui.select.up") && !this.fullDiff && this.files.length > 0) {
			this.selectedIndex = this.selectedIndex === 0 ? this.files.length - 1 : this.selectedIndex - 1;
			this.diffScrollTop = 0;
			void this.ensureSelectedDiff();
		} else if (kb.matches(data, "tui.select.down") && !this.fullDiff && this.files.length > 0) {
			this.selectedIndex = this.selectedIndex === this.files.length - 1 ? 0 : this.selectedIndex + 1;
			this.diffScrollTop = 0;
			void this.ensureSelectedDiff();
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.diffScrollTop = Math.max(0, this.diffScrollTop - Math.max(1, this.getHeight() - 8));
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.diffScrollTop += Math.max(1, this.getHeight() - 8);
		} else if (matchesKey(data, "ctrl+c")) {
			this.onCancel();
			return;
		}
		this.requestRender();
	}
}
