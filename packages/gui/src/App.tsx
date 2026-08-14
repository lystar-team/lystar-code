import { useVirtualizer } from "@tanstack/react-virtual";
import type {
	CompletionResult,
	ContentReference,
	JsonValue,
	OperationStatus,
	ThinkingLevel,
	TranscriptItem,
} from "@lystar/code-gui-protocol";
import {
	AlertCircle,
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	Bot,
	Brain,
	Check,
	ChevronDown,
	ChevronRight,
	CircleStop,
	Cloud,
	Code2,
	Copy,
	FileText,
	Folder,
	FolderOpen,
	GitBranch,
	Image as ImageIcon,
	Info,
	KeyRound,
	LoaderCircle,
	LogOut,
	Menu,
	MessageSquarePlus,
	MoreHorizontal,
	Paperclip,
	Plus,
	RefreshCw,
	RotateCcw,
	Save,
	Search,
	Settings,
	ShieldAlert,
	SquareActivity,
	Sparkles,
	Sun,
	Terminal,
	Unplug,
	User,
	WandSparkles,
	X,
	ZoomIn,
	ZoomOut,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import logoDark from "./assets/lystar-mark-on-dark.png";
import logoLight from "./assets/lystar-mark-on-light.png";
import { HighlightedCode, Markdown } from "./markdown.tsx";
import {
	guiStore,
	type ModelProviderSummary,
	type ModelSummary,
	type PendingUiRequest,
	type ProviderModelInput,
	type SessionSummary,
	type SettingsPage,
	type SkillSummary,
	type SshConnectionProfile,
} from "./store.ts";
import {
	buildTranscriptRows,
	readLineRange,
	toolFiles,
	transcriptImages,
	type TranscriptImageView,
	type ToolExecutionView,
	type ToolFileView,
} from "./transcript-tools.ts";
import { selectOptions } from "./ui-request.ts";

const ACTIVE_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);
const SETTINGS: Array<{
	id: SettingsPage;
	label: string;
	icon: LucideIcon;
	group: "main" | "capability";
}> = [
	{ id: "general", label: "通用", icon: Settings, group: "main" },
	{ id: "appearance", label: "外观", icon: Sun, group: "main" },
	{ id: "connections", label: "连接", icon: Cloud, group: "main" },
	{ id: "models", label: "模型与认证", icon: KeyRound, group: "main" },
	{ id: "skills", label: "技能", icon: WandSparkles, group: "capability" },
	{ id: "update", label: "自动更新", icon: RefreshCw, group: "capability" },
	{ id: "diagnostics", label: "诊断", icon: SquareActivity, group: "capability" },
	{ id: "about", label: "关于", icon: Info, group: "capability" },
];
const THINKING_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "很高",
	max: "最大",
};
const CUSTOM_PROVIDER_APIS = [
	["openai-responses", "OpenAI Responses 兼容"],
	["openai-completions", "OpenAI Chat Completions 兼容"],
	["anthropic-messages", "Anthropic Messages 兼容"],
] as const;

function run(action: Promise<unknown>): void {
	void action.catch((error) => guiStore.showError(error));
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const value = block as Record<string, unknown>;
			if (value.type === "text" && typeof value.text === "string") return [value.text];
			if (value.type === "thinking" && typeof value.thinking === "string") return [];
			return [];
		})
		.join("");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function transcriptRole(item: TranscriptItem): string {
	const payload = record(item.payload);
	const message = record(payload?.message);
	return typeof message?.role === "string" ? message.role : item.kind;
}

function transcriptText(item: TranscriptItem): string {
	const payload = record(item.payload);
	const message = record(payload?.message);
	if (message) return textFromContent(message.content);
	if (typeof payload?.content === "string") return payload.content;
	if (typeof payload?.summary === "string") return payload.summary;
	return "";
}

function stringArgument(execution: ToolExecutionView, key: string): string | undefined {
	const value = execution.arguments[key];
	return typeof value === "string" ? value : undefined;
}

function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function executionStatus(
	execution: ToolExecutionView,
	operationStatus?: OperationStatus,
): { label: string; className: string } {
	if (execution.result?.isError) return { label: "失败", className: "error" };
	if (execution.result) return { label: "已完成", className: "complete" };
	if (operationStatus === "accepted" || operationStatus === "running" || operationStatus === "waiting_for_input") {
		return { label: "运行中", className: "running" };
	}
	if (operationStatus === "aborted") return { label: "已取消", className: "warning" };
	if (operationStatus === "interrupted") return { label: "已中断", className: "warning" };
	if (operationStatus === "failed") return { label: "失败", className: "error" };
	return { label: "未完成", className: "warning" };
}

function contentReferenceFromContent(content: unknown): ContentReference | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const value = record(block);
		const reference = record(value?.text);
		if (
			value?.type === "text" &&
			reference?.type === "content_ref" &&
			typeof reference.contentRef === "string" &&
			typeof reference.previewHead === "string" &&
			typeof reference.previewTail === "string" &&
			typeof reference.byteLength === "number" &&
			typeof reference.lineCount === "number" &&
			typeof reference.mimeType === "string"
		) {
			return reference as unknown as ContentReference;
		}
	}
	return undefined;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function sessionTitle(session: SessionSummary): string {
	return session.name?.trim() || session.firstMessage.trim() || "未命名会话";
}

function sessionState(session: SessionSummary): { label: string; className: string } {
	if (session.writeAccess === "locked_externally") return { label: "TUI 使用中", className: "external" };
	if (session.writeAccess === "controlled_elsewhere") return { label: "其他窗口使用中", className: "external" };
	return {
		idle: { label: "空闲", className: "idle" },
		running: { label: "运行中", className: "running" },
		waiting_for_input: { label: "等待输入", className: "waiting" },
		completed: { label: "已完成", className: "completed" },
		failed: { label: "失败", className: "failed" },
		aborted: { label: "已取消", className: "interrupted" },
		interrupted: { label: "已中断", className: "interrupted" },
	}[session.activity];
}

function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return "刚刚";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(timestamp);
}

function authSourceLabel(source: string | undefined): string {
	if (!source) return "已认证";
	if (/^[A-Z][A-Z0-9_]+$/u.test(source)) return `环境变量：${source}`;
	return (
		{
			runtime: "本次运行",
			stored: "已保存凭据",
			environment: "环境变量",
			models_json_key: "模型配置",
			models_json_command: "配置命令",
			fallback: "扩展配置",
		}[source] ?? source
	);
}

function modelCapabilityLabel(model: ModelSummary): string {
	return [...model.input.map((input) => (input === "image" ? "图片" : "文本")), ...(model.reasoning ? ["推理"] : [])].join(" · ");
}

function diagnosticName(id: string): string {
	return { node: "Node.js", "agent-dir": "配置目录", cwd: "当前项目" }[id] ?? id;
}

function diagnosticStatus(status: string): string {
	return { ok: "正常", warning: "警告", error: "错误" }[status] ?? status;
}

function aboutRows(value: JsonValue | undefined): Array<[string, string]> {
	const source = record(value);
	if (!source) return [];
	const fields = [
		["productVersion", "LYStar Code 版本"],
		["piVersion", "Pi 基线"],
		["hostVersion", "GUI 后台版本"],
		["protocolVersion", "GUI 协议版本"],
		["releaseRepository", "发行仓库"],
		["agentDir", "配置目录"],
		["sessionsDir", "会话目录"],
		["configDirName", "配置目录名称"],
	] as const;
	return fields.flatMap(([key, label]) => {
		const item = source[key];
		if (item === undefined || item === null) return [];
		return [[label, typeof item === "string" ? item : JSON.stringify(item)] as [string, string]];
	});
}

function formatTimestamp(timestamp: number | undefined): string {
	if (!timestamp) return "尚未检查";
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(timestamp);
}

function IconButton({
	label,
	children,
	disabled,
	onClick,
}: {
	label: string;
	children: React.ReactNode;
	disabled?: boolean;
	onClick?: () => void;
}) {
	return (
		<button className="icon-button" type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
			{children}
		</button>
	);
}

function Sidebar({ mobileOpen, closeMobile }: { mobileOpen: boolean; closeMobile: () => void }) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [query, setQuery] = useState("");
	const searchInput = useRef<HTMLInputElement>(null);
	const sessions = snapshot.sessions.filter((session) => sessionTitle(session).toLowerCase().includes(query.toLowerCase()));

	return (
		<>
			{mobileOpen && <button className="sidebar-scrim" aria-label="关闭项目列表" type="button" onClick={closeMobile} />}
			<aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
				<div className="brand-bar">
					<div className="brand-mark" aria-hidden="true">
						<img className="brand-mark-light" src={logoLight} alt="" />
						<img className="brand-mark-dark" src={logoDark} alt="" />
					</div>
					<strong>LYStar Code</strong>
					<IconButton label="搜索会话" onClick={() => searchInput.current?.focus()}>
						<Search size={17} />
					</IconButton>
				</div>
				<button className="sidebar-command" type="button" disabled={!snapshot.currentCwd} onClick={() => run(guiStore.createSession())}>
					<MessageSquarePlus size={16} />
					新会话
				</button>
				<label className="search-field">
					<Search size={16} />
					<input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" />
				</label>
				<div className="sidebar-section-label">项目</div>
				<div className="project-list">
					{snapshot.projects.map((project) => {
						const current = project.id === snapshot.currentProjectId;
						const connection = snapshot.connections.find((candidate) => candidate.id === project.connectionId);
						const remote = project.connectionId !== "local";
						const remoteStatus = current && snapshot.connected
							? "已连接"
							: snapshot.connectionProbes[project.connectionId]?.hostStatus?.reachable === true
								? "后台可用"
								: "离线";
						return (
							<div key={project.id}>
								<div className={`project-row-wrap ${current ? "selected" : ""}`}>
									<button
										className="project-row"
										type="button"
										title={remote ? `${connection?.name ?? "SSH"} · ${project.cwd}` : project.cwd}
										onClick={() => {
											run(guiStore.selectProject(project.id));
											closeMobile();
										}}
									>
										{remote ? <Cloud size={16} /> : current ? <FolderOpen size={16} /> : <Folder size={16} />}
										<span className="project-row-label"><span>{project.name}</span>{remote && <small>{connection?.name ?? "SSH"} · {remoteStatus}</small>}</span>
									</button>
									{!current && <IconButton label="移除项目" onClick={() => { if (window.confirm(`从列表移除项目“${project.name}”？`)) run(guiStore.removeProject(project.id)); }}><X size={14} /></IconButton>}
								</div>
								{current && (
									<div className="session-list">
										{sessions.map((session) => (
											<SessionRow key={session.path} session={session} closeMobile={closeMobile} />
										))}
										{sessions.length === 0 && <div className="sidebar-empty">暂无会话</div>}
									</div>
								)}
							</div>
						);
					})}
				</div>
				<button className="settings-entry" type="button" onClick={() => guiStore.openSettings()}>
					<Settings size={17} />
					设置
				</button>
			</aside>
		</>
	);
}

