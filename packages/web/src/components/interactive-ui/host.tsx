import { parseInteractiveUiSnapshot, type InteractiveUiSnapshot } from "@lystar/code-web-protocol";
import { type OpenUIError, Renderer } from "@openuidev/react-lang";
import { RotateCcw } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ToolBatchTool } from "../../types";
import { StabilityBoundary } from "../stability-boundary";
import { Button } from "../ui/button";
import { InteractiveUiActions } from "./actions";
import { InteractiveUiData } from "./context";
import { interactiveUiLibrary } from "./library";
import {
	emptyInteractiveUiView,
	interactiveUiStorageKey,
	restoreInteractiveUiView,
	interactiveUiDiscussion,
	type InteractiveUiViewState,
} from "./state";

export function InteractiveUiToolResult({ tool, sessionId }: { tool: ToolBatchTool; sessionId?: string }) {
	const snapshot = parseInteractiveUiSnapshot(tool.detail);
	const latest = useRef<InteractiveUiSnapshot | undefined>(undefined);
	if (snapshot && (!latest.current || snapshot.revision >= latest.current.revision)) latest.current = snapshot;
	const content = snapshot ? latest.current : undefined;
	if (!content)
		return (
			<div className="grid gap-2 py-2 text-sm text-muted-foreground" role="status">
				<p>
					{tool.state === "input-available" || tool.state === "input-queued"
						? "等待完整交互内容…"
						: "交互内容无效或不完整，未启用交互。"}
				</p>
				{tool.detail ? (
					<details>
						<summary>查看工具原文</summary>
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{tool.detail}</pre>
					</details>
				) : null}
			</div>
		);
	const identity = JSON.stringify([sessionId, tool.id, content.version, content.program]);
	return (
		<StabilityBoundary
			scope="interactive-ui"
			resetKeys={[identity]}
			fallback={({ error }) => (
				<div role="alert" className="text-sm text-destructive">
					<p>交互内容未正常显示：{error.message}</p>
					<details>
						<summary>查看界面定义</summary>
						<pre className="max-h-64 overflow-auto whitespace-pre-wrap">{content.program}</pre>
					</details>
				</div>
			)}
		>
			<InteractiveUiContent key={identity} snapshot={content} tool={tool} sessionId={sessionId} />
		</StabilityBoundary>
	);
}

