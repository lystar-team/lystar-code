import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServiceCpuRecorder } from "./runtime-cpu-recorder.ts";
import {
	configuredServiceEventLogPath,
	logWebServiceEvent,
	type ServiceEventFields,
	serviceEventLogHealth,
} from "./service-event-log.ts";

const requestContext = new AsyncLocalStorage<ServiceEventFields>();
const activeRequests = new Map<symbol, ServiceEventFields>();
const activePhases = new Map<string, ServiceEventFields>();
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 10_000;
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

function runtimeFailureFields(error: unknown): ServiceEventFields {
	const failure = error instanceof Error ? error : undefined;
	const cause = failure?.cause;
	return {
		error: failure?.message ?? String(error),
		errorName: failure?.name,
		errorStack: failure?.stack,
		errorCause: cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause),
		errorCauseStack: cause instanceof Error ? cause.stack : undefined,
		errorCode: failure && "code" in failure && typeof failure.code === "string" ? failure.code : undefined,
	};
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
				...(failure !== undefined ? runtimeFailureFields(failure) : {}),
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
			...(failure !== undefined ? runtimeFailureFields(failure) : {}),
		});
	}
}

export function watchRuntimeEventLoop(): () => void {
	return watchServiceEventLoop("runtime", () => ({
		activeRequestCount: activeRequests.size,
		activeRequests: JSON.stringify([...activeRequests.values()].slice(0, 16)),
		activePhases: JSON.stringify([...activePhases.values()].slice(0, 16)),
	}));
}

export function watchServiceEventLoop(
	component: "runtime" | "gateway",
	getActivity?: () => ServiceEventFields,
): () => void {
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();
	const log = (event: string, fields: ServiceEventFields) => logWebServiceEvent(component, event, fields);
	const logPath = configuredServiceEventLogPath();
	const recorder = logPath
		? createServiceCpuRecorder(component, `${logPath.slice(0, -".sqlite".length)}-${component}-cpu`, log)
		: undefined;
	let samples = 0;
	let lastTick = performance.now();
	let lastCpu = process.cpuUsage();
	const timer = setInterval(() => {
		const now = performance.now();
		const usage = process.cpuUsage(lastCpu);
		const hasHistogramSamples = histogram.count > 0;
		// Bun 可能没有直方图样本，仍用计时器延迟记录长阻塞并触发 CPU 采样保存。
		const maxMs = Math.max(
			hasHistogramSamples ? Math.round(histogram.max / 1_000_000) : 0,
			Math.round(now - lastTick - EVENT_LOOP_SAMPLE_INTERVAL_MS),
		);
		samples++;
		if (samples % 6 === 0) {
			log("cpu_recorder_health", recorder?.health() ?? { state: "disabled" });
			log("service_log_health", serviceEventLogHealth());
		}
		if (maxMs >= 250 || samples % 6 === 0)
			log("event_loop_delay", {
				windowMs: Math.round(now - lastTick),
				p99Ms: hasHistogramSamples ? Math.round(histogram.percentile(99) / 1_000_000) : undefined,
				maxMs,
				cpuMs: Math.round((usage.user + usage.system) / 1000),
				rssBytes: process.memoryUsage().rss,
				...getActivity?.(),
			});
		lastTick = now;
		lastCpu = process.cpuUsage();
		histogram.reset();
		void recorder?.checkpoint(maxMs);
	}, EVENT_LOOP_SAMPLE_INTERVAL_MS);
	timer.unref?.();
	return () => {
		clearInterval(timer);
		histogram.disable();
		recorder?.close();
	};
}