function SessionRow({ session, closeMobile }: { session: SessionSummary; closeMobile: () => void }) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [menuOpen, setMenuOpen] = useState(false);
	const selected = snapshot.selectedSessionPath === session.path;
	const state = sessionState(session);
	return (
		<div className={`session-row-wrap ${selected ? "selected" : ""} ${menuOpen ? "menu-open" : ""}`}>
			<button
				className="session-row"
				type="button"
				title={`${sessionTitle(session)}\n${session.path}`}
				onClick={() => {
					run(guiStore.acquireSession(session.path));
					closeMobile();
				}}
			>
				<span className={`session-state ${state.className}`} title={state.label} aria-label={state.label} />
				<span>{sessionTitle(session)}</span>
				<time>{relativeTime(session.updatedAt)}</time>
			</button>
			<IconButton label="会话操作" onClick={() => setMenuOpen((value) => !value)}>
				<MoreHorizontal size={15} />
			</IconButton>
			{menuOpen && (
				<div className="row-menu">
					<button
						type="button"
						disabled={!selected || !snapshot.lease}
						onClick={() => {
							const name = window.prompt("会话名称", session.name ?? "");
							if (name !== null) run(guiStore.renameSession(name));
							setMenuOpen(false);
						}}
					>
						重命名
					</button>
					<button
						className="danger"
						type="button"
						onClick={() => {
							if (window.confirm(`删除“${sessionTitle(session)}”？此操作不可撤销。`)) run(guiStore.deleteSession(session.path));
							setMenuOpen(false);
						}}
					>
						删除
					</button>
				</div>
			)}
		</div>
	);
}

function Topbar({ openMobile }: { openMobile: () => void }) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const project = snapshot.projects.find((candidate) => candidate.id === snapshot.currentProjectId);
	const session = snapshot.sessions.find((candidate) => candidate.path === snapshot.selectedSessionPath);
	return (
		<header className="topbar">
			<IconButton label="打开项目列表" onClick={openMobile}>
				<Menu size={18} />
			</IconButton>
			<Folder size={17} />
			<div className="topbar-title" title={snapshot.currentCwd}>
				<strong>{project?.name ?? "未打开项目"}</strong>
				{session && <span>/ {sessionTitle(session)}</span>}
			</div>
			<div className="topbar-spacer" />
			{snapshot.capabilities.includes("git-inspector") && snapshot.currentCwd && (
				<button className={`topbar-change ${snapshot.gitInspectorOpen ? "selected" : ""}`} type="button" title="查看工作区变更" onClick={() => snapshot.gitInspectorOpen ? guiStore.closeGitInspector() : run(guiStore.openGitInspector())}>
					<GitBranch size={16} />
					{snapshot.gitStatus && <span>{snapshot.gitStatus.files.length}</span>}
				</button>
			)}
		</header>
	);
}

function SessionLoadingOverlay() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	if (!snapshot.sessionAction) return null;
	const target = snapshot.sessions.find((session) => session.path === snapshot.sessionAction?.sessionPath);
	const label =
		snapshot.sessionAction.kind === "create"
			? "正在创建会话"
			: snapshot.sessionAction.kind === "project"
				? "正在打开项目"
				: `正在打开 ${target ? sessionTitle(target) : "会话"}`;
	return (
		<div className="session-loading" role="status" aria-live="polite">
			<div><LoaderCircle size={17} className="spin" /><span>{label}</span></div>
		</div>
	);
}

