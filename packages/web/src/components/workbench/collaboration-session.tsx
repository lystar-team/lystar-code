import {
	Bot,
	Braces,
	Brain,
	BriefcaseBusiness,
	Bug,
	Calculator,
	CalendarCheck2,
	Camera,
	ChartNoAxesColumn,
	ChartPie,
	CheckCircle2,
	CircleGauge,
	ClipboardList,
	Cloud,
	Code2,
	Compass,
	Cpu,
	Database,
	FileCode2,
	FileSearch,
	FileText,
	FlaskConical,
	FolderCode,
	Gauge,
	GitBranch,
	GitMerge,
	Globe2,
	Hammer,
	Handshake,
	HeartPulse,
	House,
	KeyRound,
	Landmark,
	Languages,
	Layers3,
	LayoutDashboard,
	Lightbulb,
	ListChecks,
	ListTree,
	LockKeyhole,
	Mail,
	Map as MapIcon,
	Megaphone,
	MessageSquare,
	MessagesSquare,
	Microscope,
	Monitor,
	Network,
	PackageCheck,
	Palette,
	PenTool,
	PlugZap,
	Presentation,
	Puzzle,
	Radar,
	ReceiptText,
	Rocket,
	Route,
	ScanSearch,
	ScrollText,
	SearchCode,
	Server,
	Settings2,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
	SquareTerminal,
	Star,
	Stethoscope,
	Table2,
	Tags,
	Target,
	Telescope,
	TerminalSquare,
	TestTube2,
	ThumbsUp,
	Timer,
	ToyBrick,
	TreePine,
	TrendingUp,
	Trophy,
	UploadCloud,
	UserRound,
	UsersRound,
	WandSparkles,
	Webhook,
	Workflow,
	Wrench,
	Zap,
	type LucideIcon,
} from "lucide-react";
import type { WebCompletionResult, WebRoomMember, WebSessionSummary } from "../../types";

const AGENT_ALIASES = [
	"霜叶",
	"海盐",
	"纸鸢",
	"星野",
	"青岚",
	"松墨",
	"云砚",
	"川柏",
	"月白",
	"南枝",
	"远山",
	"清和",
] as const;

export type CollaborationAgentKind = "main" | "code" | "test" | "document" | "research" | "general";

