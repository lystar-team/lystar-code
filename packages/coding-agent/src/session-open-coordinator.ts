import { ProcessTerminal, Text, type TUI, TuiMainScreen, type TuiMode } from "@earendil-works/pi-tui";
import { APP_TITLE, getAgentDir } from "./config.ts";
import { stripInternalPromptContent } from "./core/prompt-display.ts";
import type { SessionEntry } from "./core/session-manager.ts";
import { time } from "./core/timings.ts";
import { LystarTUI } from "./modes/interactive/lystar-tui.ts";
import { SessionTranscriptSource, type TranscriptSource } from "./modes/interactive/session-transcript-source.ts";

interface OpeningRenderer extends Pick<TUI, "addChild" | "requestRender" | "start" | "stop" | "setClearOnShrink"> {}

export interface SessionOpenCoordinatorOptions {
	sessionFile: string;
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	clearOnShrink: boolean;
	mouse: boolean;
	tailLimit?: number;
	transcriptSource?: TranscriptSource;
	createRenderer?: () => OpeningRenderer;
}

function truncatePreview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				Boolean(block) && typeof block === "object" && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function previewEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "compaction") return `[上下文压缩] ${truncatePreview(entry.summary)}`;
	if (entry.type === "branch_summary" && entry.summary) return `[分支摘要] ${truncatePreview(entry.summary)}`;
	if (entry.type === "custom_message" && entry.display) {
		const text = contentText(entry.content);
		return text.trim() ? truncatePreview(text) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const { message } = entry;
	if (message.role === "bashExecution") return `Shell：${truncatePreview(message.command)}`;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
	const text = contentText(message.content);
	if (!text.trim()) return undefined;
	const preview = truncatePreview(message.role === "user" ? stripInternalPromptContent(text) : text);
	if (!preview.trim()) return undefined;
	if (message.role === "user") return `你：${preview}`;
	if (message.role === "assistant") return `助手：${preview}`;
	if (message.role === "toolResult") return `Tool ${message.toolName}：${preview}`;
	return undefined;
}

function previewEntries(entries: SessionEntry[]): string {
	const previews = entries.flatMap((entry) => {
		const preview = previewEntry(entry);
		return preview ? [preview] : [];
	});
	return previews.length > 0 ? previews.slice(-8).join("\n\n") : "最近没有可预览的对话记录。";
}

function createRenderer(options: SessionOpenCoordinatorOptions): OpeningRenderer {
	const terminal = new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		return new LystarTUI(terminal, options.showHardwareCursor, getAgentDir(), { mouse: options.mouse });
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, getAgentDir());
}

/** 已有 Session 打开期间显示的 renderer shell。 */
export class SessionOpenCoordinator {
	private readonly options: SessionOpenCoordinatorOptions;
	private readonly renderer: OpeningRenderer;
	private readonly status = new Text(`${APP_TITLE}\n正在打开会话\n正在读取最近记录...`, 1, 1);
	private readonly tail = new Text("", 1, 0);
	private readonly composer = new Text("\n会话上下文准备中，输入将在完成后启用", 1, 1);
	private stopped = false;

	private constructor(options: SessionOpenCoordinatorOptions) {
		this.options = options;
		this.renderer = options.createRenderer?.() ?? createRenderer(options);
		this.renderer.setClearOnShrink(options.clearOnShrink);
		this.renderer.addChild(this.status);
		this.renderer.addChild(this.tail);
		this.renderer.addChild(this.composer);
	}

	static start(options: SessionOpenCoordinatorOptions): SessionOpenCoordinator {
		const coordinator = new SessionOpenCoordinator(options);
		coordinator.renderer.start();
		time("T_shell", "sessionOpening");
		void coordinator.loadTail();
		return coordinator;
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.renderer.stop({ preserveScreen: true });
	}

	private async loadTail(): Promise<void> {
		try {
			const source = this.options.transcriptSource ?? new SessionTranscriptSource(this.options.sessionFile);
			const page = await source.readTail({ leafId: null, limit: this.options.tailLimit ?? 20 });
			if (this.stopped) return;
			this.status.setText(`${APP_TITLE}\n正在打开会话\n正在准备上下文...`);
			this.tail.setText(previewEntries(page.entries));
			this.renderer.requestRender();
			time("T_tail", "sessionOpening");
		} catch {
			if (this.stopped) return;
			this.status.setText(`${APP_TITLE}\n正在打开会话\n正在准备上下文...`);
			this.renderer.requestRender();
		}
	}
}