function Transcript() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const parent = useRef<HTMLDivElement>(null);
	const previousTranscriptSessionPath = useRef<string | undefined>(undefined);
	const previousFirstEntryId = useRef<string | undefined>(undefined);
	const rows = useMemo(() => buildTranscriptRows(snapshot.transcript), [snapshot.transcript]);
	const items = useMemo(() => {
		const result: Array<(typeof rows)[number] | { key: "live"; live: true; text: string }> = [...rows];
		if (snapshot.liveText) result.push({ key: "live", live: true, text: snapshot.liveText });
		return result;
	}, [rows, snapshot.liveText]);
	const activeIncompleteCallId = useMemo(() => {
		for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
			const row = rows[rowIndex];
			const executions = row.kind === "tool" ? [row.execution] : row.kind === "bash-group" ? row.executions : [];
			for (let executionIndex = executions.length - 1; executionIndex >= 0; executionIndex--) {
				if (!executions[executionIndex].result) return executions[executionIndex].callId;
			}
		}
		return undefined;
	}, [rows]);
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => parent.current,
		estimateSize: () => 120,
		overscan: 8,
		useFlushSync: false,
	});

	useEffect(() => {
		const previousSessionPath = previousTranscriptSessionPath.current;
		const previousFirst = previousFirstEntryId.current;
		const firstEntryId = snapshot.transcript[0]?.entryId;
		const anchorIndex =
			previousSessionPath === snapshot.selectedSessionPath && previousFirst
				? rows.findIndex((row) => row.sourceEntryIds.includes(previousFirst))
				: -1;
		previousTranscriptSessionPath.current = snapshot.selectedSessionPath;
		previousFirstEntryId.current = firstEntryId;
		if (anchorIndex > 0) virtualizer.scrollToIndex(anchorIndex, { align: "start" });
		else if (items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" });
	}, [items.length, rows, snapshot.selectedSessionPath, snapshot.transcript, virtualizer]);

	if (!snapshot.currentCwd) {
		return (
			<div className="workspace-empty">
				<FolderOpen size={28} />
				<h2>打开一个项目</h2>
				<p>项目路径只保存在本机，Session 继续使用现有 JSONL。</p>
				<button type="button" onClick={() => run(guiStore.chooseProject())}>打开项目</button>
			</div>
		);
	}
	if (!snapshot.selectedSessionPath) {
		return (
			<div className="workspace-empty">
				<MessageSquarePlus size={28} />
				<h2>开始新会话</h2>
				<p>新会话会写入当前项目的标准 Session 目录。</p>
				<button type="button" onClick={() => run(guiStore.createSession())}>新会话</button>
			</div>
		);
	}

	return (
		<div className="transcript-scroll" ref={parent}>
			<div className="transcript-content">
				{(snapshot.hasMorePrevious || snapshot.hasMoreRecent) && (
					<div className="transcript-history-actions">
						{snapshot.hasMorePrevious && (
							<button
								className="load-earlier"
								type="button"
								disabled={snapshot.loadingEarlier}
								onClick={() => run(guiStore.loadEarlier())}
							>
								<RefreshCw size={14} />
								{snapshot.loadingEarlier ? "加载中" : "加载更早内容"}
							</button>
						)}
						{snapshot.hasMoreRecent && (
							<button className="load-earlier" type="button" onClick={() => run(guiStore.jumpToLatest())}>
								<ArrowDown size={14} />
								回到最新
							</button>
						)}
					</div>
				)}
				{items.length === 0 ? (
					<div className="conversation-empty">
						<Sparkles size={22} />
						<p>输入任务或继续说明</p>
					</div>
				) : (
					<div className="virtual-transcript" style={{ height: `${virtualizer.getTotalSize()}px` }}>
						{virtualizer.getVirtualItems().map((virtualItem) => {
							const item = items[virtualItem.index];
							const isTool = !("live" in item) && item.kind !== "entry";
							return (
								<div
									key={item.key}
									data-index={virtualItem.index}
									ref={virtualizer.measureElement}
									className={`virtual-row ${isTool ? "tool-virtual-row" : ""}`}
									style={{ transform: `translateY(${virtualItem.start}px)` }}
								>
									{"live" in item ? (
										<AssistantMessage text={item.text} live />
									) : item.kind === "entry" ? (
										<TranscriptEntry item={item.item} />
									) : item.kind === "bash-group" ? (
										<BashGroup
											executions={item.executions}
											activeCallId={activeIncompleteCallId}
											operationStatus={snapshot.currentOperation?.status}
										/>
									) : (
										<ToolExecution
											execution={item.execution}
											operationStatus={
												item.execution.callId === activeIncompleteCallId ? snapshot.currentOperation?.status : undefined
											}
										/>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

function TranscriptImage({ image }: { image: TranscriptImageView }) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [source, setSource] = useState<string>();
	const [error, setError] = useState<string>();
	const [open, setOpen] = useState(false);
	const [zoom, setZoom] = useState(1);

	useEffect(() => {
		let disposed = false;
		let objectUrl: string | undefined;
		setError(undefined);
		if (image.data) {
			setSource(`data:${image.mimeType};base64,${image.data}`);
			return;
		}
		if (!image.reference || !snapshot.selectedSessionPath) return;
		void guiStore
			.readContentBytes(snapshot.selectedSessionPath, image.reference.contentRef)
			.then((bytes) => {
				if (disposed) return;
				const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
				objectUrl = URL.createObjectURL(new Blob([buffer], { type: image.mimeType }));
				setSource(objectUrl);
			})
			.catch((loadError) => {
				if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
			});
		return () => {
			disposed = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [image.data, image.mimeType, image.reference, snapshot.selectedSessionPath]);

	if (error) return <div className="image-load-error"><AlertCircle size={14} />{error}</div>;
	if (!source) return <div className="image-loading"><LoaderCircle size={14} className="spin" />正在读取图片</div>;
	return (
		<>
			<button className="transcript-image" type="button" onClick={() => setOpen(true)}>
				<img src={source} alt="会话图片" />
			</button>
			{open && (
				<div className="image-viewer" role="dialog" aria-modal="true" aria-label="图片查看器">
					<header>
						<span>{image.mimeType}</span>
						<div>
							<IconButton label="缩小" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><ZoomOut size={16} /></IconButton>
							<button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
							<IconButton label="放大" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 0.25))}><ZoomIn size={16} /></IconButton>
							<IconButton label="关闭图片" onClick={() => { setOpen(false); setZoom(1); }}><X size={17} /></IconButton>
						</div>
					</header>
					<div className="image-viewer-canvas"><img src={source} alt="会话图片大图" style={{ transform: `scale(${zoom})` }} /></div>
				</div>
			)}
		</>
	);
}

function TranscriptImages({ images }: { images: readonly TranscriptImageView[] }) {
	if (images.length === 0) return null;
	return <div className="transcript-images">{images.map((image, index) => <TranscriptImage key={`${image.reference?.contentRef ?? image.data?.slice(0, 32)}:${index}`} image={image} />)}</div>;
}

function TranscriptEntry({ item }: { item: TranscriptItem }) {
	const role = transcriptRole(item);
	const text = transcriptText(item);
	const images = transcriptImages(item);
	if (role === "user") return <UserMessage text={text} images={images} />;
	if (role === "assistant") return <AssistantMessage text={text} entryId={item.entryId} images={images} />;
	if (role === "toolResult") return <ToolResult item={item} />;
	return (
		<div className="system-entry">
			<Info size={14} />
			<span>{text || item.kind}</span>
		</div>
	);
}

function UserMessage({ text, images = [] }: { text: string; images?: readonly TranscriptImageView[] }) {
	return (
		<div className="user-message">
			<div className="message-author"><User size={14} />你</div>
			<TranscriptImages images={images} />
			{text && <Markdown text={text} onOpenResource={(target) => run(guiStore.openResource(target))} />}
		</div>
	);
}

function AssistantMessage({
	text,
	live,
	entryId,
	images = [],
}: {
	text: string;
	live?: boolean;
	entryId?: string;
	images?: readonly TranscriptImageView[];
}) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	return (
		<article className={`assistant-message ${live ? "is-live" : ""}`}>
			<div className="message-author"><Bot size={15} />LYStar</div>
			<TranscriptImages images={images} />
			{text ? <Markdown text={text} onOpenResource={(target) => run(guiStore.openResource(target))} /> : images.length === 0 ? <div className="thinking-line"><WandSparkles size={14} />正在处理</div> : null}
			{entryId && snapshot.lease && (
				<div className="message-actions">
					<IconButton label="从这里分叉" onClick={() => run(guiStore.forkSession(entryId))}>
						<GitBranch size={14} />
					</IconButton>
					<IconButton label="复制回复" onClick={() => void navigator.clipboard.writeText(text)}>
						<Copy size={14} />
					</IconButton>
				</div>
			)}
		</article>
	);
}

function ToolResult({ item }: { item: TranscriptItem }) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const payload = record(item.payload);
	const message = record(payload?.message);
	const toolName = typeof message?.toolName === "string" ? message.toolName : "工具";
	const reference = contentReferenceFromContent(message?.content);
	const inlineText = textFromContent(message?.content);
	const images = transcriptImages(item);
	const [text, setText] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();
	const isError = message?.isError === true;
	const preview = reference
		? `${reference.previewHead}\n\n... 已省略 ${formatBytes(Math.max(0, reference.byteLength - utf8ByteLength(reference.previewHead) - utf8ByteLength(reference.previewTail)))} ...\n\n${reference.previewTail}`
		: inlineText || JSON.stringify(item.payload, null, 2);

	const load = async () => {
		if (!reference || text !== undefined || loading || !snapshot.selectedSessionPath) return;
		setLoading(true);
		setError(undefined);
		try {
			setText(await guiStore.readContent(snapshot.selectedSessionPath, reference.contentRef));
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
		} finally {
			setLoading(false);
		}
	};

	return (
		<details
			className={`tool-result ${isError ? "error" : ""}`}
			onToggle={(event) => {
				if (event.currentTarget.open) void load();
			}}
		>
			<summary>
				{toolName === "bash" ? <Terminal size={15} /> : <Code2 size={15} />}
				<strong>{toolName}</strong>
				<span>
					{reference ? `${formatBytes(reference.byteLength)} · ${reference.lineCount} 行` : isError ? "失败" : "已完成"}
				</span>
				<ChevronRight size={14} className="details-chevron" />
			</summary>
			{error && <div className="tool-content-error">{error}</div>}
			<TranscriptImages images={images} />
			{(loading || text !== undefined || preview) && <pre>{loading ? "正在读取完整输出..." : text ?? preview}</pre>}
		</details>
	);
}

function useToolOutput(execution: ToolExecutionView) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const reference = execution.result?.reference;
	const [text, setText] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		setText(undefined);
		setError(undefined);
	}, [execution.callId, reference?.contentRef]);

	const preview = reference
		? `${reference.previewHead}\n\n... 已省略 ${formatBytes(Math.max(0, reference.byteLength - utf8ByteLength(reference.previewHead) - utf8ByteLength(reference.previewTail)))} ...\n\n${reference.previewTail}`
		: execution.result?.text ?? "";
	const load = async () => {
		if (!reference || text !== undefined || loading || !snapshot.selectedSessionPath) return;
		setLoading(true);
		setError(undefined);
		try {
			setText(await guiStore.readContent(snapshot.selectedSessionPath, reference.contentRef));
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
		} finally {
			setLoading(false);
		}
	};
	return { text: text ?? preview, loading, error, load };
}

function DiffView({ diff, path }: { diff: string; path?: string }) {
	let nextLine = 0;
	return (
		<pre className="tool-diff" aria-label="文件差异">
			{diff.split("\n").map((line, index) => {
				const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
				if (hunk) nextLine = Number(hunk[1]);
				const kind =
					line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.trim() === "..."
						? "meta"
						: line.startsWith("+")
							? "add"
							: line.startsWith("-")
								? "delete"
								: "context";
				const sourceLine = kind === "add" || kind === "context" ? nextLine : undefined;
				if (sourceLine !== undefined) nextLine++;
				return (
					<code className={`diff-line ${kind}`} key={`${index}:${line}`}>
						{path && sourceLine ? (
							<button type="button" title={`打开 ${path}:${sourceLine}`} onClick={() => run(guiStore.openResource(path, sourceLine))}>{sourceLine}</button>
						) : <span className="diff-line-number" />}
						<span>{line || " "}</span>
					</code>
				);
			})}
		</pre>
	);
}

function FileChange({ file }: { file: ToolFileView }) {
	const [open, setOpen] = useState(false);
	return (
		<details className="tool-file" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				<FileText size={15} />
				<button className="tool-file-link" type="button" title={file.path} onClick={(event) => { event.preventDefault(); event.stopPropagation(); run(guiStore.openResource(file.path)); }}>{file.path}</button>
				<small>{file.operation ?? "修改"}</small>
				<span className="diff-counts"><b>+{file.additions ?? 0}</b><i>-{file.deletions ?? 0}</i></span>
				{file.diff && <ChevronRight size={14} className="details-chevron" />}
			</summary>
			{open && file.diff && <DiffView diff={file.diff} path={file.path} />}
		</details>
	);
}

function ToolExecution({
	execution,
	operationStatus,
}: {
	execution: ToolExecutionView;
	operationStatus?: OperationStatus;
}) {
	const [open, setOpen] = useState(false);
	const output = useToolOutput(execution);
	const status = executionStatus(execution, operationStatus);
	const files = toolFiles(execution);
	const path = stringArgument(execution, "path");
	const title = path ?? execution.name;
	const range = readLineRange(execution);
	const isRead = execution.name === "read";
	return (
		<details
			className={`tool-execution ${status.className}`}
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
				if (event.currentTarget.open) void output.load();
			}}
		>
			<summary>
				{isRead ? <FileText size={15} /> : <Code2 size={15} />}
				<div className="tool-title">
					<strong>{isRead ? `读取 ${fileName(title)}` : execution.name === "apply_patch" ? "应用补丁" : title}</strong>
					{path && <button type="button" title={`打开 ${path}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); run(guiStore.openResource(path, range ? Number(range.split("-")[0].replace("+", "")) : undefined)); }}>{path}</button>}
				</div>
				{range && <span className="tool-range">{range} 行</span>}
				<span className={`tool-status ${status.className}`}>
					{status.className === "running" && <LoaderCircle size={13} className="spin" />}
					{status.label}
				</span>
				<ChevronRight size={14} className="details-chevron" />
			</summary>
			{open && (
				<div className="tool-body">
					{files.length > 0 && <div className="tool-files">{files.map((file) => <FileChange key={file.path} file={file} />)}</div>}
					<TranscriptImages images={execution.result?.images ?? []} />
					{output.error && <div className="tool-content-error">{output.error}</div>}
					{output.loading ? (
						<div className="tool-loading"><LoaderCircle size={14} className="spin" />正在读取完整输出</div>
					) : isRead && output.text ? (
						<HighlightedCode code={output.text} path={path} />
					) : files.length === 0 && output.text ? (
						<pre className="tool-output"><code>{output.text}</code></pre>
					) : files.length === 0 ? (
						<pre className="tool-output"><code>{JSON.stringify(execution.arguments, null, 2)}</code></pre>
					) : null}
				</div>
			)}
		</details>
	);
}

function BashCommand({ execution, operationStatus }: { execution: ToolExecutionView; operationStatus?: OperationStatus }) {
	const [open, setOpen] = useState(false);
	const output = useToolOutput(execution);
	const status = executionStatus(execution, operationStatus);
	const command = stringArgument(execution, "command") ?? "bash";
	return (
		<details
			className={`bash-command ${status.className}`}
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
				if (event.currentTarget.open) void output.load();
			}}
		>
			<summary>
				<Terminal size={14} />
				<code title={command}>{command}</code>
				<span className={`tool-status ${status.className}`}>{status.label}</span>
				<ChevronRight size={13} className="details-chevron" />
			</summary>
			{open && (
				<div className="tool-body">
					{output.error && <div className="tool-content-error">{output.error}</div>}
					{output.loading ? (
						<div className="tool-loading"><LoaderCircle size={14} className="spin" />正在读取完整输出</div>
					) : (
						<pre className="tool-output"><code>{output.text || "命令没有输出"}</code></pre>
					)}
				</div>
			)}
		</details>
	);
}

function BashGroup({
	executions,
	activeCallId,
	operationStatus,
}: {
	executions: ToolExecutionView[];
	activeCallId?: string;
	operationStatus?: OperationStatus;
}) {
	const [open, setOpen] = useState(false);
	const incomplete = executions.find((execution) => execution.callId === activeCallId) ?? executions.at(-1)!;
	const status = executions.some((execution) => execution.result?.isError)
		? { label: "有命令失败", className: "error" }
		: executions.some((execution) => !execution.result)
			? executionStatus(incomplete, operationStatus)
			: { label: "已完成", className: "complete" };
	return (
		<details className={`bash-group ${status.className}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				<Terminal size={15} />
				<strong>{executions.length === 1 ? "运行命令" : `运行 ${executions.length} 条命令`}</strong>
				<span className={`tool-status ${status.className}`}>
					{status.className === "running" && <LoaderCircle size={13} className="spin" />}
					{status.label}
				</span>
				<ChevronRight size={14} className="details-chevron" />
			</summary>
			{open && (
				<div className="bash-command-list">
					{executions.map((execution) => (
						<BashCommand
							key={execution.callId}
							execution={execution}
							operationStatus={execution.callId === activeCallId ? operationStatus : undefined}
						/>
					))}
				</div>
			)}
		</details>
	);
}

function Composer() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [text, setText] = useState("");
	const [images, setImages] = useState<Array<{ data: string; mimeType: string; name: string }>>([]);
	const [modelOpen, setModelOpen] = useState(false);
	const [thinkingOpen, setThinkingOpen] = useState(false);
	const [completion, setCompletion] = useState<CompletionResult>();
	const [completionIndex, setCompletionIndex] = useState(0);
	const [cursor, setCursor] = useState(0);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const completionRequest = useRef(0);
	const running = !!snapshot.currentOperation && ACTIVE_STATUSES.has(snapshot.currentOperation.status);
	const writable = !!snapshot.lease && snapshot.capabilities.includes("session-control");
	const bashCommand = text.trimStart().startsWith("!");
	const invalidAttachments = bashCommand && images.length > 0;
	const selectedModel = snapshot.models.find(
		(model) => model.provider === snapshot.selectedSession?.model?.provider && model.id === snapshot.selectedSession?.model?.id,
	);
	const thinkingLevels = selectedModel?.supportedThinkingLevels ?? ["off"];
	const disabledReason = !snapshot.selectedSessionPath
		? "先打开或新建会话"
		: !snapshot.lease
			? "该会话正在其他进程中使用"
			: undefined;

	useEffect(() => {
		const before = text.slice(0, cursor);
		const triggered =
			/^\/[^\s]*$/.test(before) ||
			/(?:^|[\s=(])(?:\$\[?[a-z0-9-]*|@"[^"]*|@[^\s]*)$/i.test(before);
		if (!triggered || !writable) {
			setCompletion(undefined);
			return;
		}
		const request = ++completionRequest.current;
		const timer = window.setTimeout(() => {
			void guiStore.getCompletions(text, cursor).then((result) => {
				if (request !== completionRequest.current) return;
				setCompletion(result.items.length > 0 ? result : undefined);
				setCompletionIndex(0);
			});
		}, 100);
		return () => window.clearTimeout(timer);
	}, [cursor, text, writable]);

	const submit = () => {
		if (!text.trim() || !writable || invalidAttachments) return;
		run(guiStore.submit(text, images.map(({ data, mimeType }) => ({ data, mimeType }))));
		setText("");
		setImages([]);
		setCompletion(undefined);
	};

	const applyCompletion = (index: number) => {
		const item = completion?.items[index];
		if (!item || !completion) return;
		const next = `${text.slice(0, completion.prefixStart)}${item.value}${text.slice(completion.prefixEnd)}`;
		const nextCursor = completion.prefixStart + item.value.length;
		setText(next);
		setCursor(nextCursor);
		setCompletion(undefined);
		requestAnimationFrame(() => {
			textarea.current?.focus();
			textarea.current?.setSelectionRange(nextCursor, nextCursor);
		});
	};

	return (
		<div className={`composer ${writable ? "" : "read-only"} ${images.length > 0 ? "has-attachments" : ""}`} title={disabledReason}>
			{completion && (
				<div className="completion-menu" role="listbox" aria-label="输入补全">
					{completion.items.map((item, index) => (
						<button
							key={`${item.kind}:${item.value}`}
							type="button"
							className={index === completionIndex ? "selected" : ""}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => applyCompletion(index)}
						>
							{item.kind === "file" || item.kind === "directory" ? <FileText size={15} /> : item.kind === "skill" ? <WandSparkles size={15} /> : <Terminal size={15} />}
							<span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
						</button>
					))}
				</div>
			)}
			{images.length > 0 && (
				<div className="attachment-list">
					{images.map((image) => (
						<span key={image.name}>
							<img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
							<small title={image.name}>{image.name}</small>
							<button type="button" aria-label={`移除 ${image.name}`} onClick={() => setImages((items) => items.filter((item) => item !== image))}>
								<X size={12} />
							</button>
						</span>
					))}
				</div>
			)}
			<textarea
				ref={textarea}
				value={text}
				disabled={!snapshot.selectedSessionPath}
				placeholder={disabledReason ?? "输入任务或继续说明"}
				onChange={(event) => {
					setText(event.target.value);
					setCursor(event.target.selectionStart);
				}}
				onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
				onKeyDown={(event) => {
					if (completion) {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setCompletionIndex((value) => (value + 1) % completion.items.length);
							return;
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							setCompletionIndex((value) => (value - 1 + completion.items.length) % completion.items.length);
							return;
						}
						if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
							event.preventDefault();
							applyCompletion(completionIndex);
							return;
						}
						if (event.key === "Escape") {
							event.preventDefault();
							setCompletion(undefined);
							return;
						}
					}
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						submit();
					}
				}}
			/>
			<div className="composer-footer">
				<div className="composer-left">
					<label className="icon-button" title="添加图片">
						<Paperclip size={17} />
						<input
							hidden
							type="file"
							accept="image/*"
							multiple
							disabled={!writable || bashCommand}
							onChange={(event) => {
								const files = [...(event.target.files ?? [])].slice(0, 5 - images.length);
								for (const file of files) {
									const reader = new FileReader();
									reader.onload = () => {
										const result = String(reader.result);
										setImages((items) => [...items, { name: file.name, mimeType: file.type, data: result.split(",")[1] ?? "" }]);
									};
									reader.readAsDataURL(file);
								}
								event.target.value = "";
							}}
						/>
					</label>
					{!writable && snapshot.selectedSessionPath && <span className="permission-warning"><ShieldAlert size={14} />只读</span>}
					{invalidAttachments && <span className="permission-warning"><ShieldAlert size={14} />Bash 命令不能包含图片</span>}
				</div>
				<div className="composer-right">
					<div className="menu-trigger-wrap">
						<button className="text-trigger" type="button" disabled={!writable || running} onClick={() => setModelOpen((value) => !value)}>
							{selectedModel?.name ?? snapshot.selectedSession?.model?.id ?? "选择模型"}
							<ChevronDown size={13} />
						</button>
						{modelOpen && (
							<div className="popover-menu model-menu">
								{snapshot.models.map((model) => (
									<button
										key={`${model.provider}/${model.id}`}
										type="button"
										disabled={!model.authenticated}
										onClick={() => {
											run(guiStore.setModel({ provider: model.provider, id: model.id }));
											setModelOpen(false);
										}}
									>
										<span>{model.name}</span>
										<small>{model.provider}</small>
									</button>
								))}
							</div>
						)}
					</div>
					<div className="menu-trigger-wrap">
						<button className="text-trigger" type="button" disabled={!writable || running} onClick={() => setThinkingOpen((value) => !value)}>
							<Brain size={14} />
							{THINKING_LABELS[snapshot.selectedSession?.thinkingLevel ?? "off"]}
						</button>
						{thinkingOpen && (
							<div className="popover-menu thinking-menu">
								{thinkingLevels.map((level) => (
									<button key={level} type="button" onClick={() => { run(guiStore.setThinkingLevel(level)); setThinkingOpen(false); }}>
										{THINKING_LABELS[level]}
									</button>
								))}
							</div>
						)}
					</div>
					<button
						className={`send-button ${running ? "stop" : ""}`}
						type="button"
						aria-label={running ? "停止" : "发送"}
						disabled={!running && (!writable || !text.trim() || invalidAttachments)}
						onClick={() => running ? run(guiStore.abort()) : submit()}
					>
						{running ? <CircleStop size={18} /> : <ArrowUp size={19} />}
					</button>
				</div>
			</div>
		</div>
	);
}

