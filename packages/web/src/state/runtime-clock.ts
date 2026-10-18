export interface RuntimeClock {
	serverAt: number;
	receivedAt: number;
}

export function runtimeNow(clock: RuntimeClock): number {
	return clock.serverAt + Math.max(0, performance.now() - clock.receivedAt);
}
