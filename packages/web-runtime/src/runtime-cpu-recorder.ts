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

/** Keep the preceding CPU window, not a profile started after the stall has ended. */
export function createRuntimeCpuRecorder(
	directory: string,
	report: (event: string, fields: ServiceEventFields) => void,
): { checkpoint(maxDelayMs: number): Promise<void>; close(): void } {
	if (process.versions.bun) {
		report("cpu_recorder_unavailable", {
			runtime: "bun",
			reason: "此采样器使用 V8 Inspector；Bun 环境仅记录请求与阶段耗时",
		});
		return { async checkpoint() {}, close() {} };
	}
	let session: Session | undefined;
	let closed = false;
	let rotating = false;
	let windowStartedAt = new Date().toISOString();
	const ready = Promise.resolve()
		.then(async () => {
			if (closed) return;
			session = new Session();
			session.connect();
			await session.post("Profiler.enable");
			await session.post("Profiler.setSamplingInterval", { interval: 20_000 });
			await session.post("Profiler.start");
			report("cpu_recorder_started", { directory, samplingIntervalUs: 20_000 });
		})
		.catch((error: unknown) => {
			closed = true;
			session?.disconnect();
			report("cpu_recorder_unavailable", { error: error instanceof Error ? error.message : String(error) });
		});
	return {
		async checkpoint(maxDelayMs) {
			if (closed || rotating) return;
			rotating = true;
			try {
				await ready;
				if (closed || !session) return;
				const { profile } = await session.post("Profiler.stop");
				if (closed) return;
				const windowEndedAt = new Date().toISOString();
				const startedAt = windowStartedAt;
				windowStartedAt = windowEndedAt;
				await session.post("Profiler.start");
				if (maxDelayMs < PROFILE_DELAY_THRESHOLD_MS) return;
				await mkdir(directory, { recursive: true });
				const name = `runtime-cpu-${windowEndedAt.replaceAll(":", "-")}-${process.pid}-${randomUUID()}.cpuprofile.gz`;
				const path = join(directory, name);
				await writeFile(path, await compress(JSON.stringify(profile)));
				report("cpu_profile_saved", {
					path,
					maxDelayMs,
					windowStartedAt: startedAt,
					windowEndedAt,
					sampleCount: profile.samples?.length ?? 0,
				});
				const files = (await readdir(directory))
					.filter((file) => /^runtime-cpu-.*\.cpuprofile\.gz$/u.test(file))
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
				closed = true;
				session?.disconnect();
			} finally {
				rotating = false;
			}
		},
		close() {
			closed = true;
			session?.disconnect();
		},
	};
}