function SettingsView() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [query, setQuery] = useState("");
	const page = snapshot.settingsPage ?? "general";
	const filtered = SETTINGS.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
	const main = filtered.filter((item) => item.group === "main");
	const capabilities = filtered.filter((item) => item.group === "capability");
	const renderItem = (item: (typeof SETTINGS)[number]) => {
		const Icon = item.icon;
		return (
			<button key={item.id} type="button" className={page === item.id ? "selected" : ""} onClick={() => guiStore.openSettings(item.id)}>
				<Icon size={17} />
				<span>{item.label}</span>
			</button>
		);
	};
	return (
		<div className="settings-view">
			<aside className="settings-sidebar">
				<div className="settings-brand">
					<div className="brand-mark" aria-hidden="true">
						<img className="brand-mark-light" src={logoLight} alt="" />
						<img className="brand-mark-dark" src={logoDark} alt="" />
					</div>
					<strong>LYStar Code</strong>
				</div>
				<button className="settings-back" type="button" onClick={() => guiStore.closeSettings()}>
					<ArrowLeft size={17} />
					<span>返回应用</span>
				</button>
				<label className="search-field settings-nav-search">
					<Search size={16} />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置" />
				</label>
				<nav>
					{main.map(renderItem)}
					{capabilities.length > 0 && <div className="settings-nav-group">能力</div>}
					{capabilities.map(renderItem)}
					{filtered.length === 0 && <div className="settings-nav-empty">未找到设置</div>}
				</nav>
			</aside>
			<main className="settings-content">
				<SettingsPageContent page={page} />
			</main>
		</div>
	);
}

