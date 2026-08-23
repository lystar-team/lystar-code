import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LystarWorkspace, WorkspaceHeader } from "../src/modes/interactive/components/lystar-workspace.ts";
import { SessionTranscriptSource } from "../src/modes/interactive/session-transcript-source.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createLongSessionFixture, type LongSessionEntry } from "./fixtures/long-session.ts";

const RENDER_P95_BUDGET_MS = 16;
const TRANSCRIPT_PAGE_P95_BUDGET_MS = 100;
const RENDER_SAMPLES = 128;
const PAGE_SIZE = 80;

const TERMINAL_PROFILES = [
	{ label: "80x8", width: 80, height: 8 },
	{ label: "80x24", width: 80, height: 24 },
	{ label: "120x36", width: 120, height: 36 },
] as const;

class PerformanceTranscriptBlock implements Component {
	readonly id: string;
	private readonly lines: string[];

	constructor(id: string, lineCount: number) {
		this.id = id;
		this.lines = Array.from({ length: lineCount }, (_, index) => `${id} 行 ${index + 1}`);
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}

	getRenderVersion(): number {
		return 0;
	}
}

function textContainer(...lines: string[]): Container {
	const container = new Container();
	for (const line of lines) container.addChild(new Text(line, 0, 0));
	return container;
}

function activeBranchEntries(entries: LongSessionEntry[], leafId: string): LongSessionEntry[] {
	const byId = new Map<string, LongSessionEntry>();
	for (const entry of entries) {
		if (typeof entry.id === "string") byId.set(entry.id, entry);
	}

	const branch: LongSessionEntry[] = [];
	let currentId: string | null = leafId;
	while (currentId) {
		const entry = byId.get(currentId);
		if (!entry) throw new Error(`Missing fixture entry ${currentId}`);
		branch.push(entry);
		currentId = typeof entry.parentId === "string" ? entry.parentId : null;
	}
	branch.reverse();
	return branch;
}

function createTranscriptComponents(): PerformanceTranscriptBlock[] {
	const fixture = createLongSessionFixture();
	return activeBranchEntries(fixture.entries, fixture.activeLeafId)
		.filter((entry) => typeof entry.id === "string")
		.map((entry) => {
			const message = entry.message;
			const lineCount = entry.type === "compaction" ? 3 : message && typeof message === "object" ? 2 : 1;
			return new PerformanceTranscriptBlock(entry.id as string, lineCount);
		});
}

function createWorkspace(
	height: number,
	components: PerformanceTranscriptBlock[],
): { workspace: LystarWorkspace; chat: Container; bottomLines: string[] } {
	const chat = new Container();
	for (const component of components) chat.addChild(component);

	const header = new Container();
	header.addChild(
		new WorkspaceHeader(() => ({
			product: "LYStar Code",
			path: "~/lystar",
			branch: "main",
			task: "长会话性能验证",
			context: "上下文 7.4%  |  9.5K/128K",
			compactContext: "上下文 7.4%",
		})),
	);
	const bottomLines = ["编辑器", "快捷栏"];
	const bottom = textContainer(...bottomLines);
	const workspace = new LystarWorkspace({
		getHeight: () => height,
		header,
		scrollContainers: [chat],
		bottomContainers: [bottom],
		fixedBottomContainers: [bottom],
		fullscreen: true,
		scrollbar: "hidden",
	});

	return { workspace, chat, bottomLines };
}

