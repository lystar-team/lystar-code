import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import type { TranscriptResponse, WebSessionSummary } from "../../types";
import { ToolBatch, type ToolBatchTool } from "../ai-elements/tool-batch";
import {
	collaborationAgentIconForSession,
	collaborationAgentType,
	collaborationAlias,
	collaborationStatus,
} from "./collaboration-session";

interface CollaborationFeedEntry {
	session: WebSessionSummary;
	response?: TranscriptResponse;
	loadFailed?: boolean;
}

function latestAssistantText(response: TranscriptResponse | undefined): string | undefined {
	for (let index = (response?.items.length ?? 0) - 1; index >= 0; index--) {
		const view = response?.items[index]?.view;
		if (view?.type === "assistant" && view.text.trim()) return view.text.trim();
	}
	return undefined;
}

function recentTools(response: TranscriptResponse | undefined): ToolBatchTool[] {
	if (!response) return [];
	const results: ToolBatchTool[] = [];
	for (const item of response.items) {
		if (item.view?.type !== "tool_result") continue;
		results.push({
			id: item.view.callId,
			name: item.view.name,
			summary: item.view.summary,
			state: item.view.status === "success" ? "output-available" : "output-error",
			detail: item.view.detail,
			diff: item.view.diff,
			images: item.view.images,
		});
	}
	return results.slice(-6);
}

function relativeTime(timestamp: number): string {
	const elapsed = Math.max(0, Date.now() - timestamp);
	if (elapsed < 60_000) return "刚刚";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
	return `${Math.floor(elapsed / 3_600_000)} 小时前`;
}

export function CollaborationFeed({
	sessions,
	onOpenSession,
	onOpenPath,
}: {
	sessions: WebSessionSummary[];
	onOpenSession: (sessionId: string) => void;
	onOpenPath: (path: string) => void;
}) {
	const childSessions = useMemo(
		() => sessions.filter((session) => session.relation === "collaboration" && Boolean(session.parentId)),
		[sessions],
	);
	const [entries, setEntries] = useState<CollaborationFeedEntry[]>(() => childSessions.map((session) => ({ session })));
	const revision = useMemo(
		() => childSessions.map((session) => `${session.id}:${session.updatedAt}:${session.activity}`).join("|"),
		[childSessions],
	);

	useEffect(() => {
		let cancelled = false;
		setEntries(childSessions.map((session) => ({ session })));
		void Promise.all(
			childSessions.map(async (session): Promise<CollaborationFeedEntry> => {
				try {
					return { session, response: await webApi.transcript(session.id, { limit: 80 }) };
				} catch {
					return { session, loadFailed: true };
				}
			}),
		).then((next) => {
			if (!cancelled) setEntries(next);
		});
		return () => {
			cancelled = true;
		};
	}, [childSessions, revision]);

	if (!childSessions.length) return null;
	return (
		<section className="grid gap-3 pt-1" aria-label="多智能体协作消息">
			{entries.map(({ session, response, loadFailed }) => {
				const Icon = collaborationAgentIconForSession(session);
				const tools = recentTools(response);
				const assistantText = latestAssistantText(response);
				return (
					<article className="min-w-0" key={session.id}>
						<button
							className="mb-1 flex min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
							onClick={() => onOpenSession(session.id)}
							type="button"
						>
							<Icon className="size-3.5 shrink-0" aria-hidden="true" />
							<span className="font-medium text-foreground">{collaborationAlias(session.id)}</span>
							<span>· {collaborationAgentType(session)}</span>
							<span>· {relativeTime(session.updatedAt)}</span>
						</button>
						<p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
							{assistantText ?? (loadFailed ? "暂时无法加载消息" : session.activity === "running" ? "正在处理…" : "尚无回复")}
						</p>
						{tools.length ? (
							<div className="mt-2 border-l border-border/70 pl-3">
								<ToolBatch
									tools={tools}
									summaryLabel={`${collaborationAlias(session.id)} 的工具调用`}
									initialOpen={session.activity === "running"}
									sessionId={session.id}
									onOpenPath={(path) => onOpenPath(path)}
								/>
							</div>
						) : session.activity === "running" ? (
							<p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
								<LoaderCircle className="size-3 animate-spin" />
								{collaborationStatus(session)}
							</p>
						) : null}
					</article>
				);
			})}
		</section>
	);
}
