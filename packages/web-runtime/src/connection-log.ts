import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createRuntimeCpuRecorder } from "./runtime-cpu-recorder.ts";
import { configuredServiceEventLogPath, logWebServiceEvent, type ServiceEventFields } from "./service-event-log.ts";

const requestContext = new AsyncLocalStorage<ServiceEventFields>();
const activeRequests = new Map<symbol, ServiceEventFields>();
const activePhases = new Map<string, ServiceEventFields>();

export function logRuntimeConnection(event: string, fields: ServiceEventFields = {}): void {
	logWebServiceEvent("runtime", event, { ...requestContext.getStore(), ...fields });
}

export async function withRuntimeRequest<T>(fields: ServiceEventFields, run: () => Promise<T>): Promise<T> {
	const key = Symbol();
	activeRequests.set(key, { ...fields, startedAt: new Date().toISOString() });
	try {
		return await requestContext.run(fields, run);
	} finally {
		activeRequests.delete(key);
	}
}

/** Sync CPU cost is meaningful here; async phase CPU time would include unrelated requests. */
export function measureRuntimePhase<T>(phase: string, fields: ServiceEventFields, run: () => T): T {
	const startedAt = performance.now();
	const cpu = process.cpuUsage();
	let failure: unknown;
	try {
		return run();
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		const elapsedMs = Math.round(performance.now() - startedAt);
		if (elapsedMs >= 100 || failure !== undefined) {
			const usage = process.cpuUsage(cpu);
			logRuntimeConnection("runtime_phase_finished", {
				...fields,
				phase,
				kind: "sync",
				elapsedMs,
				cpuMs: Math.round((usage.user + usage.system) / 1000),
				outcome: failure === undefined ? "completed" : "failed",
				...(failure !== undefined ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
			});
		}
	}
}

export async function measureRuntimePhaseAsync<T>(
	phase: string,
	fields: ServiceEventFields,
	run: () => Promise<T>,
): Promise<T> {
	const phaseId = randomUUID();
	const startedAt = performance.now();
	const details = { ...requestContext.getStore(), ...fields, phase, phaseId, kind: "async" };
	activePhases.set(phaseId, { ...details, startedAt: new Date().toISOString() });
	logRuntimeConnection("runtime_phase_started", details);
	let failure: unknown;
	try {
		return await run();
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		activePhases.delete(phaseId);
		logRuntimeConnection("runtime_phase_finished", {
			...details,
			elapsedMs: Math.round(performance.now() - startedAt),
			outcome: failure === undefined ? "completed" : "failed",
			...(failure !== undefined ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
		});
	}
}

export function watchRuntimeEventLoop(): () => void {
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();
	const logPath = configuredServiceEventLogPath();
	const recorder = logPath
		? createRuntimeCpuRecorder(`${logPath.slice(0, -".sqlite".length)}-cpu`, logRuntimeConnection)
		: undefined;
	let samples = 0;
	let lastTick = performance.now();
	let lastCpu = process.cpuUsage();
	const timer = setInterval(() => {
		if (histogram.count === 0) return;
		const now = performance.now();
		const usage = process.cpuUsage(lastCpu);
		const maxMs = Math.round(histogram.max / 1_000_000);
		if (maxMs >= 250 || ++samples % 6 === 0)
			logRuntimeConnection("event_loop_delay", {
				windowMs: Math.round(now - lastTick),
				p99Ms: Math.round(histogram.percentile(99) / 1_000_000),
				maxMs,
				cpuMs: Math.round((usage.user + usage.system) / 1000),
				rssBytes: process.memoryUsage().rss,
				activeRequestCount: activeRequests.size,
				activeRequests: JSON.stringify([...activeRequests.values()].slice(0, 16)),
				activePhases: JSON.stringify([...activePhases.values()].slice(0, 16)),
			});
		lastTick = now;
		lastCpu = process.cpuUsage();
		histogram.reset();
		void recorder?.checkpoint(maxMs);
	}, 10_000);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		histogram.disable();
		recorder?.close();
	};
}
