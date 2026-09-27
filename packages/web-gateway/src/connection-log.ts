import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { logWebServiceEvent, type ServiceEventFields } from "@lystar/code-web-runtime";

const requestContext = new AsyncLocalStorage<string>();

export function withGatewayRequest<T>(requestId: string, run: () => T): T {
	return requestContext.run(requestId, run);
}

export function logGatewayConnection(event: string, fields: ServiceEventFields = {}): void {
	logWebServiceEvent("gateway", event, {
		...fields,
		...(requestContext.getStore() ? { parentRequestId: requestContext.getStore() } : {}),
	});
}

export function watchGatewayEventLoop(): () => void {
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();
	let samples = 0;
	const timer = setInterval(() => {
		if (histogram.count === 0) return;
		const maxMs = Math.round(histogram.max / 1_000_000);
		if (maxMs >= 250 || ++samples % 6 === 0)
			logGatewayConnection("event_loop_delay", {
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