export const AGENT_ICON_OPTIONS = [
	{ value: "main", label: "对话", icon: MessageSquare },
	{ value: "code", label: "代码", icon: Braces },
	{ value: "test", label: "测试", icon: CheckCircle2 },
	{ value: "document", label: "文档", icon: FileText },
	{ value: "research", label: "调研", icon: SearchCode },
	{ value: "general", label: "终端", icon: TerminalSquare },
	{ value: "bot", label: "机器人", icon: Bot },
	{ value: "brain", label: "智能", icon: Brain },
	{ value: "briefcase", label: "业务", icon: BriefcaseBusiness },
	{ value: "bug", label: "缺陷", icon: Bug },
	{ value: "calculator", label: "计算", icon: Calculator },
	{ value: "calendar", label: "计划", icon: CalendarCheck2 },
	{ value: "camera", label: "视觉", icon: Camera },
	{ value: "chart", label: "分析", icon: ChartNoAxesColumn },
	{ value: "chart-pie", label: "指标", icon: ChartPie },
	{ value: "gauge", label: "监控", icon: CircleGauge },
	{ value: "clipboard", label: "清单", icon: ClipboardList },
	{ value: "cloud", label: "云端", icon: Cloud },
	{ value: "code-2", label: "开发", icon: Code2 },
	{ value: "compass", label: "导航", icon: Compass },
	{ value: "cpu", label: "计算机", icon: Cpu },
	{ value: "database", label: "数据", icon: Database },
	{ value: "file-code", label: "文件开发", icon: FileCode2 },
	{ value: "file-search", label: "文件检索", icon: FileSearch },
	{ value: "flask", label: "实验", icon: FlaskConical },
	{ value: "folder-code", label: "项目代码", icon: FolderCode },
	{ value: "gauge-2", label: "仪表盘", icon: Gauge },
	{ value: "git-branch", label: "分支", icon: GitBranch },
	{ value: "git-merge", label: "合并", icon: GitMerge },
	{ value: "globe", label: "全局", icon: Globe2 },
	{ value: "hammer", label: "构建", icon: Hammer },
	{ value: "handshake", label: "协作", icon: Handshake },
	{ value: "heart-pulse", label: "健康", icon: HeartPulse },
	{ value: "house", label: "基础", icon: House },
	{ value: "key", label: "权限", icon: KeyRound },
	{ value: "landmark", label: "组织", icon: Landmark },
	{ value: "languages", label: "语言", icon: Languages },
	{ value: "layers", label: "分层", icon: Layers3 },
	{ value: "dashboard", label: "工作台", icon: LayoutDashboard },
	{ value: "lightbulb", label: "创意", icon: Lightbulb },
	{ value: "list-checks", label: "校验", icon: ListChecks },
	{ value: "list-tree", label: "目录", icon: ListTree },
	{ value: "lock", label: "安全", icon: LockKeyhole },
	{ value: "mail", label: "邮件", icon: Mail },
	{ value: "map", label: "地图", icon: MapIcon },
	{ value: "megaphone", label: "通知", icon: Megaphone },
	{ value: "monitor", label: "桌面", icon: Monitor },
	{ value: "network", label: "网络", icon: Network },
	{ value: "package", label: "交付", icon: PackageCheck },
	{ value: "palette", label: "设计", icon: Palette },
	{ value: "pen-tool", label: "绘制", icon: PenTool },
	{ value: "plug", label: "连接", icon: PlugZap },
	{ value: "presentation", label: "演示", icon: Presentation },
	{ value: "puzzle", label: "拼装", icon: Puzzle },
	{ value: "radar", label: "探测", icon: Radar },
	{ value: "receipt", label: "记录", icon: ReceiptText },
	{ value: "rocket", label: "发布", icon: Rocket },
	{ value: "route", label: "流程", icon: Route },
	{ value: "scan", label: "扫描", icon: ScanSearch },
	{ value: "scroll", label: "文档流", icon: ScrollText },
	{ value: "server", label: "服务", icon: Server },
	{ value: "settings", label: "配置", icon: Settings2 },
	{ value: "shield", label: "防护", icon: ShieldCheck },
	{ value: "sliders", label: "调节", icon: SlidersHorizontal },
	{ value: "sparkles", label: "智能化", icon: Sparkles },
	{ value: "star", label: "重点", icon: Star },
	{ value: "stethoscope", label: "诊断", icon: Stethoscope },
	{ value: "table", label: "表格", icon: Table2 },
	{ value: "tags", label: "标签", icon: Tags },
	{ value: "target", label: "目标", icon: Target },
	{ value: "telescope", label: "观察", icon: Telescope },
	{ value: "test-tube", label: "实验测试", icon: TestTube2 },
	{ value: "thumbs-up", label: "验收", icon: ThumbsUp },
	{ value: "timer", label: "计时", icon: Timer },
	{ value: "toy-brick", label: "组件", icon: ToyBrick },
	{ value: "tree", label: "结构", icon: TreePine },
	{ value: "trending-up", label: "增长", icon: TrendingUp },
	{ value: "trophy", label: "成果", icon: Trophy },
	{ value: "upload", label: "导入", icon: UploadCloud },
	{ value: "user", label: "用户", icon: UserRound },
	{ value: "users", label: "团队", icon: UsersRound },
	{ value: "wand", label: "自动化", icon: WandSparkles },
	{ value: "webhook", label: "接口", icon: Webhook },
	{ value: "workflow", label: "工作流", icon: Workflow },
	{ value: "wrench", label: "工具", icon: Wrench },
	{ value: "zap", label: "快速", icon: Zap },
] as const;

export type AgentIconKey = (typeof AGENT_ICON_OPTIONS)[number]["value"];

export function isCollaborationSession(session: WebSessionSummary | undefined): boolean {
	return session?.relation === "collaboration" && Boolean(session.parentId);
}

export function collaborationAlias(sessionId: string): string {
	let hash = 2166136261;
	for (const character of sessionId) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return AGENT_ALIASES[Math.abs(hash) % AGENT_ALIASES.length]!;
}

export function collaborationAgentKind(session: WebSessionSummary | undefined): CollaborationAgentKind {
	if (!session) return "main";
	const value = `${session.profileId ?? ""} ${session.profileName ?? ""} ${session.profileIcon ?? ""}`.toLowerCase();
	if (/test|qa|verify|验证|测试/u.test(value)) return "test";
	if (/doc|writer|文档|整理/u.test(value)) return "document";
	if (/research|search|调研|检索/u.test(value)) return "research";
	if (/code|review|develop|代码|审阅|开发/u.test(value)) return "code";
	return "general";
}

