import { Clock3, Folder, LoaderCircle, Pencil, Pin, Trash2 } from "lucide-react";
import type { DragEvent as ReactDragEvent } from "react";
import { memo, useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { sessionTitle } from "../../state/use-workbench";
import type { WebSessionSummary } from "../../types";
import { Button } from "../ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "../ui/context-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { Input } from "../ui/input";
import {
	AgentIdentityIcon,
	collaborationAgentType,
	collaborationAlias,
	isCollaborationSession,
} from "./collaboration-session";

const SESSION_TITLE_MAX_LENGTH = 40;

export function truncateSessionTitle(title: string): string {
	const characters = Array.from(title);
	return characters.length > SESSION_TITLE_MAX_LENGTH
		? `${characters.slice(0, SESSION_TITLE_MAX_LENGTH).join("")}...`
		: title;
}

function formatSessionAge(timestamp: number): string {
	const elapsed = Math.max(0, Date.now() - timestamp);
	const minute = 60 * 1000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (elapsed < minute) return "刚刚";
	if (elapsed < hour) return `${Math.floor(elapsed / minute)} 分钟`;
	if (elapsed < day) return `${Math.floor(elapsed / hour)} 小时`;
	if (elapsed < 30 * day) return `${Math.floor(elapsed / day)} 天`;
	if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))} 个月`;
	return `${Math.floor(elapsed / (365 * day))} 年`;
}

function formatSessionDate(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(timestamp);
}

export interface SessionButtonProps {
	projectName: string;
	session: WebSessionSummary;
	active: boolean;
	running: boolean;
	unread: boolean;
	onClick: () => void;
	onRename: (name: string) => Promise<void>;
	onContextRename: () => void;
	onTogglePinned: () => void;
	onDelete: () => void;
	dragging: boolean;
	dropTarget: boolean;
	dropPosition?: "before" | "after";
	onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
	onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
	onDrop: (event: ReactDragEvent<HTMLElement>) => void;
	onDragEnd: () => void;
}

function SessionButtonComponent({
	projectName,
	session,
	active,
	running,
	unread,
	onClick,
	onRename,
	onContextRename,
	onTogglePinned,
	onDelete,
	dragging,
	dropTarget,
	dropPosition,
	onDragStart,
	onDragOver,
	onDrop,
	onDragEnd,
}: SessionButtonProps) {
	const title = sessionTitle(session);
	const displayTitle = truncateSessionTitle(title);
	const [editingTitle, setEditingTitle] = useState(false);
	const [renameDraft, setRenameDraft] = useState(title);
	const relativeTime = formatSessionAge(session.updatedAt);
	const absoluteTime = formatSessionDate(session.updatedAt);
	const collaboration = isCollaborationSession(session);
	const agentSession = !collaboration && Boolean(session.profileId);
	const profileName = session.profileName?.trim() || "智能体";
	const alias = collaborationAlias(session.id);
	const agentType = collaborationAgentType(session);

	useEffect(() => {
		if (!editingTitle) setRenameDraft(title);
	}, [editingTitle, title]);

	const cancelRename = () => {
		setRenameDraft(title);
		setEditingTitle(false);
	};

	const commitRename = async () => {
		const name = renameDraft.trim();
		if (!name) {
			cancelRename();
			return;
		}
		await onRename(name);
		setEditingTitle(false);
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<li
					className={cn(
						"group/session list-none relative min-w-0 rounded-md",
						dragging && "opacity-50",
						dropTarget && "ring-1 ring-primary/50",
						dropPosition === "before" &&
							"before:pointer-events-none before:absolute before:-top-1 before:right-0 before:left-0 before:z-10 before:h-0.5 before:rounded-full before:bg-border",
						dropPosition === "after" &&
							"after:pointer-events-none after:absolute after:right-0 after:-bottom-1 after:left-0 after:z-10 after:h-0.5 after:rounded-full after:bg-border",
					)}
					draggable={!collaboration}
					onDragStart={onDragStart}
					onDragOver={onDragOver}
					onDrop={onDrop}
					onDragEnd={onDragEnd}
				>
					<HoverCard openDelay={140} closeDelay={80}>
						<HoverCardTrigger asChild>
							<Button
								className={cn(
									"mobile-session-button h-8 w-full min-w-0 justify-start gap-2 py-1 pr-8 text-left text-xs",
									collaboration || agentSession ? "!pl-10" : "!pl-8",
								)}
								variant={active ? "secondary" : "ghost"}
								onClick={onClick}
							>
								{collaboration || agentSession ? (
									<AgentIdentityIcon
										session={session}
										className="size-3.5 shrink-0 object-contain text-muted-foreground"
									/>
								) : null}
								<span className="project-list-item-label min-w-0 flex-1 truncate">
									{collaboration ? (
										<>
											<span className="font-medium text-foreground">{alias}</span>
											<span className="text-muted-foreground"> · {displayTitle}</span>
										</>
									) : agentSession ? (
										<>
											<span className="font-medium text-foreground">{profileName}</span>
											<span className="text-muted-foreground"> · {displayTitle}</span>
										</>
									) : (
										displayTitle
									)}
								</span>
								<span className="mobile-session-status absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center gap-1 transition-opacity group-hover/session:opacity-0">
									{session.pinned ? (
										<Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="已置顶" />
									) : null}
									{running ? (
										<LoaderCircle
											className="size-3.5 shrink-0 animate-spin text-primary"
											aria-label="会话进行中"
										/>
									) : unread ? (
										<span
											role="img"
											className="size-2 shrink-0 rounded-full bg-blue-500 ring-2 ring-blue-500/20"
											aria-label="有新的会话内容"
											title="有新的会话内容"
										/>
									) : null}
								</span>
							</Button>
						</HoverCardTrigger>
						<HoverCardContent
							side="right"
							align="start"
							sideOffset={8}
							className="w-max min-w-72 max-w-[calc(100vw-1rem)] rounded-xl border-border bg-background px-4 py-3 shadow-[0_2px_8px_rgb(0_0_0/0.05)]"
							onPointerDown={(event) => event.stopPropagation()}
						>
								<div className="flex items-start justify-between gap-4 whitespace-nowrap">
									{editingTitle ? (
										<Input
											aria-label="会话名称"
											autoFocus
											className="project-list-item-label h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 shadow-sm transition-[border-color,box-shadow,background-color] duration-150 focus-visible:border-input focus-visible:ring-0"
											value={renameDraft}
											onChange={(event) => setRenameDraft(event.target.value)}
											onClick={(event) => event.stopPropagation()}
											onBlur={() => void commitRename()}
											onKeyDown={(event) => {
												if (event.key === "Enter") {
													event.preventDefault();
													event.currentTarget.blur();
												}
												if (event.key === "Escape") {
													event.preventDefault();
													event.stopPropagation();
													cancelRename();
												}
											}}
											placeholder="输入会话名称"
										/>
									) : (
										<button
											type="button"
											className="project-list-item-label min-w-0 max-w-[calc(100vw-3rem)] flex-1 cursor-text truncate whitespace-nowrap bg-transparent p-0 text-left text-foreground"
											onClick={() => {
												setRenameDraft(title);
												setEditingTitle(true);
											}}
										>
											{displayTitle}
										</button>
									)}
									<div className="flex shrink-0 items-start gap-2">
										<time
											className="shrink-0 pt-1 text-xs text-muted-foreground"
											dateTime={new Date(session.updatedAt).toISOString()}
											title={absoluteTime}
										>
											{relativeTime}
										</time>
										<Button
											aria-label={session.pinned ? "取消置顶会话" : "置顶会话"}
											size="icon-sm"
											variant="ghost"
											onClick={(event) => {
												event.stopPropagation();
												onTogglePinned();
											}}
										>
											<Pin className={cn("size-3.5", session.pinned && "text-primary")} />
										</Button>
									</div>
								</div>
							<div className="mt-3 grid gap-2 whitespace-nowrap text-xs text-muted-foreground">
								{collaboration || agentSession ? (
									<div className="flex min-w-0 items-center gap-2">
										<AgentIdentityIcon session={session} className="size-3.5 shrink-0 object-contain" />
										<span className="truncate">
											{collaboration ? `${alias} · ${agentType}` : `${profileName} · 智能体会话`}
										</span>
									</div>
								) : null}
								<div className="flex min-w-0 items-center gap-2">
									<Folder className="size-3.5 shrink-0" />
									<span className="truncate">{projectName}</span>
								</div>
								<div className="flex min-w-0 items-center gap-2">
									<Clock3 className="size-3.5 shrink-0" />
									<span className="truncate">最后回复 {absoluteTime}</span>
								</div>
							</div>
						</HoverCardContent>
					</HoverCard>
					<Button
						aria-label={`删除会话：${title}`}
						className="mobile-hover-action pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/session:pointer-events-auto group-hover/session:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
						draggable={false}
						size="icon-sm"
						variant="ghost"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							onDelete();
						}}
					>
						<Trash2 className="size-3.5" />
					</Button>
				</li>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-48">
				<ContextMenuItem onSelect={onContextRename}>
					<Pencil className="size-4" />
					重命名
				</ContextMenuItem>
				<ContextMenuItem onSelect={onTogglePinned}>
					<Pin className="size-4" />
					{session.pinned ? "取消置顶" : "置顶会话"}
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
					<Trash2 className="size-4" />
					删除会话
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export const SessionButton = memo(SessionButtonComponent);
