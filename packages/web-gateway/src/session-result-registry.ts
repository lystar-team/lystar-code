import { isSessionResultActivity, type SessionResultState, type SessionSummary } from "@lystar/code-web-protocol";
import { WorkspaceDatabase } from "./workspace-database.ts";

type ResultSummary = Pick<SessionSummary, "id" | "activity" | "operationUpdatedAt" | "updatedAt">;

export class SessionResultRegistry {
	readonly path: string;
	private readonly storage: WorkspaceDatabase;
	private readonly onChange: (result: SessionResultState) => void;

	constructor(
		agentDir: string,
		onChange: (result: SessionResultState) => void,
		storage = new WorkspaceDatabase(agentDir),
	) {
		this.storage = storage;
		this.path = storage.path;
		this.onChange = onChange;
	}

	async load(): Promise<void> {
		this.storage.load();
	}

	get(sessionId: string): SessionResultState | undefined {
		return this.storage.getResult(sessionId);
	}

	async observe(summaries: readonly ResultSummary[]): Promise<void> {
		const changed = await this.storage.updateResults((state) => {
			const changed: SessionResultState[] = [];
			for (const summary of summaries) {
				if (!isSessionResultActivity(summary.activity)) continue;
				const updatedAt = Math.max(summary.operationUpdatedAt ?? 0, summary.updatedAt);
				const previous = state.results[summary.id];
				if (previous && updatedAt <= previous.updatedAt) continue;
				const revision = (previous?.revision ?? 0) + 1;
				const result: SessionResultState = {
					sessionId: summary.id,
					revision,
					readRevision: previous?.readRevision ?? (updatedAt <= state.initializedAt ? revision : 0),
					updatedAt,
					activity: summary.activity,
					...(previous?.viewedAt === undefined ? {} : { viewedAt: previous.viewedAt }),
					version: (previous?.version ?? 0) + 1,
				};
				state.results[summary.id] = result;
				changed.push(result);
			}
			return changed;
		});
		for (const result of changed) this.onChange(result);
	}

	async markRead(sessionId: string, revision: number): Promise<SessionResultState> {
		const result = await this.storage.updateResults((state) => {
			const previous = state.results[sessionId];
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
			state.results[sessionId] = result;
			return result;
		});
		this.onChange(result);
		return result;
	}
}
