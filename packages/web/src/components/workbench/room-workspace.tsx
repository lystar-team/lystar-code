import { Check, CircleAlert, Clock3, Columns3, LoaderCircle, MessageSquare, Paperclip, Pencil, UserMinus, UserPlus, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import type { RoomMemberSelection, RoomWorkspaceController } from "../../state/use-room-workspace";
import type { WebRoomMember, WebRoomMessage, WebRoomSummary, WebSessionSummary } from "../../types";
import { cn } from "../../lib/utils";
import { Conversation, ConversationContent } from "../ai-elements/conversation";
import { MessageResponse } from "../ai-elements/message";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Tabs, TabsContent } from "../ui/tabs";
import { AgentProfileCard } from "./agent-profile-card";
import { AgentIdentityIcon, collaborationAlias } from "./collaboration-session";
import { mergeRoomMessages } from "./room-message-utils";
import { AgentAvatar } from "./room-workspace-agent-avatar";
import type { WorkbenchActions } from "./types";
import { RoomTaskBoard } from "./room-task-board";
import { WorkbenchTabBar, type WorkbenchTabOption } from "./workbench-tab-bar";

const ROOM_TABS: ReadonlyArray<WorkbenchTabOption<"chat" | "board">> = [
	{ icon: MessageSquare, label: "对话", value: "chat" },
	{ icon: Columns3, label: "看板", value: "board" },
];

function formatMessageTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function sessionLabel(
	session: WebSessionSummary | undefined,
	sessionId: string,
	member?: WebRoomMember,
	senderType?: WebRoomMessage["senderType"],
): string {
	if (member?.role === "owner") return senderType === "agent" ? "主智能体" : "你";
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
	projectId,
	openResource,
}: {
	message: WebRoomMessage;
	isCurrentUser: boolean;
	memberLabel: string;
	memberSession?: WebSessionSummary;
	member?: WebRoomMember;
	projectId?: string;
	openResource: WorkbenchActions["openResource"];
}) {
	return (
		<article className={cn("flex gap-2.5", isCurrentUser ? "justify-end" : "justify-start")}>
			{isCurrentUser ? null : <AgentAvatar member={member} memberSession={memberSession} />}
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
					{message.senderType === "agent" ? (
						<MessageResponse
							className="sd-prose min-w-0 max-w-full break-words text-sm leading-6"
							controls={{ code: { copy: true, download: true }, table: { copy: true, download: true } }}
							linkSafety={{ enabled: true }}
							onOpenPath={(path) => void openResource(path)}
							projectId={projectId}
						>
							{message.body || " "}
						</MessageResponse>
					) : (
						<p className="whitespace-pre-wrap break-words">{message.body}</p>
					)}
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

function PendingAgentBubble({
	pending,
	memberLabel,
	memberSession,
	member,
}: {
	pending: RoomWorkspaceController["pendingAgentReplies"][number];
	memberLabel: string;
	memberSession?: WebSessionSummary;
	member?: WebRoomMember;
}) {
	return (
		<article className="flex gap-2.5" aria-label={`${memberLabel}正在处理`}>
			<AgentAvatar member={member} memberSession={memberSession} />
			<div className="flex max-w-[min(78%,680px)] flex-col items-start">
				<div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="font-medium text-foreground">{memberLabel}</span>
					<span>{formatMessageTime(pending.createdAt)}</span>
				</div>
				<div
					className="flex min-w-0 items-center gap-2 rounded-2xl rounded-bl-md border border-border/70 bg-background px-3.5 py-2.5 text-sm leading-6 text-muted-foreground shadow-sm"
					role="status"
				>
					<LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
					<span className="min-w-0 break-words">消息已发送，等待回复。</span>
				</div>
			</div>
		</article>
	);
}

function InviteAgentDialog({
	open,
	onOpenChange,
	profiles,
	profilesLoading,
	onInvite,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
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

	useEffect(() => {
		if (!open) return;
		setError(undefined);
		setSelection(profileCandidates[0]?.name ?? "");
	}, [open, profileCandidates]);

	const submit = async () => {
		const profile = profileCandidates.find((candidate) => candidate.name === selection);
		if (!profile) {
			setError("请选择智能体");
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
					<DialogTitle>添加智能体</DialogTitle>
					<DialogDescription>从智能体配置创建新的 Room 成员。加入后会从昵称库分配运行时昵称。</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3 py-2">
					{profilesLoading ? (
						<div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">正在加载智能体配置</div>
					) : profileCandidates.length ? (
						<div className="grid max-h-[min(58dvh,520px)] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
							{profileCandidates.map((profile) => (
								<AgentProfileCard
									key={`${profile.scope}:${profile.name}`}
									profile={profile}
									selected={selection === profile.name}
									disabled={submitting}
									onClick={() => setSelection(profile.name)}
								/>
							))}
						</div>
					) : (
						<div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">当前项目没有可用的智能体配置</div>
					)}
					{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>取消</Button>
					<Button disabled={submitting || !selection} onClick={() => void submit()}>
						{submitting ? "添加中…" : "添加到 Room"}
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
	openResource,
	section,
	onSectionChange,
}: {
	state: WorkbenchState;
	controller: RoomWorkspaceController;
	onModeChange: () => void;
	openResource: WorkbenchActions["openResource"];
	section: "chat" | "board";
	onSectionChange: (section: "chat" | "board") => void;
}) {
	const selectedProject = state.projects.find((project) => project.id === controller.selectedRoomProjectId);
	const memberSessions = useMemo(() => {
		const sessions = selectedProject?.sessions ?? [];
		return new Map<string, WebSessionSummary>(sessions.map((session) => [session.id, session]));
	}, [selectedProject?.sessions]);
	const currentRoom = controller.selectedRoom;
	const [inviteOpen, setInviteOpen] = useState(false);
	const [removeTarget, setRemoveTarget] = useState<{ roomId: string; member: WebRoomMember }>();
	const [removing, setRemoving] = useState(false);
	const [removeError, setRemoveError] = useState<string>();
	const [renameTarget, setRenameTarget] = useState<{ roomId: string; member: WebRoomMember }>();
	const [renameDraft, setRenameDraft] = useState("");
	const [renameError, setRenameError] = useState<string>();
	const [renaming, setRenaming] = useState(false);
	const profilesByName = useMemo(
		() => new Map(controller.agentProfiles.map((profile) => [profile.name, profile])),
		[controller.agentProfiles],
	);
	const activeMembers = useMemo(
		() => currentRoom?.members.filter((member) => !member.leftAt) ?? [],
		[currentRoom?.members],
	);

	useEffect(() => {
		setRemoveTarget(undefined);
		setRemoveError(undefined);
		setRenameTarget(undefined);
		setRenameError(undefined);
	}, [currentRoom?.room.id, controller.selectedRoomProjectId]);

	const confirmRemove = async () => {
		if (!removeTarget || removing || removeTarget.roomId !== currentRoom?.room.id) return;
		setRemoving(true);
		setRemoveError(undefined);
		try {
			await controller.leaveRoomMember(removeTarget.member.sessionId);
			setRemoveTarget(undefined);
		} catch (cause) {
			setRemoveError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRemoving(false);
		}
	};

	const submitRename = async () => {
		if (!renameTarget || renaming || renameTarget.roomId !== currentRoom?.room.id) return;
		const nickname = renameDraft.trim();
		if (!nickname) {
			setRenameError("请输入昵称");
			return;
		}
		setRenaming(true);
		setRenameError(undefined);
		try {
			await controller.renameRoomMember(renameTarget.member.sessionId, nickname);
			setRenameTarget(undefined);
		} catch (cause) {
			setRenameError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRenaming(false);
		}
	};

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
		<Tabs
			value={section}
			onValueChange={(value) => onSectionChange(value as "chat" | "board")}
			className="min-h-0 flex-1 gap-0 overflow-hidden @container/room-workspace"
		>
			<div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2 sm:px-8 @min-[48rem]/room-workspace:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)_minmax(0,1fr)]">
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-sm font-medium">
						<span>Room 成员</span>
						<span className="text-xs font-normal text-muted-foreground">{activeMembers.length} 位</span>
					</div>
					<div className="mt-1 flex min-w-0 flex-wrap gap-1.5">
						{activeMembers.map((member) => {
							const memberSession = memberSessions.get(member.sessionId);
							const label = sessionLabel(memberSession, member.sessionId, member);
							const profileName = member.profileName?.trim() || member.profileId?.trim();
							const profile = profilesByName.get(member.profileId ?? member.profileName ?? "");
							const configurationLabel = profile?.fileName
								? `配置文件：${profile.fileName}`
								: profile?.scope === "builtin"
									? `内置配置：${profileName ?? profile.name}`
									: profileName
										? `配置名称：${profileName}`
										: "配置名称：未记录";
							const chip = (
								<>
									<AgentIdentityIcon member={member} session={memberSession} className="size-3.5 object-contain" />
									{label}
								</>
							);
							const chipClassName = "room-member-chip flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground";
							return member.role === "owner" ? (
								<span className={chipClassName} key={member.sessionId}>{chip}</span>
							) : (
								<DropdownMenu key={member.sessionId}>
									<DropdownMenuTrigger asChild>
										<button
											aria-label={`管理智能体 ${label}（${member.profileName ?? member.profileId ?? "协作智能体"}）`}
											className={cn(chipClassName, "hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
											title={member.profileName ?? undefined}
											type="button"
										>
											{chip}
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start">
										<DropdownMenuLabel className="max-w-56 break-all text-xs font-normal text-muted-foreground">
											{configurationLabel}
										</DropdownMenuLabel>
										<DropdownMenuItem onSelect={() => {
											setRenameTarget({ roomId: currentRoom.room.id, member });
											setRenameDraft(label);
											setRenameError(undefined);
										}}>
											<Pencil className="size-4" aria-hidden="true" />
											改名
										</DropdownMenuItem>
										<DropdownMenuItem
											variant="destructive"
											onSelect={() => {
												setRemoveTarget({ roomId: currentRoom.room.id, member });
												setRemoveError(undefined);
											}}
										>
											<UserMinus className="size-4" aria-hidden="true" />
											移除智能体
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							);
						})}
					</div>
				</div>
				<div className="col-span-2 row-start-2 w-full max-w-72 justify-self-center @min-[48rem]/room-workspace:col-span-1 @min-[48rem]/room-workspace:col-start-2 @min-[48rem]/room-workspace:row-start-1">
					<WorkbenchTabBar activeId={section} tabs={ROOM_TABS} label="Room 视图" className="!w-full" />
				</div>
				<Button
					className="col-start-2 row-start-1 shrink-0 justify-self-end px-2 @min-[48rem]/room-workspace:col-start-3"
					variant="outline"
					size="sm"
					aria-label="添加智能体"
					onClick={() => setInviteOpen(true)}
				>
					<UserPlus className="size-3.5" aria-hidden="true" />
					<span className="hidden @min-[32rem]/room-workspace:inline">添加智能体</span>
				</Button>
			</div>
				<TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
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
						) : controller.selectedRoomMessages.length ||
							controller.pendingAgentReplies.some(
								(pending) =>
									pending.projectId === controller.selectedRoomProjectId &&
									pending.roomId === currentRoom.room.id &&
									activeMembers.some((member) => member.sessionId === pending.sessionId),
							) ? (
							<>
								{controller.selectedRoomMessages.map((message) => {
									const member = currentRoom.members.find((candidate) => candidate.sessionId === message.senderSessionId);
									return (
										<MessageBubble
											isCurrentUser={message.senderType === "user"}
											key={message.id}
											member={member}
											memberLabel={sessionLabel(
												memberSessions.get(message.senderSessionId),
												message.senderSessionId,
												member,
												message.senderType,
											)}
											memberSession={memberSessions.get(message.senderSessionId)}
											message={message}
											projectId={controller.selectedRoomProjectId}
											openResource={openResource}
										/>
									);
								})}
								{controller.pendingAgentReplies
									.filter(
										(pending) =>
											pending.projectId === controller.selectedRoomProjectId &&
											pending.roomId === currentRoom.room.id &&
											activeMembers.some((member) => member.sessionId === pending.sessionId),
									)
									.map((pending) => {
										const member = activeMembers.find((candidate) => candidate.sessionId === pending.sessionId);
										const memberSession = memberSessions.get(pending.sessionId);
										return (
											<PendingAgentBubble
												key={`${pending.requestMessageId}:${pending.sessionId}`}
												pending={pending}
												member={member}
												memberLabel={sessionLabel(memberSession, pending.sessionId, member, "agent")}
												memberSession={memberSession}
											/>
										);
									})}
							</>
						) : (
							<div className="py-12 text-center text-sm text-muted-foreground">还没有消息，发送第一条协作消息。</div>
						)}
				</ConversationContent>
					</Conversation>
				</TabsContent>
				<TabsContent value="board" className="flex min-h-0 flex-1 flex-col">
					<RoomTaskBoard controller={controller} />
				</TabsContent>
			<InviteAgentDialog
				open={inviteOpen}
				onOpenChange={setInviteOpen}
				profiles={controller.agentProfiles}
				profilesLoading={controller.agentProfilesLoading}
				onInvite={controller.inviteRoomMember}
			/>
			<Dialog
				open={Boolean(renameTarget && renameTarget.roomId === currentRoom.room.id)}
				onOpenChange={(open) => {
					if (!open && !renaming) setRenameTarget(undefined);
				}}
			>
				<DialogContent className="sm:max-w-md">
					<form onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
						<DialogHeader>
							<DialogTitle>智能体改名</DialogTitle>
							<DialogDescription>修改这个 Room 中的昵称，不影响智能体配置文件。</DialogDescription>
						</DialogHeader>
						<label className="mt-4 block text-sm font-medium" htmlFor="room-member-nickname">昵称</label>
						<Input id="room-member-nickname" className="mt-2" maxLength={128} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} />
						{renameError ? <p className="mt-2 text-sm text-destructive" role="alert">{renameError}</p> : null}
						<DialogFooter className="mt-5">
							<Button type="button" variant="outline" disabled={renaming} onClick={() => setRenameTarget(undefined)}>取消</Button>
							<Button type="submit" disabled={renaming || !renameDraft.trim()}>{renaming ? "保存中…" : "保存"}</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<Dialog
				open={Boolean(removeTarget && removeTarget.roomId === currentRoom.room.id)}
				onOpenChange={(open) => {
					if (!open && !removing) {
						setRemoveTarget(undefined);
						setRemoveError(undefined);
					}
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>移除智能体</DialogTitle>
						<DialogDescription>
							将 {removeTarget ? sessionLabel(memberSessions.get(removeTarget.member.sessionId), removeTarget.member.sessionId, removeTarget.member) : ""}
							（{removeTarget?.member.profileName ?? removeTarget?.member.profileId ?? "协作智能体"}）移出 Room？
							未完成任务回到待认领；会话和历史消息保留，正在运行的回合不会强制停止。
						</DialogDescription>
					</DialogHeader>
					{removeError ? <p className="text-sm text-destructive" role="alert">{removeError}</p> : null}
					<DialogFooter>
						<Button variant="outline" disabled={removing} onClick={() => setRemoveTarget(undefined)}>取消</Button>
						<Button variant="destructive" disabled={removing} onClick={() => void confirmRemove()}>
							{removing ? "移除中…" : "移除"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Tabs>
	);
}
