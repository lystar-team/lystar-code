import { monitorEventLoopDelay } from "node:perf_hooks";

export function logRuntimeConnection(
	event: string,
	fields: Record<string, string | number | boolean | undefined> = {},
): void {
	process.stderr.write(
		`${JSON.stringify({ time: new Date().toISOString(), component: "runtime", pid: process.pid, event, ...fields })}\n`,
	);
}

export function watchRuntimeEventLoop(): () => void {
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();
	let samples = 0;
	const timer = setInterval(() => {
		if (histogram.count === 0) return;
		const maxMs = Math.round(histogram.max / 1_000_000);
		if (maxMs >= 250 || ++samples % 6 === 0)
			logRuntimeConnection("event_loop_delay", {
				windowMs: 10_000,
				p99Ms: Math.round(histogram.percentile(99) / 1_000_000),
				maxMs,
				rssBytes: process.memoryUsage().rss,
			});
		histogram.reset();
	}, 10_000);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		histogram.disable();
	};
}
