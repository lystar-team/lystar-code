import { performance } from "node:perf_hooks";
import { type Terminal, type TerminalModeOptions, TUI } from "@earendil-works/pi-tui";

const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const MIN_FRAME_INTERVAL_MS = 1000 / 30;

export interface OutputFlow {
	readonly writableNeedDrain: boolean;
	once(event: "drain", listener: () => void): void;
	off(event: "drain", listener: () => void): void;
}

export class LystarTUI extends TUI {
	private readonly outputFlow: OutputFlow;
	private fullscreen = false;
	private running = false;
	private renderPending = false;
	private forcePending = false;
	private waitingForDrain = false;
	private frameTimer: NodeJS.Timeout | undefined;
	private lastFrameAt = Number.NEGATIVE_INFINITY;

	private readonly handleDrain = (): void => {
		this.waitingForDrain = false;
		this.scheduleLystarRender();
	};

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		outputFlow: OutputFlow = process.stdout,
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.outputFlow = outputFlow;
	}

	protected override getRenderWidth(): number {
		return Math.max(1, this.terminal.columns - (this.fullscreen ? 1 : 0));
	}

	protected override useFixedViewportRenderer(): boolean {
		return this.fullscreen;
	}

	override setTerminalModes(options: TerminalModeOptions): void {
		const wasFullscreen = this.fullscreen;
		if (this.running && wasFullscreen && !options.alternateScreen) {
			this.terminal.write(ENABLE_AUTOWRAP);
		}
		this.fullscreen = options.alternateScreen;
		super.setTerminalModes(options);
		if (this.running && !wasFullscreen && this.fullscreen) {
			this.terminal.write(DISABLE_AUTOWRAP);
		}
	}

	override start(): void {
		if (this.running) return;
		this.running = true;
		this.lastFrameAt = Number.NEGATIVE_INFINITY;
		super.start();
		if (this.fullscreen) {
			this.terminal.write(DISABLE_AUTOWRAP);
		}
	}

	override stop(): void {
		if (!this.running) return;
		this.cancelPendingRender();
		if (this.fullscreen) {
			this.terminal.write(ENABLE_AUTOWRAP);
		}
		this.running = false;
		super.stop();
	}

	override requestRender(force = false): void {
		if (!this.running) return;
		this.renderPending = true;
		this.forcePending ||= force;
		if (force && this.frameTimer) {
			clearTimeout(this.frameTimer);
			this.frameTimer = undefined;
		}
		this.scheduleLystarRender();
	}

	private scheduleLystarRender(): void {
		if (!this.running || !this.renderPending || this.frameTimer) return;
		if (this.outputFlow.writableNeedDrain) {
			if (!this.waitingForDrain) {
				this.waitingForDrain = true;
				this.outputFlow.once("drain", this.handleDrain);
			}
			return;
		}

		const delay = this.forcePending ? 0 : Math.max(0, MIN_FRAME_INTERVAL_MS - (performance.now() - this.lastFrameAt));
		if (delay > 0) {
			this.frameTimer = setTimeout(() => {
				this.frameTimer = undefined;
				this.scheduleLystarRender();
			}, delay);
			return;
		}

		const force = this.forcePending;
		this.renderPending = false;
		this.forcePending = false;
		this.lastFrameAt = performance.now();
		super.requestRender(force);
	}

	private cancelPendingRender(): void {
		if (this.frameTimer) {
			clearTimeout(this.frameTimer);
			this.frameTimer = undefined;
		}
		if (this.waitingForDrain) {
			this.outputFlow.off("drain", this.handleDrain);
			this.waitingForDrain = false;
		}
		this.renderPending = false;
		this.forcePending = false;
	}
}