function InteractiveUiContent({
	snapshot,
	tool,
	sessionId,
}: {
	snapshot: InteractiveUiSnapshot;
	tool: ToolBatchTool;
	sessionId?: string;
}) {
	const actions = useContext(InteractiveUiActions);
	const storageKey = sessionId ? interactiveUiStorageKey(sessionId, tool.id) : undefined;
	const [{ view: initialView, error: initialError }] = useState(() => {
		try {
			return {
				view: storageKey ? restoreInteractiveUiView(storageKey, snapshot.program) : emptyInteractiveUiView(),
				error: "",
			};
		} catch (error) {
			return {
				view: emptyInteractiveUiView(),
				error: "本浏览器的视图状态未恢复：" + (error instanceof Error ? error.message : String(error)),
			};
		}
	});
	const [view, setView] = useState<InteractiveUiViewState>(initialView);
	const [storageError, setStorageError] = useState(initialError);
	const [errors, setErrors] = useState<OpenUIError[]>([]);
	const [actionError, setActionError] = useState("");
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const [resetRevision, setResetRevision] = useState(0);
	const rendererInitialState = useRef(initialView.renderer);
	const active = tool.state === "input-available" || tool.state === "input-queued";
	const canSend = Boolean(
		sessionId && actions?.available && actions.sessionId === sessionId && !active && tool.state === "output-available",
	);
	useEffect(() => {
		if (!storageKey) return;
		try {
			localStorage.setItem(storageKey, JSON.stringify({ program: snapshot.program, view }));
		} catch (error) {
			setStorageError("本浏览器的视图状态未保存：" + (error instanceof Error ? error.message : String(error)));
		}
	}, [storageKey, snapshot.program, view]);
	const updateRendererState = useCallback((renderer: Record<string, unknown>) => {
		setView((current) =>
			JSON.stringify(current.renderer) === JSON.stringify(renderer) ? current : { ...current, renderer },
		);
	}, []);
	const updateErrors = useCallback((next: OpenUIError[]) => {
		setErrors((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
	}, []);
	const submit = async (text: string) => {
		if (!canSend || !sessionId || !actions || pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setActionError("");
		try {
			await actions.continueDiscussion(sessionId, text);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	};
	return (
		<section aria-label={snapshot.title} className="my-2 min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
			<header className="mb-4 flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-base font-semibold">{snapshot.title}</h3>
					<p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
						{snapshot.source.kind === "tool" ? "工具实测" : "数据来源与假设"} · {snapshot.source.label}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<span role="status" className="text-xs text-muted-foreground">
						{active ? "持续更新中" : tool.state === "output-available" ? "内容已更新" : "更新中断"}
					</span>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						aria-label="重置交互输入"
						onClick={() => {
							rendererInitialState.current = {};
							setView(emptyInteractiveUiView());
							setErrors([]);
							setResetRevision((revision) => revision + 1);
						}}
					>
						<RotateCcw aria-hidden="true" className="size-3.5" />
					</Button>
				</div>
			</header>
			<InteractiveUiData.Provider
				value={{
					snapshot,
					view,
					setFilter: (filter) => setView((current) => ({ ...current, filter })),
					toggle: (id) =>
						setView((current) => ({
							...current,
							selected: current.selected.includes(id)
								? current.selected.filter((item) => item !== id)
								: [...current.selected, id],
						})),
					setTableSearch: (id, search) =>
						setView((current) => ({ ...current, searches: { ...current.searches, [id]: search } })),
					toggleTableRow: (tableId, rowId) =>
						setView((current) => {
							const selected = current.tableSelections[tableId] ?? [];
							return {
								...current,
								tableSelections: {
									...current.tableSelections,
									[tableId]: selected.includes(rowId) ? selected.filter((id) => id !== rowId) : [...selected, rowId],
								},
							};
						}),
					canContinue: canSend && !errors.length,
					pending,
					continueDiscussion: () => {
						void submit(interactiveUiDiscussion(snapshot, tool.id, view));
					},
				}}
			>
				<Renderer
					key={resetRevision}
					response={snapshot.program}
					library={interactiveUiLibrary}
					initialState={rendererInitialState.current}
					onStateUpdate={updateRendererState}
					onError={updateErrors}
					publishObservability={false}
				/>
			</InteractiveUiData.Provider>
			{errors.length ? (
				<div role="alert" className="mt-3 grid justify-items-start gap-2 text-sm text-destructive">
					{errors.map((error) => (
						<p key={JSON.stringify([error.code, error.statementId, error.path, error.message])}>{error.message}</p>
					))}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!canSend || pending}
						onClick={() => {
							void submit(
								"请修正这份交互内容的渲染错误。\n" +
									interactiveUiDiscussion(snapshot, tool.id, view) +
									"\n错误：" +
									JSON.stringify(errors),
							);
						}}
					>
						将错误带回会话
					</Button>
				</div>
			) : null}
			{actionError ? (
				<p role="alert" className="mt-3 text-sm text-destructive">
					{actionError}
				</p>
			) : null}
			{storageError ? (
				<p role="status" className="mt-3 text-xs text-muted-foreground">
					{storageError}
				</p>
			) : null}
			<footer className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
				<span>
					快照 {snapshot.revision} · {new Date(snapshot.updatedAt).toLocaleTimeString()}
				</span>
				<details className="min-w-0 max-w-full">
					<summary className="cursor-pointer">查看界面定义</summary>
					<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{snapshot.program}</pre>
				</details>
			</footer>
		</section>
	);
}