function SettingsPageContent({ page }: { page: SettingsPage }) {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	if (page === "appearance") return <AppearanceSettings />;
	if (page === "connections") return <ConnectionsSettings />;
	if (page === "models") return <ModelsSettings />;
	if (page === "skills") return <SkillsSettings skills={snapshot.skills} diagnostics={snapshot.skillDiagnostics} />;
	if (page === "update") return <UpdateSettings />;
	if (page === "diagnostics") return <DiagnosticsSettings />;
	if (page === "about") return <AboutSettings value={snapshot.about} />;
	return <GeneralSettings />;
}

function GeneralSettings() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [selectedPath, setSelectedPath] = useState<string>();
	const [content, setContent] = useState("");
	const [saving, setSaving] = useState(false);
	const selected = snapshot.projectInstructions.find((file) => file.path === selectedPath);

	useEffect(() => {
		const current = snapshot.projectInstructions.find((file) => file.path === selectedPath);
		if (current) return;
		const next =
			snapshot.projectInstructions.find((file) => file.editable && file.active) ??
			snapshot.projectInstructions.find((file) => file.editable && file.fileName === "AGENTS.md") ??
			snapshot.projectInstructions[0];
		setSelectedPath(next?.path);
	}, [selectedPath, snapshot.currentProjectId, snapshot.projectInstructions]);

	useEffect(() => {
		setContent(selected?.content ?? "");
	}, [selected?.content, selected?.contentHash, selected?.path]);

	const save = async () => {
		if (!selected?.editable || (selected.fileName !== "AGENTS.md" && selected.fileName !== "AGENTS.override.md")) return;
		setSaving(true);
		try {
			await guiStore.saveProjectInstruction(selected.fileName, content, selected.contentHash);
		} catch (error) {
			guiStore.showError(error);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection title="通用" description="管理桌面项目和当前项目的指令文件。">
			<div className="general-settings-layout">
				<section className="project-manager" aria-label="桌面项目">
					<header><strong>项目</strong><button type="button" onClick={() => run(guiStore.chooseProject())}><Plus size={15} />添加项目</button></header>
					<div className="project-manager-list">
						{snapshot.projects.map((project) => {
							const current = project.id === snapshot.currentProjectId;
							const connection = snapshot.connections.find((candidate) => candidate.id === project.connectionId);
							return (
								<div key={project.id} className={current ? "selected" : ""}>
									<button type="button" title={project.cwd} onClick={() => run(guiStore.selectProject(project.id))}>
										{project.connectionId === "local" ? <Folder size={16} /> : <Cloud size={16} />}
										<span><strong>{project.name}</strong><small>{project.connectionId === "local" ? project.cwd : `${connection?.name ?? "SSH"} · ${project.cwd}`}</small></span>
									</button>
									{!current && <IconButton label="移除项目" onClick={() => { if (window.confirm(`从列表移除项目“${project.name}”？`)) run(guiStore.removeProject(project.id)); }}><X size={14} /></IconButton>}
								</div>
							);
						})}
					</div>
				</section>
				<section className="instruction-manager" aria-label="项目指令">
					<header><div><strong>项目指令</strong><small>{snapshot.currentCwd ?? "尚未打开项目"}</small></div><button type="button" disabled={!snapshot.currentCwd} onClick={() => run(guiStore.refreshProjectInstructions())}><RefreshCw size={15} />重新加载</button></header>
					<div className="instruction-body">
						<nav>
							{snapshot.projectInstructions.map((file) => (
								<button key={file.path} type="button" className={file.path === selectedPath ? "selected" : ""} onClick={() => setSelectedPath(file.path)}>
									<FileText size={15} />
									<span><strong>{file.fileName}</strong><small>{file.exists ? file.active ? "当前生效" : "未生效" : "尚未创建"}{!file.editable ? " · 继承" : ""}</small></span>
								</button>
							))}
						</nav>
						<div className="instruction-editor">
							{selected ? (
								<>
									<header><div><strong>{selected.fileName}</strong><small title={selected.path}>{selected.path}</small></div>{selected.editable && <button type="button" disabled={saving || content === (selected.content ?? "")} onClick={() => void save()}><Save size={15} />{saving ? "正在保存" : selected.exists ? "保存" : "创建"}</button>}</header>
									<textarea value={content} readOnly={!selected.editable} spellCheck={false} onChange={(event) => setContent(event.target.value)} />
								</>
							) : <div className="settings-empty">当前项目没有可管理的指令文件</div>}
						</div>
					</div>
				</section>
			</div>
		</SettingsSection>
	);
}

function AppearanceSettings() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	return (
		<SettingsSection title="外观" description="主题只改变语义 Token，布局和组件尺寸保持一致。">
			<div className="theme-options">
				{([
					["system", "跟随系统"],
					["light", "浅色"],
					["dark", "深色"],
				] as const).map(([value, label]) => (
					<button key={value} type="button" className={snapshot.theme === value ? "selected" : ""} onClick={() => guiStore.setTheme(value)}>
						<span className={`theme-preview ${value}`} aria-hidden="true">
							<span className="theme-preview-sidebar"><i /><i /><i /></span>
							<span className="theme-preview-main"><i /><i /><i /></span>
						</span>
						<span>{label}</span>
						{snapshot.theme === value && <Check size={16} />}
					</button>
				))}
			</div>
		</SettingsSection>
	);
}

function SshConnectionDialog({
	connection,
	onClose,
}: {
	connection?: SshConnectionProfile;
	onClose: () => void;
}) {
	const [name, setName] = useState(connection?.name ?? "");
	const [target, setTarget] = useState(connection?.target ?? "");
	const [platform, setPlatform] = useState<SshConnectionProfile["platform"]>(connection?.platform ?? "auto");
	const [defaultCwd, setDefaultCwd] = useState(connection?.defaultCwd ?? "");
	const [hostCommand, setHostCommand] = useState(connection?.hostCommand ?? "");
	const [busy, setBusy] = useState(false);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const saved = await guiStore.saveSshConnection({
				id: connection?.id,
				name,
				target,
				platform,
				defaultCwd: defaultCwd || undefined,
				hostCommand: hostCommand || undefined,
			});
			onClose();
			await guiStore.probeSshProfile(saved.id);
		} catch (error) {
			guiStore.showError(error);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="modal-scrim">
			<div className="ui-dialog provider-dialog" role="dialog" aria-modal="true" aria-labelledby="ssh-dialog-title">
				<header><div><h2 id="ssh-dialog-title">{connection ? "编辑 SSH 连接" : "添加 SSH 连接"}</h2><p>认证由 OpenSSH、ssh-agent 和系统 known_hosts 处理。</p></div><IconButton label="关闭" onClick={onClose}><X size={16} /></IconButton></header>
				<form className="provider-form connection-form" onSubmit={submit}>
					<label><span>连接名称</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如生产服务器" /></label>
					<label><span>SSH 目标</span><input required value={target} onChange={(event) => setTarget(event.target.value)} placeholder="~/.ssh/config 别名或 user@host" /></label>
					<label><span>远端系统</span><select value={platform} onChange={(event) => setPlatform(event.target.value as SshConnectionProfile["platform"])}><option value="auto">自动检测</option><option value="linux">Linux</option><option value="darwin">macOS</option><option value="windows">Windows</option></select></label>
					<label className="wide"><span>默认项目路径</span><input value={defaultCwd} onChange={(event) => setDefaultCwd(event.target.value)} placeholder="例如 /srv/project" /></label>
					<label className="wide"><span>远端后台命令</span><input value={hostCommand} onChange={(event) => setHostCommand(event.target.value)} placeholder="留空时按远端系统使用默认安装位置" /></label>
					<div className="dialog-actions wide"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? "正在保存" : "保存并测试"}</button></div>
				</form>
			</div>
		</div>
	);
}

function RemoteProjectDialog({ connection, onClose }: { connection: SshConnectionProfile; onClose: () => void }) {
	const [cwd, setCwd] = useState(connection.defaultCwd ?? "");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			await guiStore.addRemoteProject(connection.id, cwd, name || undefined);
			onClose();
		} catch (error) {
			guiStore.showError(error);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="modal-scrim">
			<div className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-project-title">
				<header><div><h2 id="remote-project-title">添加远端项目</h2><p>{connection.name} · {connection.target}</p></div><IconButton label="关闭" onClick={onClose}><X size={16} /></IconButton></header>
				<form className="provider-form connection-form" onSubmit={submit}>
					<label className="wide"><span>远端项目路径</span><input required value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="例如 /srv/project" /></label>
					<label className="wide"><span>项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="默认使用路径末级名称" /></label>
					<div className="dialog-actions wide"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? "正在打开" : "添加并打开"}</button></div>
				</form>
			</div>
		</div>
	);
}

