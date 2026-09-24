import { LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { webApi } from "../../adapters/host-protocol/api.ts";
import { cn } from "../../lib/utils";
import type { SubagentConfig } from "../../types";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import type { AgentIconKey } from "./collaboration-session";
import { AgentProfileCard } from "./agent-profile-card";

type AgentSessionProfile = Pick<SubagentConfig, "name" | "icon">;

interface AgentSessionDialogProps {
	open: boolean;
	projectId?: string;
	onOpenChange: (open: boolean) => void;
	onCreateSession: (profile: AgentSessionProfile) => Promise<void>;
	onManageAgents: () => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const DEFAULT_AGENT_ICONS: Partial<Record<string, AgentIconKey>> = {
	"research-specialist": "research",
	"review-specialist": "shield",
	worker: "code-2",
	"lua-worker": "wrench",
};

function profileForCard(profile: SubagentConfig): SubagentConfig {
	if (profile.icon) return profile;
	return { ...profile, icon: DEFAULT_AGENT_ICONS[profile.name] ?? "general" };
}

function matchesProfile(profile: SubagentConfig, query: string): boolean {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return true;
	return [profile.name, profile.description, ...(profile.tags ?? [])].some((value) =>
		value.toLowerCase().includes(normalizedQuery),
	);
}

function CreateAgentCard({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
	return (
		<Button
			className="min-h-48 w-full flex-col gap-3 border-dashed text-muted-foreground hover:text-foreground"
			disabled={disabled}
			type="button"
			variant="outline"
			onClick={onClick}
		>
			<span className="grid size-10 place-items-center rounded-lg border border-border/70 bg-muted/40">
				<Plus className="size-5" aria-hidden="true" />
			</span>
			<span>创建智能体</span>
		</Button>
	);
}

export function AgentSessionDialog({
	open,
	projectId,
	onOpenChange,
	onCreateSession,
	onManageAgents,
}: AgentSessionDialogProps) {
	const [profiles, setProfiles] = useState<SubagentConfig[]>([]);
	const [selectedName, setSelectedName] = useState("");
	const [searchQuery, setSearchQuery] = useState("");
	const [loading, setLoading] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [loadError, setLoadError] = useState<string>();
	const [submitError, setSubmitError] = useState<string>();
	const [retryKey, setRetryKey] = useState(0);
	const selectedProfile = profiles.find((profile) => profile.name === selectedName);
	const visibleProfiles = profiles.filter((profile) => matchesProfile(profile, searchQuery));

	useEffect(() => {
		if (!open || !projectId) return;
		let active = true;
		setProfiles([]);
		setSelectedName("");
		setSearchQuery("");
		setLoadError(undefined);
		setSubmitError(undefined);
		setLoading(true);
		void webApi
			.subagentConfigs(projectId)
			.then((response) => {
				if (!active) return;
				setProfiles(response.subagents);
				setSelectedName(response.subagents[0]?.name ?? "");
			})
			.catch((error: unknown) => {
				if (active) setLoadError(errorMessage(error));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [open, projectId, retryKey]);

	const handleSearchChange = (value: string) => {
		setSearchQuery(value);
		if (selectedProfile && !matchesProfile(selectedProfile, value)) setSelectedName("");
	};

	const createSession = async () => {
		if (!selectedProfile || submitting) return;
		setSubmitting(true);
		setSubmitError(undefined);
		try {
			await onCreateSession({
				name: selectedProfile.name,
				...(selectedProfile.icon ? { icon: selectedProfile.icon } : {}),
			});
			onOpenChange(false);
		} catch (error) {
			setSubmitError(errorMessage(error));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className={cn(
					"flex h-[min(88dvh,820px)] w-[min(96vw,1200px)] max-h-[88dvh] max-w-none flex-col gap-0 overflow-hidden p-0",
					"sm:max-w-[min(96vw,1200px)]",
					"max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none",
					"max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0",
				)}
			>
				<DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 pr-12 text-left sm:px-6">
					<DialogTitle>使用智能体新建会话</DialogTitle>
					<DialogDescription>选择智能体后，会创建一条独立会话。</DialogDescription>
				</DialogHeader>
				<div className="flex min-h-0 flex-1 flex-col">
					{loading ? (
						<div
							className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
							role="status"
						>
							<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
							正在加载智能体
						</div>
					) : loadError ? (
						<div className="flex min-h-0 flex-1 items-start overflow-y-auto p-4 sm:p-6">
							<Alert variant="destructive">
								<AlertTitle>读取智能体失败</AlertTitle>
								<AlertDescription className="flex flex-wrap items-center justify-between gap-3">
									<span className="min-w-0 break-words">{loadError}</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => setRetryKey((current) => current + 1)}
									>
										<RefreshCw className="size-3.5" aria-hidden="true" />
										重试
									</Button>
								</AlertDescription>
							</Alert>
						</div>
					) : profiles.length ? (
						<div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
							<div className="relative shrink-0">
								<Search
									className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
									aria-hidden="true"
								/>
								<Input
									aria-label="搜索智能体"
									className="pl-9"
									disabled={submitting}
									placeholder="搜索智能体"
									type="search"
									value={searchQuery}
									onChange={(event) => handleSearchChange(event.currentTarget.value)}
								/>
							</div>
							<ScrollArea className="min-h-0 flex-1 pr-3">
								<div
									className="grid grid-cols-1 gap-3 pb-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
									role="group"
									aria-label="智能体列表与创建入口"
								>
									{visibleProfiles.map((profile) => (
										<AgentProfileCard
											key={`${profile.scope}:${profile.name}`}
											profile={profileForCard(profile)}
											tagLimit={profile.tags?.length}
											selected={selectedName === profile.name}
											disabled={submitting}
											onClick={() => setSelectedName(profile.name)}
										/>
									))}
									{visibleProfiles.length === 0 ? (
										<div className="col-span-full py-8 text-center text-sm text-muted-foreground" role="status">
											没有匹配的智能体。
										</div>
									) : null}
									<CreateAgentCard onClick={onManageAgents} disabled={submitting} />
								</div>
							</ScrollArea>
						</div>
					) : (
						<div
							className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
							role="status"
						>
							<p className="text-sm text-muted-foreground">当前项目没有可用智能体。</p>
							<Button type="button" variant="ghost" onClick={onManageAgents}>
								管理智能体
							</Button>
						</div>
					)}
				</div>
				{submitError ? (
					<div className="shrink-0 px-4 pb-4 sm:px-6">
						<Alert variant="destructive">
							<AlertTitle>创建会话失败</AlertTitle>
							<AlertDescription>{submitError}</AlertDescription>
						</Alert>
					</div>
				) : null}
				<DialogFooter className="shrink-0 gap-2 border-t border-border/60 px-4 py-4 sm:px-6">
					<Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button type="button" disabled={!selectedProfile || loading || submitting} onClick={() => void createSession()}>
						{submitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
						新建会话
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
