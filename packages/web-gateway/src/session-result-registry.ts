import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSessionResultActivity, type SessionResultState, type SessionSummary } from "@lystar/code-web-protocol";

type ResultSummary = Pick<SessionSummary, "id" | "activity" | "operationUpdatedAt" | "updatedAt">;
interface ResultIndex {
	initializedAt: number;
	results: Record<string, SessionResultState>;
}

export class SessionResultRegistry {
	readonly path: string;
	private state: ResultIndex = { initializedAt: Date.now(), results: {} };
	private queue: Promise<unknown> = Promise.resolve();
	private readonly onChange: (result: SessionResultState) => void;

	constructor(agentDir: string, onChange: (result: SessionResultState) => void) {
		this.path = join(agentDir, "web", "session-results.json");
		this.onChange = onChange;
	}

	async load(): Promise<void> {
		try {
			const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (
				!value ||
				typeof value !== "object" ||
				!("initializedAt" in value) ||
				typeof value.initializedAt !== "number" ||
				!Number.isFinite(value.initializedAt) ||
				!("results" in value) ||
				!value.results ||
				typeof value.results !== "object" ||
				Array.isArray(value.results)
			)
				throw new Error("会话查看记录格式无效");
			const results: Record<string, SessionResultState> = {};
			for (const [sessionId, candidate] of Object.entries(value.results) as Array<[string, unknown]>) {
				const entry = candidate as Partial<SessionResultState> | null;
				if (
					!entry ||
					typeof entry !== "object" ||
					entry.sessionId !== sessionId ||
					!Number.isSafeInteger(entry.revision) ||
					(entry.revision ?? 0) < 1 ||
					!Number.isSafeInteger(entry.readRevision) ||
					(entry.readRevision ?? -1) < 0 ||
					(entry.readRevision ?? -1) > (entry.revision ?? 0) ||
					typeof entry.updatedAt !== "number" ||
					!Number.isFinite(entry.updatedAt) ||
					typeof entry.activity !== "string" ||
					!isSessionResultActivity(entry.activity) ||
					!Number.isSafeInteger(entry.version) ||
					(entry.version ?? 0) < 1 ||
					(entry.viewedAt !== undefined && !Number.isFinite(entry.viewedAt))
				)
					throw new Error("会话查看记录格式无效");
				results[sessionId] = entry as SessionResultState;
			}
			this.state = { initializedAt: value.initializedAt, results };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await this.persist(this.state);
		}
	}

	get(sessionId: string): SessionResultState | undefined {
		const result = this.state.results[sessionId];
		return result ? { ...result } : undefined;
	}

	observe(summaries: readonly ResultSummary[]): Promise<void> {
		return this.enqueue(async () => {
			const results = { ...this.state.results };
			const changed = new Map<string, SessionResultState>();
			for (const summary of summaries) {
				if (!isSessionResultActivity(summary.activity)) continue;
				const updatedAt = summary.operationUpdatedAt ?? summary.updatedAt;
				const previous = results[summary.id];
				if (previous && updatedAt <= previous.updatedAt) continue;
				const revision = (previous?.revision ?? 0) + 1;
				const result: SessionResultState = {
					sessionId: summary.id,
					revision,
					readRevision: previous?.readRevision ?? (updatedAt <= this.state.initializedAt ? revision : 0),
					updatedAt,
					activity: summary.activity,
					...(previous?.viewedAt === undefined ? {} : { viewedAt: previous.viewedAt }),
					version: (previous?.version ?? 0) + 1,
				};
				results[summary.id] = result;
				changed.set(summary.id, result);
			}
			if (!changed.size) return;
			const next = { ...this.state, results };
			await this.persist(next);
			this.state = next;
			for (const result of changed.values()) this.onChange({ ...result });
		});
	}

	markRead(sessionId: string, revision: number): Promise<SessionResultState> {
		return this.enqueue(async () => {
			const previous = this.state.results[sessionId];
			if (!previous || revision < 1 || revision > previous.revision)
				throw Object.assign(new Error("会话结果已变化，请重新打开会话"), {
					status: 409,
					code: "session_result_revision_invalid",
				});
			// 旧页面只能确认自己展示过的结果，不清除之后产生的新结果。
			const result: SessionResultState = {
				...previous,
				readRevision: Math.max(previous.readRevision, revision),
				viewedAt: Date.now(),
				version: previous.version + 1,
			};
			const next = { ...this.state, results: { ...this.state.results, [sessionId]: result } };
			await this.persist(next);
			this.state = next;
			this.onChange({ ...result });
			return { ...result };
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.queue.then(operation);
		this.queue = pending.catch(() => {});
		return pending;
	}

	private async persist(state: ResultIndex): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { flag: "wx" });
			await rename(temporaryPath, this.path);
		} finally {
			await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
}
