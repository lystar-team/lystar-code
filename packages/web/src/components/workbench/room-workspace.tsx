import { Bot, Check, CircleAlert, Clock3, LoaderCircle, MessageSquare, Paperclip, UserPlus, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import type { RoomMemberSelection, RoomWorkspaceController } from "../../state/use-room-workspace";
import type { WebRoomMember, WebRoomMessage, WebRoomSummary, WebSessionSummary } from "../../types";
import { cn } from "../../lib/utils";
import { Conversation, ConversationContent } from "../ai-elements/conversation";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { AgentProfileCard } from "./agent-profile-card";
import { AgentIdentityIcon, collaborationAlias } from "./collaboration-session";

function formatMessageTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function sessionLabel(
	session: WebSessionSummary | undefined,
	sessionId: string,
	member?: WebRoomMember,
): string {
	if (member?.role === "owner") return "你";
	return member?.nickname?.trim() || collaborationAlias(session?.id ?? sessionId);
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
	member,
}: {
	message: WebRoomMessage;
	isCurrentUser: boolean;
	memberLabel: string;
	memberSession?: WebSessionSummary;
	member?: WebRoomMember;
}) {
	const memberIcon = memberSession || member ? (
		<AgentIdentityIcon member={member} session={memberSession} className="size-4 object-contain" />
	) : (
		<Bot className="size-4" aria-hidden="true" />
	);
	return (
		<article className={cn("flex gap-2.5", isCurrentUser ? "justify-end" : "justify-start")}>
			{isCurrentUser ? null : (
				<div className="mt-1 grid size-8 shrink-0 place-items-center rounded-full border border-border/70 bg-muted text-muted-foreground">
							{memberIcon}
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
					{message.attachments?.length ? (
						<ul className="mt-2 flex flex-wrap gap-1.5" aria-label="附件">
							{message.attachments.map((attachment) => (
								<li key={attachment.path} className="flex min-w-0 items-center gap-1 rounded-md border border-current/20 px-2 py-0.5 text-xs">
									<Paperclip className="size-3 shrink-0" aria-hidden="true" />
									<span className="max-w-52 truncate" title={attachment.filename}>{attachment.filename}</span>
								</li>
							))}
						</ul>
					) : null}
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

function InviteAgentDialog({
	open,
	onOpenChange,
	room,
	profiles,
	profilesLoading,
	onInvite,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	room: WebRoomSummary;
	profiles: RoomWorkspaceController["agentProfiles"];
	profilesLoading: boolean;
	onInvite: (member: RoomMemberSelection) => Promise<void>;
}) {
	const [selection, setSelection] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string>();
	const profileCandidates = useMemo(
		() => [...new Map(profiles.map((profile) => [profile.name, profile])).values()],
		[profiles],
	);
	const activeProfileIds = useMemo(
		() => new Set(room.members.filter((member) => !member.leftAt && member.profileId).map((member) => member.profileId)),
		[room.members],
	);

	useEffect(() => {
		if (!open) return;
		setError(undefined);
		setSelection(profileCandidates.find((profile) => !activeProfileIds.has(profile.name))?.name ?? "");
	}, [activeProfileIds, open, profileCandidates]);

	const submit = async () => {
		const profile = profileCandidates.find((candidate) => candidate.name === selection);
		if (!profile || activeProfileIds.has(profile.name)) {
			setError("请选择尚未加入 Room 的智能体");
			return;
		}
		const member: RoomMemberSelection = {
			profileId: profile.name,
			profileName: profile.name,
			...(profile.icon ? { profileIcon: profile.icon } : {}),
		};
		setSubmitting(true);
		setError(undefined);
		try {
			await onInvite(member);
			onOpenChange(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>邀请 Agent</DialogTitle>
					<DialogDescription>从智能体配置创建新的 Room 成员。加入后会从昵称库分配运行时昵称。</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3 py-2">
					{profilesLoading ? (
						<div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">正在加载智能体配置</div>
					) : profileCandidates.length ? (
						<div className="grid max-h-[min(58dvh,520px)] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
							{profileCandidates.map((profile) => {
								const active = activeProfileIds.has(profile.name);
								return (
									<AgentProfileCard
										key={`${profile.scope}:${profile.name}`}
										profile={profile}
										selected={selection === profile.name}
										disabled={submitting || active}
										status={active ? "已加入" : undefined}
										onClick={() => setSelection(profile.name)}
									/>
								);
							})}
						</div>
					) : (
						<div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">当前项目没有可用的智能体配置</div>
					)}
					{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
					<Button disabled={submitting || !selection || profileCandidates.every((profile) => activeProfileIds.has(profile.name))} onClick={() => void submit()}>
						{submitting ? "邀请中…" : "邀请并加入"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
	const [inviteOpen, setInviteOpen] = useState(false);
	const activeMembers = useMemo(
		() => currentRoom?.members.filter((member) => !member.leftAt) ?? [],
		[currentRoom?.members],
	);

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
			<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 py-3 sm:px-8">
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-sm font-medium">
						<span>Room 成员</span>
						<span className="text-xs font-normal text-muted-foreground">{activeMembers.length} 位</span>
					</div>
					<div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
		{activeMembers.map((member) => (
			<span
				className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
				key={member.sessionId}
				title={member.profileName ?? undefined}
			>
				<AgentIdentityIcon member={member} session={memberSessions.get(member.sessionId)} className="size-3.5 object-contain" />
				{sessionLabel(memberSessions.get(member.sessionId), member.sessionId, member)}
			</span>
		))}
					</div>
				</div>
				<Button className="shrink-0" variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
					<UserPlus className="size-3.5" aria-hidden="true" />
					邀请 Agent
				</Button>
			</div>
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
									isCurrentUser={message.senderType === "user" || message.senderSessionId === currentSessionId}
									key={message.id}
									member={currentRoom.members.find((member) => member.sessionId === message.senderSessionId)}
									memberLabel={sessionLabel(
										memberSessions.get(message.senderSessionId),
										message.senderSessionId,
										currentRoom.members.find((member) => member.sessionId === message.senderSessionId),
									)}
									memberSession={memberSessions.get(message.senderSessionId)}
									message={message}
								/>
							))
						) : (
							<div className="py-12 text-center text-sm text-muted-foreground">还没有消息，发送第一条协作消息。</div>
						)}
				</ConversationContent>
			</Conversation>
			<InviteAgentDialog
				open={inviteOpen}
				onOpenChange={setInviteOpen}
				room={currentRoom}
				profiles={controller.agentProfiles}
				profilesLoading={controller.agentProfilesLoading}
				onInvite={controller.inviteRoomMember}
			/>
		</div>
	);
}