function ConnectionsSettings() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [editing, setEditing] = useState<SshConnectionProfile | "new">();
	const [projectConnection, setProjectConnection] = useState<SshConnectionProfile>();
	const status = snapshot.connectionStatus;
	const loading = snapshot.pendingActions.includes("connections");
	return (
		<SettingsSection title="连接" description="本机与 SSH 项目共用同一工作台；SSH 认证继续使用系统 OpenSSH。">
			<div className="settings-toolbar compact">
				<strong>后台连接</strong>
				<div className="settings-toolbar-actions">
					<button type="button" onClick={() => setEditing("new")}><Plus size={15} />添加 SSH</button>
					<button type="button" className="reload-button" disabled={loading} onClick={() => run(guiStore.refreshConnectionStatus())}><RefreshCw size={15} className={loading ? "spin" : ""} />重新检查当前连接</button>
				</div>
			</div>
			<div className="connection-list">
				<div className={`connection-entry ${snapshot.activeConnectionId === "local" ? "selected" : ""}`}>
					<div className="connection-row">
						<Folder size={18} />
						<div><strong>本机</strong><p>{snapshot.activeConnectionId === "local" && status ? `${status.platform} ${status.arch} · ${status.persistent ? "常驻服务" : "当前应用进程"}` : "应用内置后台"}</p></div>
						<span className={`status-pill ${snapshot.activeConnectionId === "local" && snapshot.connected ? "success" : ""}`}>{snapshot.activeConnectionId === "local" ? snapshot.connected ? "已连接" : "已断开" : "可用"}</span>
					</div>
				</div>
				{snapshot.connections.map((connection) => {
					const probe = snapshot.connectionProbes[connection.id];
					const active = snapshot.activeConnectionId === connection.id;
					const reachable = active ? snapshot.connected : probe?.hostStatus?.reachable === true;
					const busy = snapshot.pendingActions.includes(`ssh-probe:${connection.id}`) || snapshot.pendingActions.includes(`ssh-install:${connection.id}`);
					const stateLabel = busy
						? "检查中"
						: reachable
							? "后台可用"
							: active
								? "已断开"
								: probe?.connected
									? "待安装后台"
									: probe
										? "SSH 不可达"
										: "未检查";
					return (
						<div className={`connection-entry ${active ? "selected" : ""}`} key={connection.id}>
							<div className="connection-row">
								<Cloud size={18} />
								<div><strong>{connection.name}</strong><p>{connection.target}{connection.defaultCwd ? ` · ${connection.defaultCwd}` : ""}</p>{probe?.message && <small>{probe.message}</small>}{connection.hostCommand && <small>自定义后台命令由用户自行部署</small>}</div>
								<span className={`status-pill ${reachable ? "success" : probe ? "warning" : ""}`}>{stateLabel}</span>
							</div>
							<div className="connection-actions">
								<button type="button" disabled={busy} onClick={() => run(guiStore.probeSshProfile(connection.id))}><RefreshCw size={14} />测试</button>
								<button type="button" disabled={busy || Boolean(connection.hostCommand)} onClick={() => run(guiStore.installSshProfile(connection.id))}><Terminal size={14} />安装匹配的后台</button>
								<button type="button" disabled={busy || Boolean(connection.hostCommand)} onClick={() => run(guiStore.chooseAndInstallSshProfile(connection.id))}>选择后台二进制</button>
								<button type="button" onClick={() => setProjectConnection(connection)}><FolderOpen size={14} />添加项目</button>
								<button type="button" onClick={() => setEditing(connection)}>编辑</button>
								<button type="button" className="danger" onClick={() => { if (window.confirm(`删除 SSH 连接“${connection.name}”？`)) run(guiStore.removeSshConnection(connection.id)); }}>删除</button>
							</div>
						</div>
					);
				})}
				{snapshot.connections.length === 0 && <div className="settings-empty">尚未添加 SSH 连接</div>}
			</div>
			{status && snapshot.connected && (
				<div className="key-value-list connection-details">
					<div><strong>当前传输</strong><span>{status.transport === "ssh" ? "SSH 字节中继" : "本机进程"}</span></div>
					<div><strong>后台实例</strong><span>{status.hostInstanceId}</span></div>
					<div><strong>服务实例</strong><span>{status.serverInstanceId}</span></div>
					<div><strong>启动时间</strong><span>{formatTimestamp(status.hostStartedAt)}</span></div>
				</div>
			)}
			{editing && <SshConnectionDialog connection={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} />}
			{projectConnection && <RemoteProjectDialog connection={projectConnection} onClose={() => setProjectConnection(undefined)} />}
		</SettingsSection>
	);
}

function ProviderAddDialog({ providers, onClose }: { providers: readonly ModelProviderSummary[]; onClose: () => void }) {
	const [mode, setMode] = useState<"builtin" | "custom">("builtin");
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [providerId, setProviderId] = useState("");
	const [providerName, setProviderName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState<(typeof CUSTOM_PROVIDER_APIS)[number][0]>("openai-responses");
	const [modelId, setModelId] = useState("");
	const [modelName, setModelName] = useState("");
	const [reasoning, setReasoning] = useState(false);
	const [imageInput, setImageInput] = useState(false);
	const candidates = providers
		.filter((provider) => provider.builtIn && !provider.authenticated && provider.authMethods.length > 0)
		.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(query.toLowerCase()))
		.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

	const authenticate = async (provider: ModelProviderSummary, authType: "api_key" | "oauth") => {
		setBusy(true);
		try {
			await guiStore.loginModelProvider(provider.id, authType);
			onClose();
		} catch (error) {
			guiStore.showError(error);
		} finally {
			setBusy(false);
		}
	};

	const submitCustom = async (event: React.FormEvent) => {
		event.preventDefault();
		const id = providerId.trim();
		if (providers.some((provider) => provider.id === id && !provider.custom)) {
			guiStore.showError(new Error("该供应商标识已被内置供应商使用"));
			return;
		}
		setBusy(true);
		try {
			await guiStore.addModelProvider(
				{ provider: id, name: providerName.trim() || undefined, baseUrl: baseUrl.trim(), api },
				{
					provider: id,
					id: modelId.trim(),
					name: modelName.trim() || undefined,
					reasoning,
					input: imageInput ? ["text", "image"] : ["text"],
				},
			);
			onClose();
		} catch (error) {
			guiStore.showError(error);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-scrim">
			<div className="ui-dialog provider-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-dialog-title">
				<header><div><h2 id="provider-dialog-title">添加供应商</h2><p>添加后完成认证，供应商才会出现在主列表。</p></div><IconButton label="关闭" onClick={onClose}><X size={16} /></IconButton></header>
				<div className="dialog-tabs">
					<button type="button" className={mode === "builtin" ? "selected" : ""} onClick={() => setMode("builtin")}>内置供应商</button>
					<button type="button" className={mode === "custom" ? "selected" : ""} onClick={() => setMode("custom")}>自定义供应商</button>
				</div>
				{mode === "builtin" ? (
					<>
						<label className="search-field dialog-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索供应商" /></label>
						<div className="provider-catalog">
							{candidates.map((provider) => (
								<div key={provider.id}>
									<div><strong>{provider.name}</strong><code>{provider.id}</code></div>
									<div className="provider-auth-actions">
										{provider.authMethods.map((method) => (
											<button type="button" disabled={busy} key={method} onClick={() => void authenticate(provider, method)}>
												{method === "oauth" ? "OAuth 登录" : "输入 API 密钥"}
											</button>
										))}
									</div>
								</div>
							))}
							{candidates.length === 0 && <div className="settings-empty">没有可添加的供应商</div>}
						</div>
					</>
				) : (
					<form className="provider-form" onSubmit={submitCustom}>
						<label><span>供应商标识</span><input required value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="例如 my-openai" /></label>
						<label><span>显示名称</span><input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="例如公司模型网关" /></label>
						<label className="wide"><span>接口地址</span><input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" /></label>
						<label className="wide"><span>接口协议</span><select value={api} onChange={(event) => setApi(event.target.value as typeof api)}>{CUSTOM_PROVIDER_APIS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
						<label><span>首个模型 ID</span><input required value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="例如 model-pro" /></label>
						<label><span>模型名称</span><input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="例如 Model Pro" /></label>
						<label className="check-field"><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />支持推理</label>
						<label className="check-field"><input type="checkbox" checked={imageInput} onChange={(event) => setImageInput(event.target.checked)} />支持图片输入</label>
						<div className="dialog-actions wide"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? "正在添加" : "添加并认证"}</button></div>
					</form>
				)}
			</div>
		</div>
	);
}

function ProviderModelDialog({ provider, onClose }: { provider: ModelProviderSummary; onClose: () => void }) {
	const [id, setId] = useState("");
	const [name, setName] = useState("");
	const [contextWindow, setContextWindow] = useState("128000");
	const [maxTokens, setMaxTokens] = useState("16384");
	const [reasoning, setReasoning] = useState(false);
	const [imageInput, setImageInput] = useState(false);
	const [busy, setBusy] = useState(false);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const model: ProviderModelInput = {
				provider: provider.id,
				id: id.trim(),
				name: name.trim() || undefined,
				reasoning,
				input: imageInput ? ["text", "image"] : ["text"],
				contextWindow: Number(contextWindow),
				maxTokens: Number(maxTokens),
			};
			await guiStore.addProviderModel(model);
			onClose();
		} catch (error) {
			guiStore.showError(error);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="modal-scrim">
			<div className="ui-dialog provider-dialog" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
				<header><div><h2 id="model-dialog-title">添加模型</h2><p>{provider.name}</p></div><IconButton label="关闭" onClick={onClose}><X size={16} /></IconButton></header>
				<form className="provider-form" onSubmit={submit}>
					<label><span>模型 ID</span><input required value={id} onChange={(event) => setId(event.target.value)} /></label>
					<label><span>模型名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
					<label><span>上下文长度</span><input required min="1" type="number" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} /></label>
					<label><span>最大输出长度</span><input required min="1" type="number" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label>
					<label className="check-field"><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />支持推理</label>
					<label className="check-field"><input type="checkbox" checked={imageInput} onChange={(event) => setImageInput(event.target.checked)} />支持图片输入</label>
					<div className="dialog-actions wide"><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? "正在添加" : "添加模型"}</button></div>
				</form>
			</div>
		</div>
	);
}