export function collaborationAgentIcon(kind: CollaborationAgentKind): LucideIcon {
	switch (kind) {
		case "main":
			return MessageSquare;
		case "code":
			return Braces;
		case "test":
			return CheckCircle2;
		case "document":
			return FileText;
		case "research":
			return SearchCode;
		case "general":
			return TerminalSquare;
	}
}

export function collaborationAgentIconForKey(iconKey: string | undefined): LucideIcon | undefined {
	const configured = iconKey?.trim().toLowerCase();
	if (!configured) return undefined;
	return AGENT_ICON_OPTIONS.find((candidate) => candidate.value === configured)?.icon;
}

export function collaborationAgentIconForSession(session: WebSessionSummary | undefined): LucideIcon {
	return collaborationAgentIconForKey(session?.profileIcon) ?? collaborationAgentIcon(collaborationAgentKind(session));
}

export function collaborationAgentIconForMember(
	member: Pick<WebRoomMember, "profileIcon"> | undefined,
	session: WebSessionSummary | undefined,
): LucideIcon {
	return collaborationAgentIconForKey(member?.profileIcon) ?? collaborationAgentIconForSession(session);
}

export function AgentIdentityIcon({
	iconKey,
	member,
	session,
	className,
}: {
	iconKey?: string;
	member?: Pick<WebRoomMember, "profileIcon">;
	session?: WebSessionSummary;
	className?: string;
}) {
	const source = iconKey?.trim() || member?.profileIcon?.trim() || session?.profileIcon?.trim();
	if (source?.startsWith("data:image/svg+xml") || source?.startsWith("https://") || source?.startsWith("/")) {
		return <img alt="" aria-hidden="true" className={className} draggable={false} src={source} />;
	}
	const Icon = collaborationAgentIconForKey(source) ?? collaborationAgentIconForMember(member, session);
	return <Icon className={className} aria-hidden="true" />;
}

export function collaborationAgentType(session: WebSessionSummary | undefined): string {
	if (!session) return "主智能体";
	return session.profileName?.trim() || "协作智能体";
}

export function collaborationSessionsForSession(
	sessions: readonly WebSessionSummary[],
	sessionId: string | undefined,
): WebSessionSummary[] {
	if (!sessionId) return [];
	const current = sessions.find((session) => session.id === sessionId);
	if (!current) return [];
	const rootId = current.relation === "collaboration" && current.parentId ? current.parentId : current.id;
	const root = sessions.find((session) => session.id === rootId);
	const children = sessions.filter(
		(session) => session.relation === "collaboration" && session.parentId === rootId,
	);
	return root && children.length ? [root, ...children] : [];
}

export interface RoomAgentMention {
	sessionId: string;
	item: WebCompletionResult["items"][number];
}

export function roomAgentMentions(
	sessions: readonly WebSessionSummary[],
	members: readonly WebRoomMember[] = [],
): RoomAgentMention[] {
	const aliasCounts = new Map<string, number>();
	const memberBySessionId = new Map(members.map((member) => [member.sessionId, member]));
	return sessions.map((session) => {
		const member = memberBySessionId.get(session.id);
		const alias = member?.nickname?.trim() || collaborationAlias(session.id);
		const count = (aliasCounts.get(alias) ?? 0) + 1;
		aliasCounts.set(alias, count);
		const mention = `@${alias}${count > 1 ? `-${count}` : ""}`;
		const roleName = member?.profileName?.trim() || session.profileName?.trim() || "协作智能体";
		return {
			sessionId: session.id,
			item: {
				value: mention,
				label: `${mention} · ${roleName}`,
				description: `${roleName} · ${session.activity === "running" ? "进行中" : "可响应"}`,
				kind: "agent",
			},
		};
	});
}

export function roomAgentCompletionItems(
	sessions: readonly WebSessionSummary[],
	members: readonly WebRoomMember[] = [],
): WebCompletionResult["items"] {
	return roomAgentMentions(sessions, members).map(({ item }) => item);
}

export function collaborationStatus(session: WebSessionSummary | undefined, current = false): string {
	if (current) return "当前";
	switch (session?.activity) {
		case "running":
			return "进行中";
		case "waiting_for_input":
			return "等待回复";
		case "completed":
			return "已完成";
		case "failed":
			return "失败";
		case "aborted":
			return "已停止";
		case "interrupted":
			return "已中断";
		case "idle":
		default:
			return "空闲";
	}
}
