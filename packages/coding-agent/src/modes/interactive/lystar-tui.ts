import { performance } from "node:perf_hooks";
import {
	type Terminal,
	TuiAltScreen,
	type TuiAltScreenOptions,
	type TuiInputListener,
	type TuiStopOptions,
} from "@earendil-works/pi-tui";

const MIN_FRAME_INTERVAL_MS = 1000 / 60;
const REPAIR_INTERVAL_MS = 500;

export interface LystarTuiOptions extends TuiAltScreenOptions {
	workspaceInputHandler?: TuiInputListener;
}

export interface OutputFlow {
	readonly writableNeedDrain: boolean;
	once(event: "drain", listener: () => void): void;
	off(event: "drain", listener: () => void): void;
}

export class LystarTUI extends TuiAltScreen {
	private readonly outputFlow: OutputFlow;
	private readonly workspaceInputHandler: TuiInputListener | undefined;
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
		options: LystarTuiOptions = {},
		outputFlow: OutputFlow = process.stdout,
	) {
		super(terminal, showHardwareCursor, logDirectory, {
			...options,
			adaptiveWheelScroll: true,
			allMouseMotion: true,
		});
		this.outputFlow = outputFlow;
		this.workspaceInputHandler = options.workspaceInputHandler;
	}

	protected override handleViewportInput(data: string) {
		if (this.isOverlayFocused()) return undefined;
		const result = this.workspaceInputHandler?.(data);
		if (result?.consume) return result;
		return super.handleViewportInput(result?.data ?? data);
	}

	protected override getRenderWidth(): number {
		return Math.max(1, this.terminal.columns - 1);
	}

	protected override getRepairIntervalMs(): number {
		return REPAIR_INTERVAL_MS;
	}

	protected override clearOnEnter(): boolean {
		return false;
	}

	protected override clearOnFullRedraw(): boolean {
		return false;
	}

	protected override beforeTerminalStart(): void {
		super.beforeTerminalStart();
		this.terminal.write("\x1b[5 q");
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		this.terminal.write("\x1b[0 q");
		super.beforeTerminalStop(options);
	}

	override start(): void {
		if (this.running) return;
		this.running = true;
		this.lastFrameAt = Number.NEGATIVE_INFINITY;
		super.start();
	}

	override stop(options: Parameters<TuiAltScreen["stop"]>[0] = {}): void {
		if (!this.running) return;
		this.cancelPendingRender();
		this.running = false;
		super.stop(options);
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
