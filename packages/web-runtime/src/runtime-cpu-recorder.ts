import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { ServiceEventFields } from "./service-event-log.ts";

const compress = promisify(gzip);
const PROFILE_DELAY_THRESHOLD_MS = 1_000;
const MAX_SAVED_PROFILES = 16;
// 三个 10 秒采样间隔仍未完成轮转时，提示检查轮转；不改变采样或服务生命周期。
const CHECKPOINT_STALL_THRESHOLD_MS = 30_000;
/** Keep the preceding CPU window, not a profile started after the stall has ended. */
export function createServiceCpuRecorder(
	component: "runtime" | "gateway",
	directory: string,
	report: (event: string, fields: ServiceEventFields) => void,
): { checkpoint(maxDelayMs: number): Promise<void>; health(): ServiceEventFields; close(): void } {
	let session: Session | undefined;
	let closed = false;
	let rotating = false;
	let windowStartedAt = new Date().toISOString();
	const health: ServiceEventFields = { state: "starting", startedAt: new Date().toISOString() };
	let checkpointStartedAt: number | undefined;
	const ready = Promise.resolve()
		.then(async () => {
			if (closed) return;
			session = new Session();
			session.connect();
			await session.post("Profiler.enable");
			await session.post("Profiler.setSamplingInterval", { interval: 20_000 });
			await session.post("Profiler.start");
			health.state = "recording";
			health.startedAt = new Date().toISOString();
			report("cpu_recorder_started", { directory, samplingIntervalUs: 20_000 });
		})
		.catch((error: unknown) => {
			closed = true;
			session?.disconnect();
			health.state = "unavailable";
			health.error = error instanceof Error ? error.message : String(error);
			report("cpu_recorder_unavailable", { error: health.error });
		});
	return {
		async checkpoint(maxDelayMs) {
			if (closed || rotating) return;
			rotating = true;
			const checkpointStarted = performance.now();
			checkpointStartedAt = checkpointStarted;
			try {
				await ready;
				if (closed || !session) return;
				const { profile } = await session.post("Profiler.stop");
				if (closed) return;
				const windowEndedAt = new Date().toISOString();
				const startedAt = windowStartedAt;
				windowStartedAt = windowEndedAt;
				await session.post("Profiler.start");
				health.lastCheckpointAt = windowEndedAt;
				if (maxDelayMs < PROFILE_DELAY_THRESHOLD_MS) return;
				await mkdir(directory, { recursive: true });
				const name = `${component}-cpu-${windowEndedAt.replaceAll(":", "-")}-${process.pid}-${randomUUID()}.cpuprofile.gz`;
				const path = join(directory, name);
				await writeFile(path, await compress(JSON.stringify(profile)));
				health.lastSavedProfile = path;
				health.lastSavedAt = new Date().toISOString();
				report("cpu_profile_saved", {
					path,
					maxDelayMs,
					windowStartedAt: startedAt,
					windowEndedAt,
					sampleCount: profile.samples?.length ?? 0,
					checkpointMs: Math.round(performance.now() - checkpointStarted),
				});
				const files = (await readdir(directory))
					.filter((file) => file.startsWith(`${component}-cpu-`) && file.endsWith(".cpuprofile.gz"))
					.sort();
				const expired = files.slice(0, Math.max(0, files.length - MAX_SAVED_PROFILES));
				await Promise.all(
					expired.map((file) =>
						unlink(join(directory, file)).catch((error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						}),
					),
				);
				if (expired.length)
					report("cpu_profiles_pruned", { directory, count: expired.length, retained: MAX_SAVED_PROFILES });
			} catch (error) {
				if (!closed)
					report("cpu_recorder_failed", { error: error instanceof Error ? error.message : String(error) });
				health.state = "failed";
				health.error = error instanceof Error ? error.message : String(error);
				closed = true;
				session?.disconnect();
			} finally {
				rotating = false;
			}
		},
		health() {
			const checkpointAgeMs =
				rotating && checkpointStartedAt !== undefined
					? Math.round(performance.now() - checkpointStartedAt)
					: undefined;
			return {
				...health,
				rotating,
				checkpointAgeMs,
				...(health.state === "recording" &&
				checkpointAgeMs !== undefined &&
				checkpointAgeMs >= CHECKPOINT_STALL_THRESHOLD_MS
					? { state: "checkpoint_stalled" }
					: {}),
			};
		},
		close() {
			health.state = "closed";
			closed = true;
			session?.disconnect();
		},
	};
}
