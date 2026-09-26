import { LoaderCircle, Plus } from "lucide-react";
import { collaborationAlias } from "@lystar/code-web-protocol";
import { useEffect, useState } from "react";
import type { RoomWorkspaceController } from "../../state/use-room-workspace";
import type { WebRoomMember, WebRoomTask, WebRoomTaskStatus } from "../../types";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const COLUMNS: ReadonlyArray<{ status: WebRoomTaskStatus; title: string }> = [
	{ status: "todo", title: "待认领" },
	{ status: "doing", title: "进行中" },
	{ status: "blocked", title: "阻塞" },
	{ status: "done", title: "已完成" },
];

function memberName(members: readonly WebRoomMember[], sessionId: string): string {
	const member = members.find((item) => item.sessionId === sessionId);
	return member?.role === "owner" ? "你" : member?.nickname?.trim() || collaborationAlias(sessionId);
}

function TaskDetail({ task, members, controller, onClose }: {
	task: WebRoomTask;
	members: readonly WebRoomMember[];
	controller: RoomWorkspaceController;
	onClose: () => void;
}) {
	const [status, setStatus] = useState<WebRoomTaskStatus>(task.status);
	const [note, setNote] = useState("");
	const [title, setTitle] = useState(task.title);
	const [description, setDescription] = useState(task.description);
	const [assigneeSessionId, setAssigneeSessionId] = useState(task.assigneeSessionId ?? "");
	const [comment, setComment] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string>();
	useEffect(() => { setStatus(task.status); }, [task.status]);
	useEffect(() => { setAssigneeSessionId(task.assigneeSessionId ?? ""); }, [task.assigneeSessionId]);
	const changed = title.trim() !== task.title || description.trim() !== task.description || assigneeSessionId !== (task.assigneeSessionId ?? "");

	const submit = async (action: () => Promise<void>) => {
		setSubmitting(true);
		setError(undefined);
		try { await action(); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setSubmitting(false); }
	};

	return (
		<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader><DialogTitle className="pr-6">{task.title}</DialogTitle></DialogHeader>
				<div className="grid max-h-[65dvh] gap-5 overflow-y-auto py-1">
				<div className="grid gap-2">
					<label htmlFor="room-task-edit-title" className="text-sm font-medium">标题</label>
					<Input id="room-task-edit-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
					<label htmlFor="room-task-edit-description" className="text-sm font-medium">任务内容</label>
					<Textarea id="room-task-edit-description" maxLength={8000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
					<label htmlFor="room-task-assignee" className="text-sm font-medium">负责人</label>
					<select id="room-task-assignee" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={assigneeSessionId} onChange={(event) => setAssigneeSessionId(event.target.value)}>
						<option value="">待认领</option>
						{members.filter((member) => member.role === "member" && !member.leftAt).map((member) => <option key={member.sessionId} value={member.sessionId}>{memberName(members, member.sessionId)}</option>)}
					</select>
					<Button variant="outline" className="justify-self-end" disabled={submitting || !title.trim() || !changed || (task.status === "done" && assigneeSessionId !== (task.assigneeSessionId ?? ""))} onClick={() => void submit(async () => {
						await controller.editRoomTask(task.id, { title: title.trim(), description: description.trim(), assigneeSessionId: assigneeSessionId || null });
					})}>保存任务</Button>
				</div>
				{task.resultText ? <div className="grid gap-2 border-t border-border pt-3"><h3 className="text-sm font-medium">任务结果</h3><p className="whitespace-pre-wrap break-words text-sm leading-6">{task.resultText}</p></div> : null}
				{task.updates.length ? (
					<div className="grid gap-2 border-t border-border pt-3">
						<h3 className="text-sm font-medium">进展与评论</h3>
						{task.updates.map((update, index) => (
							<div key={`${update.createdAt}-${index}`} className="text-sm">
								<span className="text-muted-foreground">{memberName(members, update.actorSessionId)} · {update.kind === "comment" ? "评论" : COLUMNS.find((column) => column.status === update.status)?.title}</span>
								{update.note ? <p className="mt-1 whitespace-pre-wrap break-words">{update.note}</p> : null}
							</div>
						))}
					</div>
				) : null}
				<div className="grid gap-2 border-t border-border pt-3">
					<label htmlFor="room-task-comment" className="text-sm font-medium">评论</label>
					<Textarea id="room-task-comment" value={comment} onChange={(event) => setComment(event.target.value)} maxLength={8000} rows={2} placeholder="输入 @智能体名称 可提醒对方" />
					<Button variant="outline" className="justify-self-end" disabled={submitting || !comment.trim()} onClick={() => void submit(async () => { await controller.commentRoomTask(task.id, comment.trim()); setComment(""); })}>发送评论</Button>
				</div>
				<div className="grid gap-2 border-t border-border pt-3">
					<label htmlFor="room-task-status" className="text-sm font-medium">状态</label>
					<select id="room-task-status" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={status} onChange={(event) => setStatus(event.target.value as WebRoomTaskStatus)}>
						{COLUMNS.map((column) => <option key={column.status} value={column.status} disabled={!task.assigneeSessionId && column.status !== "todo"}>{column.title}</option>)}
					</select>
					<label htmlFor="room-task-note" className="text-sm font-medium">进展记录</label>
					<Textarea id="room-task-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={8000} rows={3} placeholder="记录进展或阻塞原因" />
					{status === "todo" && task.assigneeSessionId ? <p className="text-xs text-muted-foreground">移至待认领会释放当前负责人。</p> : null}
					<Button variant="outline" className="justify-self-end" disabled={submitting || (status === task.status && !note.trim())} onClick={() => void submit(async () => { await controller.updateRoomTask(task.id, status, note.trim() || undefined); if (status === "todo") setAssigneeSessionId(""); setNote(""); })}>保存状态</Button>
				</div>
				{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
			</div>
			<DialogFooter><Button variant="outline" onClick={onClose} disabled={submitting}>关闭</Button></DialogFooter>
		</DialogContent>
		</Dialog>
	);
}

export function RoomTaskBoard({ controller }: { controller: RoomWorkspaceController }) {
	const [createOpen, setCreateOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [selectedId, setSelectedId] = useState<string>();
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string>();
	const members = controller.selectedRoom?.members ?? [];
	const selectedTask = controller.roomTasks.find((task) => task.id === selectedId);

	const create = async () => {
		if (!title.trim()) return;
		setSubmitting(true);
		setError(undefined);
		try {
			await controller.createRoomTask(title.trim(), description.trim());
			setCreateOpen(false);
			setTitle("");
			setDescription("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center justify-between gap-3 px-5 py-4 sm:px-8">
				<h2 className="text-base font-semibold tracking-tight sm:text-lg">任务看板</h2>
				<Button className="h-9" size="sm" variant="outline" onClick={() => setCreateOpen(true)}><Plus className="size-4" aria-hidden="true" />新建任务</Button>
			</div>
			{controller.roomTasksLoading && !controller.roomTasks.length ? (
				<div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在加载任务</div>
			) : controller.roomTasksError ? (
				<div className="px-5 py-8 text-sm text-destructive" role="alert">{controller.roomTasksError}</div>
			) : (
				<div className="min-h-0 flex-1 overflow-x-auto overscroll-x-contain px-5 pb-5 sm:px-8">
					<div className="grid h-full min-w-[920px] grid-cols-4 gap-3">
						{COLUMNS.map((column) => {
							const tasks = controller.roomTasks.filter((task) => task.status === column.status);
							return (
								<section key={column.status} aria-label={column.title} className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-muted p-3 sm:p-4">
									<h3 className="mb-3 flex shrink-0 items-baseline gap-2 text-base font-semibold">{column.title}<span className="text-xs font-normal tabular-nums text-muted-foreground">{tasks.length}</span></h3>
									<div className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto">
										{tasks.map((task) => (
											<button key={task.id} type="button" onClick={() => setSelectedId(task.id)} className="min-h-24 w-full rounded-xl border border-input/65 bg-card px-3 py-3 text-left text-sm shadow-sm transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4 sm:py-4">
												<span className="block break-words font-medium sm:text-base">{task.title}</span>
												<span className="mt-2 block text-xs text-muted-foreground sm:text-sm">{task.assigneeSessionId ? memberName(members, task.assigneeSessionId) : "待认领"}</span>
											</button>
										))}
									</div>
								</section>
							);
						})}
					</div>
				</div>
			)}
			{selectedTask ? <TaskDetail key={selectedTask.id} task={selectedTask} members={members} controller={controller} onClose={() => setSelectedId(undefined)} /> : null}
			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader><DialogTitle>新建任务</DialogTitle></DialogHeader>
					<div className="grid gap-3 py-2">
						<label htmlFor="room-task-title" className="text-sm font-medium">标题</label>
						<Input id="room-task-title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
						<label htmlFor="room-task-description" className="text-sm font-medium">任务内容</label>
						<Textarea id="room-task-description" maxLength={8000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} />
						{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>取消</Button>
						<Button disabled={submitting || !title.trim()} onClick={() => void create()}>{submitting ? "创建中…" : "创建"}</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
