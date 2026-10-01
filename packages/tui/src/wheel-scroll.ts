export type WheelDirection = -1 | 1;

const DISCRETE_WHEEL_INTERVAL_MS = 48;
const TARGET_WHEEL_FRAME_MS = 16;
const ACCELERATION_HISTORY_SIZE = 3;
const DISCRETE_WHEEL_LINES = 3;
const MIN_WHEEL_FRACTION = 0.25;

/** Converts integer terminal wheel events into precise low-speed and faster burst scrolling. */
export class WheelScrollNormalizer {
	private direction: WheelDirection | undefined;
	private lastEventAt: number | undefined;
	private intervals: number[] = [];
	private remainder = 0;

	getDelta(direction: WheelDirection, now = Date.now()): number {
		if (this.direction !== undefined && direction !== this.direction) {
			this.reset(direction, now);
			return direction;
		}

		if (this.lastEventAt === undefined || now - this.lastEventAt >= DISCRETE_WHEEL_INTERVAL_MS) {
			this.reset(direction, now);
			return direction * DISCRETE_WHEEL_LINES;
		}

		const interval = Math.max(0, now - this.lastEventAt);
		this.direction = direction;
		this.lastEventAt = now;
		this.intervals.push(interval);
		if (this.intervals.length > ACCELERATION_HISTORY_SIZE) this.intervals.shift();

		const averageInterval = this.intervals.reduce((sum, value) => sum + value, 0) / this.intervals.length;
		const normalizedLines = Math.min(
			DISCRETE_WHEEL_LINES,
			Math.max(MIN_WHEEL_FRACTION, averageInterval / TARGET_WHEEL_FRAME_MS),
		);
		this.remainder += normalizedLines;
		const lines = Math.trunc(this.remainder);
		this.remainder -= lines;
		return direction * lines;
	}

	reset(direction?: WheelDirection, now?: number): void {
		this.direction = direction;
		this.lastEventAt = now;
		this.intervals = [];
		this.remainder = 0;
	}
}

/** Lines moved per mouse-wheel event, or `"auto"` to accelerate fast wheel spins. */
export type WheelScrollLines = number | "auto";

const BURST_GAP_MS = 5;
const GESTURE_GAP_MS = 200;
const REFERENCE_GAP_MS = 100;
const MAX_AUTO_LINES = 6;

function terminalAcceleratesWheel(): boolean {
	const env = process.env;
	return (
		process.platform === "darwin" &&
		env.SSH_CONNECTION === undefined &&
		env.SSH_CLIENT === undefined &&
		env.SSH_TTY === undefined
	);
}

/** Converts wheel events into line counts with optional velocity-based acceleration. */
export class WheelScrollAccelerator {
	private lines: WheelScrollLines;
	private readonly accelerate: boolean;
	private lastTime = Number.NEGATIVE_INFINITY;
	private lastDirection = 0;
	private averageGap: number | undefined;
	private carry = 0;

	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		this.lines = lines;
		this.accelerate = accelerate;
	}

	setLines(lines: WheelScrollLines): void {
		this.lines = lines;
		this.reset();
	}

	next(direction: WheelDirection, now: number): number {
		if (this.lines !== "auto") return Number.isFinite(this.lines) ? Math.max(1, Math.floor(this.lines)) : 1;
		if (!this.accelerate) return 1;

		const gap = now - this.lastTime;
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!sameGesture) {
			this.averageGap = undefined;
			this.carry = 0;
			return 1;
		}
		if (gap < BURST_GAP_MS) return 1;

		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
		const lines = Math.min(MAX_AUTO_LINES, Math.max(1, REFERENCE_GAP_MS / this.averageGap)) + this.carry;
		const whole = Math.floor(lines);
		this.carry = lines - whole;
		return whole;
	}

	reset(): void {
		this.lastTime = Number.NEGATIVE_INFINITY;
		this.lastDirection = 0;
		this.averageGap = undefined;
		this.carry = 0;
	}
}
