import type { SessionCoordinator, SessionCoordinatorSummary } from "@earendil-works/pi-coding-agent/core";

const SESSION_WAIT_PROGRESS_INTERVAL_MS = 5_000;
const SESSION_WAIT_CHANGE_DELAY_MS = 100;

type WaitInput = Parameters<SessionCoordinator["wait"]>[0];

/** 观察会话状态；计时器只刷新进度，不为子任务设置截止时间。 */
export function observeSessionWait(options: {
	read: () => Promise<SessionCoordinatorSummary[]>;
	subscribe: (changed: () => void) => () => void;
	signal: AbortSignal;
	onProgress: WaitInput["onProgress"];
}): Promise<SessionCoordinatorSummary[]> {
	const startedAt = performance.now();
	return new Promise((resolve, reject) => {
		let settled = false;
		let checking = false;
		let changedDuringRead = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal.removeEventListener("abort", abort);
			unsubscribe();
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const abort = () => fail(options.signal.reason ?? new DOMException("等待已取消，子任务继续执行", "AbortError"));
		const schedule = (delay: number) => {
			if (settled) return;
			if (checking) {
				changedDuringRead = true;
				return;
			}
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void check(), delay);
		};
		const check = async () => {
			if (settled) return;
			timer = undefined;
			checking = true;
			changedDuringRead = false;
			try {
				const sessions = await options.read();
				if (settled) return;
				options.signal.throwIfAborted();
				const state = sessions.some((session) => session.activity === "waiting_for_input")
					? "needs_input"
					: sessions.some((session) => session.activity !== "running")
						? "completed"
						: "waiting";
				options.onProgress?.({ state, elapsedMs: Math.round(performance.now() - startedAt), sessions });
				if (state !== "waiting") {
					settled = true;
					cleanup();
					resolve(sessions);
				}
			} catch (error) {
				fail(error);
			} finally {
				checking = false;
				if (!settled)
					schedule(changedDuringRead ? SESSION_WAIT_CHANGE_DELAY_MS : SESSION_WAIT_PROGRESS_INTERVAL_MS);
			}
		};
		options.signal.addEventListener("abort", abort, { once: true });
		if (options.signal.aborted) {
			abort();
			return;
		}
		try {
			unsubscribe = options.subscribe(() => schedule(SESSION_WAIT_CHANGE_DELAY_MS));
			void check();
		} catch (error) {
			fail(error);
		}
	});
}
