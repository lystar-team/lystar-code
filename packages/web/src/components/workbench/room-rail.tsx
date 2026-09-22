import { ChevronDown, FolderTree, LogOut, Plus, Search, SunMoon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import { cn } from "../../lib/utils";
import { sessionTitle, type WorkbenchState } from "../../state/use-workbench";
import type { RoomMemberSelection, RoomProjectList } from "../../state/use-room-workspace";
import type { SubagentConfig, WebProject, WebRoomSummary } from "../../types";
import { BrandLogo } from "../brand-logo";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select";
import { ProductUpdateControl } from "./product-update-control";
import type { WorkbenchActions } from "./types";
import { WorkspaceModeSwitch, type WorkspaceMode } from "./workspace-mode-switch";

function roomPreview(summary: WebRoomSummary): string {
	return `${summary.members.filter((member) => member.leftAt === undefined).length} 位成员 · ${summary.latestSeq} 条消息`;
}

export function RoomRail({
	state,
	actions,
	projects,
	roomProjects,
	roomsLoading,
	roomsError,
	selectedRoomId,
	onSelectRoom,
	onCreateRoom,
	onModeChange,
	onNavigate,
}: {
	state: WorkbenchState;
	actions: WorkbenchActions;
	projects: WebProject[];
	roomProjects: RoomProjectList[];
	roomsLoading: boolean;
	roomsError?: string;
	selectedRoomId?: string;
	onSelectRoom: (projectId: string, summary: WebRoomSummary) => void;
	onCreateRoom?: (projectId: string, title: string, member: RoomMemberSelection) => Promise<void>;
	onModeChange: (mode: WorkspaceMode) => void;
	onNavigate?: () => void;
}) {
	const [query, setQuery] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [createProjectId, setCreateProjectId] = useState(state.currentProjectId ?? projects[0]?.id ?? "");
	const [createMemberSelection, setCreateMemberSelection] = useState("");
	const [createTitle, setCreateTitle] = useState("");
	const [creating, setCreating] = useState(false);
	const [agentProfiles, setAgentProfiles] = useState<SubagentConfig[]>([]);
	const [agentProfilesLoading, setAgentProfilesLoading] = useState(false);
	const [agentProfilesError, setAgentProfilesError] = useState<string>();
	const createProject = projects.find((project) => project.id === createProjectId);
	const createOwnerSessionId =
		createProject?.sessions.find((session) => session.id === state.sessionId)?.id ?? createProject?.sessions[0]?.id;
	const createMemberCandidates = createProject?.sessions.filter((session) => session.id !== createOwnerSessionId) ?? [];
	const effectiveAgentProfiles = useMemo(
		() => [...new Map(agentProfiles.map((profile) => [profile.name, profile])).values()],
		[agentProfiles],
	);
	const [openProjects, setOpenProjects] = useState<Set<string>>(
		() => new Set(roomProjects.map(({ project }) => project.id)),
	);
	const normalizedQuery = query.trim().toLowerCase();
	const filteredProjects = useMemo(
		() =>
			roomProjects
				.map(({ project, rooms }) => ({
					project,
					rooms: normalizedQuery
						? rooms.filter((summary) => `${summary.room.title} ${roomPreview(summary)}`.toLowerCase().includes(normalizedQuery))
						: rooms,
				}))
				.filter(({ project, rooms }) => rooms.length > 0 || project.name.toLowerCase().includes(normalizedQuery)),
		[normalizedQuery, roomProjects],
	);

	useEffect(() => {
		if (!createOpen || !createProjectId) return;
		let cancelled = false;
		setAgentProfilesLoading(true);
		setAgentProfilesError(undefined);
		void webApi
			.subagentConfigs(createProjectId)
			.then((response) => {
				if (!cancelled) setAgentProfiles(response.subagents);
			})
			.catch((error) => {
				if (cancelled) return;
				setAgentProfiles([]);
				setAgentProfilesError(error instanceof Error ? error.message : "智能体配置加载失败");
			})
			.finally(() => {
				if (!cancelled) setAgentProfilesLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [createOpen, createProjectId]);

	const openCreateDialog = () => {
		const projectId = state.currentProjectId ?? projects[0]?.id ?? "";
		const project = projects.find((candidate) => candidate.id === projectId);
		const ownerSessionId = project?.sessions.find((session) => session.id === state.sessionId)?.id ?? project?.sessions[0]?.id;
		setCreateProjectId(projectId);
		const firstMemberSessionId = project?.sessions.find((session) => session.id !== ownerSessionId)?.id;
		setCreateMemberSelection(firstMemberSessionId ? `session:${firstMemberSessionId}` : "");
		setCreateTitle("");
		setCreateOpen(true);
	};

	const submitCreate = async () => {
		if (!onCreateRoom || !createProjectId || !createMemberSelection || !createTitle.trim()) return;
		const separator = createMemberSelection.indexOf(":");
		const kind = separator > 0 ? createMemberSelection.slice(0, separator) : "";
		const value = separator > 0 ? createMemberSelection.slice(separator + 1) : "";
		const member = kind === "session" && value && createMemberCandidates.some((session) => session.id === value)
			? { sessionId: value }
			: kind === "profile" && value && effectiveAgentProfiles.some((profile) => profile.name === value)
				? { profileId: value }
				: undefined;
		if (!member) return;
		setCreating(true);
		try {
			await onCreateRoom(createProjectId, createTitle.trim(), member);
			setCreateOpen(false);
		} catch (error) {
			actions.showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setCreating(false);
		}
	};

	const toggleProject = (projectId: string) => {
		setOpenProjects((current) => {
			const next = new Set(current);
			if (next.has(projectId)) next.delete(projectId);
			else next.add(projectId);
			return next;
		});
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className={cn("flex h-16 shrink-0 items-center justify-between px-4", onNavigate ? "pr-14 lg:pr-4" : "pr-4")}>
				<div className="flex items-center gap-2.5 font-semibold tracking-tight">
					<BrandLogo logo={state.branding.logo} className="size-7 rounded-md object-contain" />
					<span>{state.branding.name}</span>
				</div>
				{onCreateRoom ? (
					<Button size="icon" variant="ghost" onClick={openCreateDialog} aria-label="新建 Room">
						<Plus className="size-4" />
					</Button>
				) : null}
			</div>
			<div className="px-3 pb-3">
				<WorkspaceModeSwitch mode="rooms" onChange={onModeChange} />
			</div>
			<div className="px-3 pb-3">
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						aria-label="搜索 Room"
						placeholder="搜索 Room"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="h-10 border-0 bg-muted/60 pl-9 shadow-none focus-visible:ring-0"
					/>
				</div>
			</div>
			<ScrollArea className="min-h-0 flex-1 px-3">
				<div className="pb-5">
					<div className="flex items-center justify-between px-2 pb-2 text-xs font-medium text-muted-foreground">
						<span>Room</span>
						<span>{roomProjects.reduce((count, entry) => count + entry.rooms.length, 0)}</span>
					</div>
					{roomsLoading ? (
						<div className="px-2 py-8 text-center text-sm text-muted-foreground">正在加载 Room</div>
					) : roomsError ? (
						<div className="px-2 py-8 text-center text-sm text-destructive">{roomsError}</div>
					) : filteredProjects.length ? (
						<div className="grid gap-1">
							{filteredProjects.map(({ project, rooms }) => {
								const open = openProjects.has(project.id) || Boolean(normalizedQuery);
								return (
									<Collapsible key={project.id} open={open} onOpenChange={() => toggleProject(project.id)}>
										<CollapsibleTrigger asChild>
											<Button className="h-9 w-full justify-start gap-2 px-2 text-xs" variant="ghost">
												<ChevronDown className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
												<FolderTree className="size-4 shrink-0 text-muted-foreground" />
												<span className="min-w-0 flex-1 truncate text-left font-medium">{project.name}</span>
												<span className="text-[11px] text-muted-foreground">{rooms.length}</span>
											</Button>
										</CollapsibleTrigger>
										<CollapsibleContent>
											<div className="ml-2 grid gap-0.5 border-l border-border/60 pl-2">
												<div className="px-2 py-1 text-[11px] text-muted-foreground">{project.path}</div>
												{rooms.map((summary) => {
													const selected = selectedRoomId === summary.room.id;
											return (
														<button
															className={cn(
																"flex min-w-0 flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors",
																"hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
																selected && "bg-muted",
															)}
															key={summary.room.id}
															onClick={() => onSelectRoom(project.id, summary)}
															type="button"
														>
															<span className="flex min-w-0 items-center gap-2">
																<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden="true" />
																<span className="min-w-0 truncate text-[13px] font-medium">{summary.room.title}</span>
															</span>
															<span className="truncate pl-3.5 text-[11px] text-muted-foreground">{roomPreview(summary)}</span>
														</button>
													);
												})}
											</div>
										</CollapsibleContent>
									</Collapsible>
								);
							})}
						</div>
					) : (
						<div className="px-2 py-8 text-center text-sm text-muted-foreground">
							{roomProjects.length ? "没有匹配 Room" : "当前还没有 Room"}
						</div>
					)}
				</div>
			</ScrollArea>
			<div className="grid shrink-0 gap-1 border-t p-3">
				<div className="flex min-w-0 items-center gap-2">
					<Button className="min-w-0 flex-1 justify-start gap-2" variant="ghost" onClick={() => void actions.openSettings("appearance")}>
						<SunMoon className="size-4 shrink-0" />
						<span className="truncate">偏好设置</span>
					</Button>
					<ProductUpdateControl />
				</div>
				<Button className="justify-start gap-2" variant="ghost" onClick={actions.signOut}>
					<LogOut className="size-4" />
					<span>退出</span>
				</Button>
			</div>
			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>新建 Room</DialogTitle>
						<DialogDescription>Room 会归属于选中的项目。可加入已有会话，也可按智能体配置新建成员。</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-2">
						<label className="grid gap-2 text-sm font-medium" htmlFor="room-project">
							项目
							<Select
								value={createProjectId}
								onValueChange={(projectId) => {
									const project = projects.find((candidate) => candidate.id === projectId);
									const ownerSessionId = project?.sessions.find((session) => session.id === state.sessionId)?.id ?? project?.sessions[0]?.id;
									setCreateProjectId(projectId);
									const firstMemberSessionId = project?.sessions.find((session) => session.id !== ownerSessionId)?.id;
									setCreateMemberSelection(firstMemberSessionId ? `session:${firstMemberSessionId}` : "");
								}}
							>
								<SelectTrigger id="room-project" className="w-full">
									<SelectValue placeholder="选择项目" />
								</SelectTrigger>
								<SelectContent>
									{projects.filter((project) => !project.archived).map((project) => (
										<SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
									))}
								</SelectContent>
							</Select>
						</label>
						<label className="grid gap-2 text-sm font-medium" htmlFor="room-title">
							名称
							<Input
								id="room-title"
								maxLength={256}
								placeholder="例如：多智能体会话协作"
								value={createTitle}
								onChange={(event) => setCreateTitle(event.target.value)}
							/>
						</label>
						<label className="grid gap-2 text-sm font-medium" htmlFor="room-member">
							Agent 成员
							<Select
								value={createMemberSelection}
								disabled={agentProfilesLoading && !createMemberCandidates.length}
								onValueChange={setCreateMemberSelection}
							>
								<SelectTrigger id="room-member" className="w-full">
									<SelectValue placeholder="选择 Agent" />
								</SelectTrigger>
								<SelectContent>
									{createMemberCandidates.length ? (
										<SelectGroup>
											<SelectLabel>已有会话</SelectLabel>
											{createMemberCandidates.map((session) => (
												<SelectItem key={session.id} value={`session:${session.id}`}>
													{sessionTitle(session)}
												</SelectItem>
											))}
										</SelectGroup>
									) : null}
									{effectiveAgentProfiles.length ? (
										<SelectGroup>
											<SelectLabel>按配置新建</SelectLabel>
											{effectiveAgentProfiles.map((profile) => (
												<SelectItem key={`${profile.scope}:${profile.name}`} value={`profile:${profile.name}`}>
													{profile.name} · {profile.description}
												</SelectItem>
											))}
										</SelectGroup>
									) : null}
								</SelectContent>
							</Select>
							<span className="text-xs font-normal text-muted-foreground">
								{agentProfilesLoading ? "正在加载智能体配置" : agentProfilesError ?? "可加入已有会话，也可按配置新建智能体"}
							</span>
						</label>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
						<Button disabled={creating || !createProjectId || !createMemberSelection || !createTitle.trim()} onClick={() => void submitCreate()}>
							{creating ? "创建中…" : "创建 Room"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
