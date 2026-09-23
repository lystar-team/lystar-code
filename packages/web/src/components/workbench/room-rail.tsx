import { ChevronDown, FolderTree, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api";
import { cn } from "../../lib/utils";
import { type WorkbenchState } from "../../state/use-workbench";
import type { RoomMemberSelection, RoomProjectList } from "../../state/use-room-workspace";
import type { SubagentConfig, WebProject, WebRoomSummary } from "../../types";
import { BrandLogo } from "../brand-logo";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { AgentProfileCard } from "./agent-profile-card";
import { RailFooter } from "./rail-footer";
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
	const [createProfileId, setCreateProfileId] = useState("");
	const [createTitle, setCreateTitle] = useState("");
	const [creating, setCreating] = useState(false);
	const [agentProfiles, setAgentProfiles] = useState<SubagentConfig[]>([]);
	const [agentProfilesLoading, setAgentProfilesLoading] = useState(false);
	const [agentProfilesError, setAgentProfilesError] = useState<string>();
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
					if (cancelled) return;
					setAgentProfiles(response.subagents);
					setCreateProfileId((current) => current || response.subagents[0]?.name || "");
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
		setCreateProjectId(projectId);
		setCreateProfileId("");
		setCreateTitle("");
		setCreateOpen(true);
	};

	const submitCreate = async () => {
		if (!onCreateRoom || !createProjectId || !createProfileId || !createTitle.trim()) return;
		const profile = effectiveAgentProfiles.find((candidate) => candidate.name === createProfileId);
		if (!profile) return;
		const member = {
			profileId: profile.name,
			profileName: profile.name,
			...(profile.icon ? { profileIcon: profile.icon } : {}),
		};
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
						<div className="px-2 py-8 text-center text-[13px] text-muted-foreground">正在加载 Room</div>
					) : roomsError ? (
						<div className="px-2 py-8 text-center text-[13px] text-destructive">{roomsError}</div>
					) : filteredProjects.length ? (
						<div className="grid gap-0.5">
							{filteredProjects.map(({ project, rooms }) => {
								const open = openProjects.has(project.id) || Boolean(normalizedQuery);
								return (
									<Collapsible key={project.id} open={open} onOpenChange={() => toggleProject(project.id)}>
										<CollapsibleTrigger asChild>
											<Button className="h-8 w-full justify-start gap-2 px-2 text-xs" variant="ghost">
												<ChevronDown className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} />
												<FolderTree className="size-4 shrink-0 text-muted-foreground" />
															<span className="project-list-item-label min-w-0 flex-1 truncate text-left font-medium">{project.name}</span>
												<span className="text-[11px] text-muted-foreground">{rooms.length}</span>
											</Button>
										</CollapsibleTrigger>
										<CollapsibleContent>
											<div className="mt-0.5 ml-2 grid gap-0.5 border-l border-border/60 pl-2">
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
															<span className="project-list-item-label min-w-0 truncate font-medium">{summary.room.title}</span>
															</span>
															<span className="project-list-item-label truncate pl-3.5 text-muted-foreground">{roomPreview(summary)}</span>
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
						<div className="px-2 py-8 text-center text-[13px] text-muted-foreground">
							{roomProjects.length ? "没有匹配 Room" : "当前还没有 Room"}
						</div>
					)}
				</div>
			</ScrollArea>
			<RailFooter actions={actions} />
			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent>
				<DialogHeader>
					<DialogTitle>新建 Room</DialogTitle>
					<DialogDescription>Room 会归属于选中的项目。选择一个智能体配置作为首个协作成员。</DialogDescription>
				</DialogHeader>
					<div className="grid gap-4 py-2">
						<label className="grid gap-2 text-sm font-medium" htmlFor="room-project">
							项目
							<Select
														value={createProjectId}
														onValueChange={(projectId) => {
															setCreateProjectId(projectId);
															setCreateProfileId("");
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
						<div className="grid gap-2 text-sm font-medium">
							<span>首个协作智能体</span>
							{agentProfilesLoading ? (
								<div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">正在加载智能体配置</div>
							) : effectiveAgentProfiles.length ? (
								<div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
									{effectiveAgentProfiles.map((profile) => (
										<AgentProfileCard
											key={`${profile.scope}:${profile.name}`}
											profile={profile}
											selected={createProfileId === profile.name}
											onClick={() => setCreateProfileId(profile.name)}
										/>
									))}
								</div>
							) : (
								<div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
									{agentProfilesError ?? "当前项目没有可用的智能体配置"}
								</div>
							)}
							<span className="text-xs font-normal text-muted-foreground">昵称会在智能体加入 Room 后从昵称库分配。</span>
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
						<Button disabled={creating || !createProjectId || !createProfileId || !createTitle.trim()} onClick={() => void submitCreate()}>
							{creating ? "创建中…" : "创建 Room"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
