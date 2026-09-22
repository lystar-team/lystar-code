import { Bot, Check, CircleAlert, Clock3, LoaderCircle, MessageSquare, Wrench } from "lucide-react";
import { useMemo } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import type { RoomWorkspaceController } from "../../state/use-room-workspace";
import type { WebRoomMessage, WebSessionSummary } from "../../types";
import { cn } from "../../lib/utils";
import { Conversation, ConversationContent } from "../ai-elements/conversation";
import { Button } from "../ui/button";
import { collaborationAgentIconForSession, collaborationAlias } from "./collaboration-session";

function formatMessageTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function sessionLabel(session: WebSessionSummary | undefined, sessionId: string): string {
	if (!session) return collaborationAlias(sessionId);
	return session.profileName?.trim() || session.name?.trim() || collaborationAlias(session.id);
}

function messageKindLabel(message: WebRoomMessage): string | undefined {
	switch (message.kind) {
		case "task":
			return "任务";
		case "status":
			return "状态";
		case "result":
			return "结果";
		case "system":
			return "系统";
		default:
			return undefined;
	}
}

function ActivityRow({ message }: { message: WebRoomMessage }) {
	const label = messageKindLabel(message);
	if (!label) return null;
	const Icon = message.kind === "result" ? Check : message.kind === "status" ? Clock3 : Wrench;
	return (
		<div className="mt-2 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/45 px-2.5 py-2 text-xs text-muted-foreground">
			<Icon className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="font-medium text-foreground">{label}</span>
			<span className="min-w-0 truncate">{message.body}</span>
			{message.kind === "result" ? <Check className="ml-auto size-3.5 shrink-0 text-[var(--success)]" /> : null}
		</div>
	);
}

function MessageBubble({
	message,
	isCurrentUser,
	memberLabel,
	memberSession,
}: {
	message: WebRoomMessage;
	isCurrentUser: boolean;
	memberLabel: string;
	memberSession?: WebSessionSummary;
}) {
	const MemberIcon = memberSession ? collaborationAgentIconForSession(memberSession) : Bot;
	return (
		<article className={cn("flex gap-2.5", isCurrentUser ? "justify-end" : "justify-start")}>
			{isCurrentUser ? null : (
				<div className="mt-1 grid size-8 shrink-0 place-items-center rounded-full border border-border/70 bg-muted text-muted-foreground">
					<MemberIcon className="size-4" aria-hidden="true" />
				</div>
			)}
			<div className={cn("flex max-w-[min(78%,680px)] flex-col", isCurrentUser ? "items-end" : "items-start")}>
				<div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="font-medium text-foreground">{isCurrentUser ? "你" : memberLabel}</span>
					<span>{formatMessageTime(message.createdAt)}</span>
				</div>
				<div
					className={cn(
						"rounded-2xl px-3.5 py-2.5 text-sm leading-6 shadow-sm",
						isCurrentUser
							? "rounded-br-md bg-foreground text-background"
							: "rounded-bl-md border border-border/70 bg-background text-foreground",
					)}
				>
					<p className="whitespace-pre-wrap break-words">{message.body}</p>
					<ActivityRow message={message} />
				</div>
			</div>
			{isCurrentUser ? (
				<div className="mt-1 grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background">
					<MessageSquare className="size-4" aria-hidden="true" />
				</div>
			) : null}
		</article>
	);
}

export function RoomWorkspace({
	state,
	controller,
	onModeChange,
}: {
	state: WorkbenchState;
	controller: RoomWorkspaceController;
	onModeChange: () => void;
}) {
	const selectedProject = state.projects.find((project) => project.id === controller.selectedRoomProjectId);
	const memberSessions = useMemo(() => {
		const sessions = selectedProject?.sessions ?? [];
		return new Map<string, WebSessionSummary>(sessions.map((session) => [session.id, session]));
	}, [selectedProject?.sessions]);
	const currentRoom = controller.selectedRoom;
	const currentSessionId = state.sessionId;

	if (!currentRoom) {
		return (
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
				<div className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
					<MessageSquare className="size-5" aria-hidden="true" />
				</div>
				<h2 className="mt-4 text-base font-semibold">选择一个 Room</h2>
				<p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
					Room 按项目归属显示在左侧。选择后可以查看成员消息并继续协作。
				</p>
				<Button className="mt-4" variant="outline" onClick={onModeChange}>
					返回会话
				</Button>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<Conversation className="min-h-0 flex-1">
				<ConversationContent className="mx-auto w-full max-w-[var(--conversation-width)] gap-5 px-5 py-6 sm:px-8">
					{controller.roomMessagesLoading ? (
							<div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" role="status">
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
								正在加载 Room 消息
							</div>
						) : controller.roomMessagesError ? (
							<div className="flex items-center justify-center gap-2 py-12 text-sm text-destructive" role="alert">
								<CircleAlert className="size-4" aria-hidden="true" />
								{controller.roomMessagesError}
							</div>
						) : controller.selectedRoomMessages.length ? (
							controller.selectedRoomMessages.map((message) => (
								<MessageBubble
									isCurrentUser={message.senderSessionId === currentSessionId}
									key={message.id}
									memberLabel={sessionLabel(memberSessions.get(message.senderSessionId), message.senderSessionId)}
									memberSession={memberSessions.get(message.senderSessionId)}
									message={message}
								/>
							))
						) : (
							<div className="py-12 text-center text-sm text-muted-foreground">还没有消息，发送第一条协作消息。</div>
						)}
				</ConversationContent>
			</Conversation>
		</div>
	);
}