function ModelsSettings() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [query, setQuery] = useState("");
	const [selectedProvider, setSelectedProvider] = useState<string>();
	const [addingProvider, setAddingProvider] = useState(false);
	const [addingModel, setAddingModel] = useState(false);
	const providers = snapshot.modelProviders.filter((provider) => provider.authenticated);
	const activeProvider = providers.find((provider) => provider.id === selectedProvider) ?? providers[0];
	const providerModels = activeProvider ? snapshot.models.filter((model) => model.provider === activeProvider.id) : [];
	const filtered = providerModels.filter((model) =>
		`${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
	);
	const authBusy = activeProvider ? snapshot.pendingActions.includes(`model-auth:${activeProvider.id}`) : false;
	const loading = snapshot.pendingActions.includes("models") || snapshot.pendingActions.includes("model-providers");
	return (
		<SettingsSection title="模型与认证" description="这里只显示已配置并且当前可用的供应商。">
			<div className="settings-toolbar compact">
				<label className="search-field settings-search inline"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前供应商的模型" /></label>
				<div className="settings-toolbar-actions">
					<button type="button" onClick={() => setAddingProvider(true)}><Plus size={15} />添加供应商</button>
					<button type="button" className="reload-button" disabled={loading} onClick={() => run(guiStore.refreshModels())}><RefreshCw size={15} className={loading ? "spin" : ""} />重新加载</button>
				</div>
			</div>
			{activeProvider ? (
				<div className="models-layout">
					<div className="provider-list">
						{providers.map((provider) => {
							const models = snapshot.models.filter((model) => model.provider === provider.id);
							return (
								<button key={provider.id} type="button" className={activeProvider.id === provider.id ? "selected" : ""} onClick={() => setSelectedProvider(provider.id)}>
									<div><strong>{provider.name}</strong><small>{models.length} 个模型 · {authSourceLabel(provider.authSource)}</small></div>
									<ChevronRight size={14} />
								</button>
							);
						})}
					</div>
					<div className="provider-detail">
						<header>
							<div><h2>{activeProvider.name}</h2><p><code>{activeProvider.id}</code> · {authSourceLabel(activeProvider.authSource)}</p></div>
							<div className="provider-actions">
								<button type="button" onClick={() => setAddingModel(true)}><Plus size={14} />添加模型</button>
								{activeProvider.authMethods.map((method) => (
									<button key={method} type="button" disabled={authBusy} onClick={() => run(guiStore.loginModelProvider(activeProvider.id, method))}>
										{authBusy ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}{method === "oauth" ? "重新登录" : "重新认证"}
									</button>
								))}
								<button type="button" disabled={authBusy} onClick={() => run(guiStore.logoutModelProvider(activeProvider.id))}><LogOut size={14} />退出</button>
							</div>
						</header>
						{snapshot.modelAuthProvider === activeProvider.id && snapshot.modelAuthStatus && <div className="auth-status"><LoaderCircle size={14} className={authBusy ? "spin" : ""} />{snapshot.modelAuthStatus}</div>}
						<div className="model-table">
							<div className="model-table-head"><span>模型</span><span>模型 ID</span><span>能力</span><span>状态</span></div>
							{filtered.map((model) => (
								<div className="model-table-row" key={model.id}>
									<strong>{model.name}</strong><code>{model.id}</code><span>{modelCapabilityLabel(model)}</span><span>可用</span>
								</div>
							))}
							{filtered.length === 0 && <div className="settings-empty">未发现匹配的模型</div>}
						</div>
					</div>
				</div>
			) : (
				<div className="settings-empty provider-empty"><KeyRound size={22} /><strong>尚未配置模型供应商</strong><p>添加并完成认证后，供应商和模型会显示在这里。</p><button type="button" onClick={() => setAddingProvider(true)}><Plus size={15} />添加供应商</button></div>
			)}
			{addingProvider && <ProviderAddDialog providers={snapshot.modelProviders} onClose={() => setAddingProvider(false)} />}
			{addingModel && activeProvider && <ProviderModelDialog provider={activeProvider} onClose={() => setAddingModel(false)} />}
		</SettingsSection>
	);
}

function SkillsSettings({ skills, diagnostics }: { skills: readonly SkillSummary[]; diagnostics: JsonValue }) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<"all" | "user" | "project">("all");
	const filtered = skills.filter(
		(skill) =>
			(scope === "all" || skill.scope === scope) &&
			`${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()),
	);
	const counts = {
		all: skills.length,
		user: skills.filter((skill) => skill.scope === "user").length,
		project: skills.filter((skill) => skill.scope === "project").length,
	};
	return (
		<SettingsSection title="技能" description="只管理运行时已发现的技能，不提供市场。">
			<div className="settings-toolbar">
				<div className="settings-tabs">
					{(["all", "user", "project"] as const).map((value) => (
						<button key={value} type="button" className={scope === value ? "selected" : ""} onClick={() => setScope(value)}>
							{value === "all" ? "全部" : value === "user" ? "用户" : "项目"} {counts[value]}
						</button>
					))}
				</div>
				<button type="button" className="reload-button" onClick={() => run(guiStore.refreshSkills())}><RefreshCw size={15} />重新加载</button>
			</div>
			<label className="search-field settings-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" /></label>
			<div className="continuous-list">
				{filtered.map((skill) => (
					<div className="skill-row" key={skill.path}>
						<WandSparkles size={17} />
						<div><strong>{skill.name}</strong><p>{skill.description}</p><small>{skill.scope === "user" ? "用户" : skill.scope === "project" ? "项目" : "临时"}</small></div>
						<label className="toggle"><input type="checkbox" checked={skill.enabled} disabled={skill.scope === "temporary"} onChange={() => run(guiStore.toggleSkill(skill))} /><span /></label>
					</div>
				))}
				{filtered.length === 0 && <div className="settings-empty">未发现匹配的技能</div>}
			</div>
			{Array.isArray(diagnostics) && diagnostics.length > 0 && <div className="update-note"><AlertCircle size={15} /><span>发现 {diagnostics.length} 条技能加载诊断，请检查技能文件和配置。</span></div>}
		</SettingsSection>
	);
}

function UpdateSettings() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const status = snapshot.updateStatus;
	const loading = snapshot.pendingActions.includes("updates");
	const statusLabel = status
		? {
				available: "发现新版本",
				current: "已是最新版本",
				offline: "离线模式",
				unavailable: "未获取到版本信息",
			}[status.status]
		: "尚未检查";
	return (
		<SettingsSection title="自动更新" description="版本检查读取 LYStar Release；安装必须通过正式签名验证。">
			<div className="update-summary">
				<div><small>当前版本</small><strong>{status?.currentVersion ?? "-"}</strong></div>
				<ArrowRight size={18} />
				<div><small>最新版本</small><strong>{status?.latestVersion ?? "-"}</strong></div>
				<span className={`status-pill ${status?.status === "available" ? "warning" : status?.status === "current" ? "success" : ""}`}>{statusLabel}</span>
			</div>
			<SettingRow title="检查更新" description={`上次检查：${formatTimestamp(status?.checkedAt)}`}>
				<button type="button" disabled={loading} onClick={() => run(guiStore.checkForUpdates())}>
					<RefreshCw size={15} className={loading ? "spin" : ""} />{loading ? "正在检查" : "立即检查"}
				</button>
			</SettingRow>
			<SettingRow title="安装更新" description={status?.installBlockedReason ?? "后台服务尚未返回安装能力。"}>
				<button type="button" disabled>安装不可用</button>
			</SettingRow>
			{status?.note && <div className="update-note"><Info size={15} /><span>{status.note}</span></div>}
		</SettingsSection>
	);
}

function DiagnosticsSettings() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const loading = snapshot.pendingActions.includes("diagnostics");
	const value = record(snapshot.diagnostics);
	const checks = Array.isArray(value?.checks)
		? value.checks.flatMap((item) => {
				const check = record(item);
				return typeof check?.id === "string" && typeof check.status === "string" && typeof check.message === "string"
					? [{ id: check.id, status: check.status, message: check.message }]
					: [];
			})
		: [];
	const problems = checks.filter((check) => check.status !== "ok").length;
	return (
		<SettingsSection title="诊断" description="检查本机、会话与后台环境；诊断信息不包含凭据和完整提示词。">
			<div className="settings-toolbar compact">
				<strong className={problems > 0 ? "warning" : "success"}>{problems > 0 ? `${problems} 项需要处理` : "检查正常"}</strong>
				<button type="button" className="reload-button" disabled={loading} onClick={() => run(guiStore.refreshDiagnostics())}>
					<RefreshCw size={15} className={loading ? "spin" : ""} />重新检查
				</button>
			</div>
			<div className="diagnostic-list">
				{checks.map((check) => (
					<div key={check.id}>
						{check.status === "ok" ? <Check size={16} /> : <AlertCircle size={16} />}
						<strong>{diagnosticName(check.id)}</strong>
						<span>{check.message}</span>
						<small className={check.status === "ok" ? "success" : check.status === "warning" ? "warning" : "error"}>{diagnosticStatus(check.status)}</small>
					</div>
				))}
				{checks.length === 0 && <div className="settings-loading"><LoaderCircle size={16} className="spin" />正在读取诊断结果</div>}
			</div>
			<div className="key-value-list diagnostic-environment">
				<div><strong>平台</strong><span>{typeof value?.platform === "string" ? value.platform : "-"}</span></div>
				<div><strong>架构</strong><span>{typeof value?.arch === "string" ? value.arch : "-"}</span></div>
			</div>
		</SettingsSection>
	);
}

function AboutSettings({ value }: { value: JsonValue | undefined }) {
	return (
		<SettingsSection title="关于" description="版本与目录由当前后台服务返回。">
			<div className="about-brand"><div className="brand-mark large" aria-hidden="true"><img className="brand-mark-light" src={logoLight} alt="" /><img className="brand-mark-dark" src={logoDark} alt="" /></div><div><strong>LYStar Code</strong><p>跨平台编码 Agent 工作台</p></div></div>
			<div className="key-value-list">{aboutRows(value).map(([key, item]) => <div key={key}><strong>{key}</strong><span>{item}</span></div>)}</div>
		</SettingsSection>
	);
}

function SettingsSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
	return <section className="settings-section"><header><h1>{title}</h1>{description && <p>{description}</p>}</header>{children}</section>;
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
	return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><div>{children}</div></div>;
}

