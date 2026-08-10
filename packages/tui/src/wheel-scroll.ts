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
