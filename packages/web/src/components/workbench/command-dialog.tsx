import { useEffect, useMemo, useRef, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import type { CommandDialogRequest } from "../../state/composer-commands";
import { sessionTitle, type WorkbenchState } from "../../state/use-workbench";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { THINKING_LEVEL_LABELS, selectedVisibleThinkingLevel, visibleThinkingLevels } from "./constants";
import { formatModelDisplayName } from "./model-utils";
import { VirtualizedSessionList } from "./virtualized-session-list";
import {
	buildSessionTurns,
	sessionTreeNodeLabel,
	sessionTurnLabel,
} from "./session-tree-utils";
import { SessionToolsDialog } from "./session-tree-panel";
import { SessionTurnRow } from "./session-turn-row";
import type { WorkbenchActions } from "./types";

const TITLES = {
	model: "选择模型",
	thinking: "选择思考级别",
	name: "重命名会话",
	resume: "恢复会话",
	fork: "创建会话分支",
	tree: "会话分支",
	trust: "项目信任",
	session: "当前会话",
	hotkeys: "输入快捷键",
};
const DESCRIPTIONS = {
	model: "选择当前会话使用的模型",
	thinking: "选择当前模型支持的思考级别",
	name: "修改当前会话的显示名称",
	resume: "选择当前项目中的会话",
	fork: "选择一条用户消息，从该位置创建新会话",
	tree: "按会话轮次选择 fork 位置；原有会话和分支会保留",
	trust: "管理当前项目的资源信任",
	session: "查看会话与上下文信息",
	hotkeys: "Web 输入框支持的键盘操作",
};

export function commandTreeLabel(node: WorkbenchState["sessionTree"][number]): string {
	return sessionTreeNodeLabel(node);
}

export function CommandDialog({ request, state, actions, onClose }: {
	request: CommandDialogRequest;
	state: WorkbenchState;
	actions: WorkbenchActions;
	onClose: () => void;
}) {
	const [value, setValue] = useState(request.value ?? "");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [trust, setTrust] = useState<WorkbenchState["projectTrust"]>();
	const model = state.models.find((item) => item.provider === state.session?.model?.provider && item.id === state.session?.model?.id);
	const levels = visibleThinkingLevels(model?.supportedThinkingLevels.length ? model.supportedThinkingLevels : ["off"]);
	const selectedThinkingLevel = selectedVisibleThinkingLevel(state.session?.thinkingLevel ?? "off", levels);
	const project = state.projects.find((item) => item.id === state.currentProjectId);
	const treeViewportRef = useRef<HTMLDivElement>(null);
	const [pendingTurnId, setPendingTurnId] = useState<string>();
	const [toolTurnId, setToolTurnId] = useState<string>();
	const turns = useMemo(() => buildSessionTurns(state.sessionTree), [state.sessionTree]);
	const pendingTurn = turns.find((turn) => turn.id === pendingTurnId);
	const toolTurn = turns.find((turn) => turn.id === toolTurnId);
	const unavailable = busy || loading || state.readOnly || !state.connected;

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setLoading(true);
			try {
				if (request.kind === "tree") await actions.loadSessionTree();
				if (request.kind === "trust" && state.currentProjectId) {
					const result = await webApi.projectTrust(state.currentProjectId);
					if (!cancelled) setTrust(result);
				}
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		void load();
		return () => { cancelled = true; };
	}, [actions.loadSessionTree, request.kind, state.currentProjectId]);

	const run = async (operation: () => Promise<void>) => {
		if (unavailable) return;
		setBusy(true);
		setError("");
		try {
			await operation();
			onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{TITLES[request.kind]}</DialogTitle>
					<DialogDescription>{DESCRIPTIONS[request.kind]}</DialogDescription>
				</DialogHeader>
				{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
				{loading ? <p role="status" className="text-sm text-muted-foreground">正在加载…</p> : null}
				{request.kind === "name" ? (
					<form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (state.sessionId && value.trim()) void run(() => actions.renameSession(state.sessionId!, value.trim())); }}>
						<Input aria-label="会话名称" value={value} onChange={(event) => setValue(event.target.value)} disabled={unavailable} autoFocus />
						<DialogFooter><Button variant="outline" type="button" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" disabled={unavailable || !value.trim()}>保存</Button></DialogFooter>
					</form>
				) : null}
				{request.kind === "thinking" ? <div className="grid gap-1">{levels.map((level) => (
					<Button key={level} variant={selectedThinkingLevel === level ? "secondary" : "ghost"} className="justify-start" disabled={unavailable} onClick={() => void run(() => actions.updateThinking(level))}>{THINKING_LEVEL_LABELS[level] ?? level}{selectedThinkingLevel === level ? " · 当前" : ""}</Button>
				))}</div> : null}
				{request.kind === "resume" ? <div className="grid min-h-0 gap-3">
					<Input aria-label="搜索会话" placeholder="搜索会话…" value={value} onChange={(event) => setValue(event.target.value)} />
					<div className="grid max-h-[50vh] gap-1 overflow-y-auto">{project?.sessions.filter((session) => sessionTitle(session).toLocaleLowerCase().includes(value.toLocaleLowerCase())).map((session) => (
						<Button key={session.id} variant={session.id === state.sessionId ? "secondary" : "ghost"} className="justify-start" disabled={unavailable} onClick={() => void run(() => actions.selectSession(session.id))}><span className="truncate">{sessionTitle(session)}</span></Button>
					))}<p className="text-xs text-muted-foreground">选择后继续该会话。</p></div>
				</div> : null}
				{request.kind === "fork" ? <div className="grid max-h-[50vh] gap-1 overflow-y-auto">
					{state.hasMorePrevious ? <Button variant="outline" disabled={state.loadingEarlier || unavailable} onClick={() => { void actions.loadEarlier().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }}>{state.loadingEarlier ? "正在加载…" : "加载更早的消息"}</Button> : null}
					{state.transcript.filter((item) => item.view?.type === "user").map((item) => <Button key={item.entryId} variant="ghost" className="h-auto justify-start py-3 text-left" disabled={unavailable} onClick={() => void run(() => actions.fork(item.entryId))}><span className="line-clamp-3 whitespace-pre-wrap break-words">{item.view?.type === "user" ? item.view.text || "图片消息" : ""}</span></Button>)}
					{!state.transcript.some((item) => item.view?.type === "user") ? <p className="text-sm text-muted-foreground">当前没有可选择的用户消息。</p> : null}
				</div> : null}
				{request.kind === "tree" && !loading ? (
					<div className="grid gap-3">
						<div ref={treeViewportRef} className="max-h-[50vh] overflow-y-auto">
							{turns.length ? (
								<VirtualizedSessionList
									items={turns}
									getKey={(turn) => turn.id}
									scrollRef={treeViewportRef}
									rowHeight={56}
									rowGap={4}
									renderItem={(turn) => (
										<SessionTurnRow
											turn={turn}
											selected={pendingTurnId === turn.id}
											compact
											disabled={unavailable}
											onSelect={() => setPendingTurnId(turn.id)}
										/>
									)}
								/>
							) : (
								<p className="py-4 text-sm text-muted-foreground">当前会话还没有可创建分支的历史轮次。</p>
							)}
						</div>
						{pendingTurn ? (
							<div className="grid gap-3 border-t border-border/70 pt-3">
								<div>
									<p className="text-sm font-medium">从这一轮创建新会话？</p>
									<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{sessionTurnLabel(pendingTurn)}</p>
									{pendingTurn.toolNodes.length ? (
										<button
											type="button"
											className="mt-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:bg-accent hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
											onClick={() => setToolTurnId(pendingTurn.id)}
										>
											{pendingTurn.toolNodes.length} 个工具动作
										</button>
									) : null}
								</div>
								<div className="flex justify-end gap-2">
									<Button variant="outline" onClick={() => setPendingTurnId(undefined)} disabled={busy}>
										取消
									</Button>
									<Button onClick={() => void run(() => actions.fork(pendingTurn.forkEntryId))} disabled={unavailable || !pendingTurn.userNode}>
										创建新会话
									</Button>
								</div>
							</div>
						) : null}
					</div>
				) : null}
				<SessionToolsDialog turn={toolTurn} onClose={() => setToolTurnId(undefined)} />

				{request.kind === "trust" && trust ? <div className="grid gap-4">
					<p className="text-sm">{trust.trusted === true ? "当前项目已信任" : trust.trusted === false ? "当前项目未信任" : "当前项目尚未设置信任"}</p>
					<DialogFooter><Button variant="outline" disabled={unavailable} onClick={() => void run(() => actions.setProjectTrust(false))}>不信任</Button><Button disabled={unavailable} onClick={() => void run(() => actions.setProjectTrust(true))}>信任项目</Button></DialogFooter>
				</div> : null}
				{request.kind === "session" ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
					<dt className="text-muted-foreground">名称</dt><dd className="break-words">{sessionTitle(state.session)}</dd>
					<dt className="text-muted-foreground">模型</dt><dd className="break-words">{formatModelDisplayName(model)}</dd>
					<dt className="text-muted-foreground">思考级别</dt><dd>{THINKING_LEVEL_LABELS[state.session?.thinkingLevel ?? "off"] ?? state.session?.thinkingLevel}</dd>
					<dt className="text-muted-foreground">上下文</dt><dd>{state.session?.contextTokens ?? 0} / {state.session?.contextWindow ?? model?.contextWindow ?? 0} tokens</dd>
				</dl> : null}
				{request.kind === "hotkeys" ? <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm"><dt>Enter</dt><dd>发送；任务运行时加入后续消息</dd><dt>Shift + Enter</dt><dd>换行</dd><dt>Ctrl / ⌘ + Enter</dt><dd>任务运行时引导当前任务</dd><dt>↑ / ↓、Tab</dt><dd>选择并填入补全项</dd><dt>Esc</dt><dd>关闭补全菜单或弹窗</dd></dl> : null}
			</DialogContent>
		</Dialog>
	);
}