function GitInspector() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const body = useRef<HTMLDivElement>(null);
	if (!snapshot.gitInspectorOpen) return null;
	const status = snapshot.gitStatus;
	const selected = status?.files.find((file) => file.path === snapshot.gitDiff?.path);
	const loadingStatus = snapshot.pendingActions.includes("git-status");
	const loadingDiff = snapshot.pendingActions.includes("git-diff");
	const resizeWidth = (event: React.PointerEvent) => {
		const startX = event.clientX;
		const startWidth = snapshot.inspectorWidth;
		const move = (pointer: PointerEvent) => guiStore.setInspectorLayout(startWidth + startX - pointer.clientX, snapshot.inspectorSplit);
		const stop = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			run(guiStore.persistInspectorLayout());
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", stop, { once: true });
	};
	const resizeSplit = (event: React.PointerEvent) => {
		const rect = body.current?.getBoundingClientRect();
		if (!rect) return;
		const move = (pointer: PointerEvent) => guiStore.setInspectorLayout(snapshot.inspectorWidth, (pointer.clientY - rect.top) / rect.height);
		const stop = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			run(guiStore.persistInspectorLayout());
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", stop, { once: true });
	};
	return (
		<aside className="git-inspector" aria-label="工作区变更" style={{ width: snapshot.inspectorWidth }}>
			<div
				className="inspector-width-resizer"
				role="separator"
				tabIndex={0}
				aria-label="调整变更面板宽度"
				aria-orientation="vertical"
				onPointerDown={resizeWidth}
				onDoubleClick={() => { guiStore.setInspectorLayout(480, snapshot.inspectorSplit); run(guiStore.persistInspectorLayout()); }}
				onKeyDown={(event) => {
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					event.preventDefault();
					guiStore.setInspectorLayout(snapshot.inspectorWidth + (event.key === "ArrowLeft" ? 24 : -24), snapshot.inspectorSplit);
					run(guiStore.persistInspectorLayout());
				}}
			/>
			<header>
				<div><strong>工作区变更</strong>{status && <span>{status.branch ?? "分离 HEAD"}{status.upstream ? ` · ${status.upstream}` : ""}{status.ahead || status.behind ? ` · ↑${status.ahead} ↓${status.behind}` : ""}</span>}</div>
				<div><IconButton label="恢复默认布局" onClick={() => run(guiStore.resetInspectorLayout())}><RotateCcw size={15} /></IconButton><IconButton label="刷新变更" disabled={loadingStatus} onClick={() => run(guiStore.refreshGitStatus())}><RefreshCw size={15} className={loadingStatus ? "spin" : ""} /></IconButton><IconButton label="关闭变更" onClick={() => guiStore.closeGitInspector()}><X size={16} /></IconButton></div>
			</header>
			{!status && loadingStatus && <div className="settings-loading"><LoaderCircle size={16} className="spin" />正在读取 Git 状态</div>}
			{status && status.files.length === 0 && <div className="settings-empty">工作区没有未提交变更</div>}
			{status && status.files.length > 0 && (
				<div ref={body} className="git-inspector-body" style={{ gridTemplateRows: `minmax(120px, ${snapshot.inspectorSplit * 100}%) 6px minmax(0, 1fr)` }}>
					<div className="git-file-list">
						{status.files.map((file) => {
							const active = snapshot.gitDiff?.path === file.path;
							const defaultStaged = file.staged && !file.unstaged;
							return <button className={active ? "selected" : ""} type="button" key={`${file.path}:${file.originalPath ?? ""}`} title={file.path} onClick={() => run(guiStore.loadGitDiff(file.path, defaultStaged))}><span className="git-status-code">{file.indexStatus}{file.worktreeStatus}</span><span>{file.path}</span>{file.originalPath && <small>从 {file.originalPath}</small>}</button>;
						})}
					</div>
					<div
						className="inspector-split-resizer"
						role="separator"
						tabIndex={0}
						aria-label="调整文件列表高度"
						aria-orientation="horizontal"
						onPointerDown={resizeSplit}
						onDoubleClick={() => { guiStore.setInspectorLayout(snapshot.inspectorWidth, 0.34); run(guiStore.persistInspectorLayout()); }}
						onKeyDown={(event) => {
							if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
							event.preventDefault();
							guiStore.setInspectorLayout(snapshot.inspectorWidth, snapshot.inspectorSplit + (event.key === "ArrowDown" ? 0.04 : -0.04));
							run(guiStore.persistInspectorLayout());
						}}
					/>
					<div className="git-diff-pane">
						{selected && (
							<header><button className="git-resource-link" type="button" title={`打开 ${selected.path}`} onClick={() => run(guiStore.openResource(selected.path))}>{selected.path}</button><div>{selected.staged && <button className={snapshot.gitDiff?.staged ? "selected" : ""} type="button" onClick={() => run(guiStore.loadGitDiff(selected.path, true))}>暂存区</button>}{selected.unstaged && !selected.untracked && <button className={!snapshot.gitDiff?.staged ? "selected" : ""} type="button" onClick={() => run(guiStore.loadGitDiff(selected.path, false))}>工作区</button>}</div></header>
						)}
						{loadingDiff ? <div className="settings-loading"><LoaderCircle size={16} className="spin" />正在读取差异</div> : selected?.untracked ? <div className="settings-empty">未跟踪文件尚无 Git Diff</div> : snapshot.gitDiff?.diff ? <DiffView diff={snapshot.gitDiff.diff} path={selected?.path} /> : <div className="settings-empty">选择文件查看差异</div>}
					</div>
				</div>
			)}
		</aside>
	);
}

function ResourceViewer() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [zoom, setZoom] = useState(1);
	const viewer = snapshot.resourceViewer;
	useEffect(() => setZoom(1), [viewer?.resource.path]);
	if (!viewer) return null;
	const lines = viewer.text?.split("\n") ?? [];
	const targetIndex = Math.max(0, (viewer.resource.line ?? 1) - 1);
	const start = viewer.resource.line ? Math.max(0, targetIndex - 100) : 0;
	const end = Math.min(lines.length, Math.max(start + 2000, targetIndex + 101));
	return (
		<div className="resource-viewer" role="dialog" aria-modal="true" aria-label="项目文件查看器">
			<header>
				<div>{viewer.resource.kind === "image" ? <ImageIcon size={17} /> : <FileText size={17} />}<span><strong>{viewer.resource.displayPath}</strong>{viewer.resource.line && <small>第 {viewer.resource.line} 行{viewer.resource.column ? `，第 ${viewer.resource.column} 列` : ""}</small>}</span></div>
				<div>
					{viewer.resource.kind === "image" && <><IconButton label="缩小" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><ZoomOut size={16} /></IconButton><button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><IconButton label="放大" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 0.25))}><ZoomIn size={16} /></IconButton></>}
					<IconButton label="关闭文件" onClick={() => guiStore.closeResource()}><X size={17} /></IconButton>
				</div>
			</header>
			{viewer.resource.kind === "image" && viewer.url ? (
				<div className="resource-image-canvas"><img src={viewer.url} alt={viewer.resource.displayPath} style={{ transform: `scale(${zoom})` }} /></div>
			) : (
				<div className="resource-text-view">
					{start > 0 && <div className="resource-window-note">已定位到目标行附近</div>}
					<pre>{lines.slice(start, end).map((line, index) => {
						const lineNumber = start + index + 1;
						return <code key={lineNumber} className={lineNumber === viewer.resource.line ? "selected" : ""}><span>{lineNumber}</span><b>{line || " "}</b></code>;
					})}</pre>
					{end < lines.length && <div className="resource-window-note">文件较长，当前显示 {start + 1}-{end} 行</div>}
				</div>
			)}
		</div>
	);
}

function UiRequestDialog({ request }: { request: PendingUiRequest }) {
	const payload = record(request.payload);
	const [value, setValue] = useState(() => {
		if (typeof payload?.prefill === "string") return payload.prefill;
		return "";
	});
	const message = typeof payload?.message === "string" ? payload.message : undefined;
	const options = selectOptions(payload?.options);
	return (
		<div className="modal-scrim">
			<div className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-request-title">
				<h2 id="ui-request-title">{request.title}</h2>
				<p>{message ?? (request.kind === "confirm" ? "请确认是否继续。" : "请完成当前操作。")}</p>
				{request.kind === "select" && <div className="select-options">{options.map((option) => <button key={option.id} type="button" onClick={() => run(guiStore.respondToUi(request, { value: option.id }))}><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</button>)}</div>}
				{request.kind === "editor" && <textarea autoFocus value={value} placeholder={typeof payload?.placeholder === "string" ? payload.placeholder : ""} onChange={(event) => setValue(event.target.value)} />}
				{(request.kind === "input" || request.kind === "secret") && <input className="dialog-input" autoFocus type={request.kind === "secret" ? "password" : "text"} value={value} placeholder={typeof payload?.placeholder === "string" ? payload.placeholder : ""} onChange={(event) => setValue(event.target.value)} />}
				<div className="dialog-actions">
					<button type="button" onClick={() => run(guiStore.respondToUi(request, { cancelled: true }))}>取消</button>
					{request.kind === "confirm" && <button className="primary" type="button" onClick={() => run(guiStore.respondToUi(request, { confirmed: true }))}>继续</button>}
					{(request.kind === "input" || request.kind === "secret" || request.kind === "editor") && <button className="primary" type="button" onClick={() => run(guiStore.respondToUi(request, { value }))}>确定</button>}
				</div>
			</div>
		</div>
	);
}

export function App() {
	const snapshot = useSyncExternalStore(guiStore.subscribe, guiStore.getSnapshot);
	const [mobileSidebar, setMobileSidebar] = useState(false);

	useEffect(() => {
		document.documentElement.dataset.theme = snapshot.theme === "system" ? "" : snapshot.theme;
	}, [snapshot.theme]);
	useEffect(() => {
		run(guiStore.connect());
	}, []);

	return (
		<div className="app-shell">
			<Sidebar mobileOpen={mobileSidebar} closeMobile={() => setMobileSidebar(false)} />
			<div
				className={`main-shell ${snapshot.gitInspectorOpen ? "inspector-open" : ""}`}
				style={{ "--inspector-width": `${snapshot.inspectorWidth}px` } as React.CSSProperties}
			>
				<Topbar openMobile={() => setMobileSidebar(true)} />
				<main className="workspace"><Transcript /><SessionLoadingOverlay /><Composer /></main>
				<GitInspector />
			</div>
			{snapshot.settingsPage && <SettingsView />}
			<ResourceViewer />
			{snapshot.pendingUi[0] && <UiRequestDialog request={snapshot.pendingUi[0]} />}
			{snapshot.toast && <button className="toast" type="button" onClick={() => guiStore.clearToast()}><AlertCircle size={16} />{snapshot.toast}<X size={14} /></button>}
			{snapshot.connectionError && !snapshot.connected && <div className="connection-banner"><Unplug size={15} />{snapshot.connectionError}</div>}
		</div>
	);
}