function percentile(values: number[], percentileValue: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

function measureScrolling(workspace: LystarWorkspace, width: number, height: number, bottomLines: string[]): number[] {
	workspace.render(width);
	workspace.scrollToTop();
	workspace.render(width);

	const durations: number[] = [];
	for (let index = 0; index < RENDER_SAMPLES; index++) {
		workspace.pageDown();
		const startedAt = performance.now();
		const rendered = workspace.render(width);
		const elapsed = performance.now() - startedAt;
		durations.push(elapsed);

		expect(rendered).toHaveLength(height);
		expect(rendered.slice(-bottomLines.length).map((line) => stripAnsi(line).trim())).toEqual(bottomLines);
	}
	return durations;
}

describe("LYStar TUI performance gates", () => {
	beforeAll(() => initTheme("dark"));

	it.each(TERMINAL_PROFILES)("keeps long-session scrolling under the 16ms p95 gate at $label", (profile) => {
		const components = createTranscriptComponents();
		const { workspace, bottomLines } = createWorkspace(profile.height, components);
		const durations = measureScrolling(workspace, profile.width, profile.height, bottomLines);
		const p95 = percentile(durations, 0.95);

		expect(p95, `${profile.label} render p95 ${p95.toFixed(3)}ms`).toBeLessThanOrEqual(RENDER_P95_BUDGET_MS);
	});

	it.each(TERMINAL_PROFILES)(
		"keeps the pagination anchor within one row and input area stable at $label",
		(profile) => {
			const components = createTranscriptComponents();
			const { workspace, chat, bottomLines } = createWorkspace(profile.height, components);

			workspace.render(profile.width);
			for (let index = 0; index < 40; index++) workspace.pageDown();
			const before = workspace.render(profile.width);
			const anchor = workspace.captureScrollAnchor();
			expect(anchor).toBeDefined();

			const anchorScreenRow = Array.from({ length: profile.height }, (_, row) => row).find(
				(row) => workspace.getComponentHitAtScreenRow(row)?.component === anchor?.component,
			);
			expect(anchorScreenRow).toBeDefined();
			const anchorLine = stripAnsi(before[anchorScreenRow!] ?? "").trim();

			const olderComponents = Array.from(
				{ length: PAGE_SIZE },
				(_, index) => new PerformanceTranscriptBlock(`older-${index}`, 1),
			);
			chat.children = [...olderComponents, ...chat.children];
			workspace.restoreScrollAnchor(anchor!);
			const after = workspace.render(profile.width);
			const restoredAnchor = workspace.captureScrollAnchor();
			const restoredScreenRow = Array.from({ length: profile.height }, (_, row) => row).find(
				(row) => workspace.getComponentHitAtScreenRow(row)?.component === anchor?.component,
			);

			expect(restoredAnchor?.component).toBe(anchor?.component);
			expect(restoredAnchor?.componentRow).toBe(anchor?.componentRow);
			expect(Math.abs((restoredAnchor?.viewportOffset ?? 0) - (anchor?.viewportOffset ?? 0))).toBeLessThanOrEqual(1);
			expect(restoredScreenRow).toBeDefined();
			expect(stripAnsi(after[restoredScreenRow!] ?? "").trim()).toBe(anchorLine);
			expect(after.slice(-bottomLines.length).map((line) => stripAnsi(line).trim())).toEqual(bottomLines);
		},
	);

	describe("transcript page loading", () => {
		let tempDir: string | undefined;

		afterEach(() => {
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		});

		it("keeps 5000-entry page reads within a bounded p95 and reaches the root", async () => {
			const fixture = createLongSessionFixture();
			tempDir = mkdtempSync(join(tmpdir(), "lystar-tui-performance-"));
			const sessionFile = join(tempDir, "session.jsonl");
			writeFileSync(sessionFile, `${fixture.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			const source = new SessionTranscriptSource(sessionFile);
			const durations: number[] = [];
			const collectedIds: string[] = [];
			let page = await (async () => {
				const startedAt = performance.now();
				const result = await source.readTail({ leafId: fixture.activeLeafId, limit: PAGE_SIZE });
				durations.push(performance.now() - startedAt);
				return result;
			})();

			while (true) {
				collectedIds.push(...page.entries.map((entry) => entry.id));
				if (!page.hasMore) break;
				const startedAt = performance.now();
				page = await source.readPrevious(page.previousCursor!, PAGE_SIZE);
				durations.push(performance.now() - startedAt);
			}

			expect(collectedIds).toContain(fixture.activeLeafId);
			expect(collectedIds.at(-1)).toBe("active-0");
			expect(new Set(collectedIds).size).toBe(collectedIds.length);
			expect(percentile(durations, 0.95)).toBeLessThanOrEqual(TRANSCRIPT_PAGE_P95_BUDGET_MS);
		});
	});
});
