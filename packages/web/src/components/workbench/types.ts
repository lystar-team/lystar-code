import type { ComposerMode, InspectorMode, SettingsTab, ThemeMode, WorkbenchState } from "../../state/use-workbench";
import type {
	FileResponse,
	PromptAttachment,
	PromptAttachmentPreview,
	UiRequestEvent,
	WebModelProviderInput,
	WebProject,
	WebProviderModelInput,
} from "../../types";

export interface WorkbenchActions {
	selectProject: (projectId: string) => Promise<void>;
	selectSession: (sessionId: string) => Promise<void>;
	createSession: () => Promise<void>;
	sendMessage: (
		text: string,
		mode?: ComposerMode,
		attachments?: PromptAttachment[],
		attachmentPreviews?: PromptAttachmentPreview[],
		displayText?: string,
	) => Promise<void>;
	queueAction: (queueId: string, action: "remove" | "steer") => Promise<void>;
	abort: () => Promise<void>;
	openInspector: (mode?: InspectorMode) => Promise<void>;
	closeInspector: () => void;
	openSettings: (tab?: SettingsTab) => Promise<void>;
	refreshBranding: () => Promise<void>;
	saveBranding: (input: { name: string; logo?: string | null }) => Promise<void>;
	closeSettings: () => void;
	signOut: () => void;
	setComposerMode: (mode: ComposerMode) => void;
	loadEarlier: () => Promise<void>;
	loadTranscript: () => Promise<void>;
	loadGitStatus: () => Promise<void>;
	loadGitRepositoryStats: (repositoryPath?: string) => Promise<void>;
	loadGitDiff: (path?: string, staged?: boolean, repositoryPath?: string) => Promise<void>;
	closeGitDiff: () => void;
	loadProjectTree: (path?: string, preserveCurrentTree?: boolean) => Promise<void>;
	openFile: (path: string) => Promise<void>;
	openResource: (path: string) => Promise<void>;
	saveFile: (path: string, content: string, expectedHash: string) => Promise<FileResponse>;
	closeFilePreview: () => void;
	loadSessionTree: () => Promise<void>;
	navigateTree: (entryId: string) => Promise<void>;
	loadDirectory: (path?: string) => Promise<void>;
	addProject: (cwd: string, name?: string) => Promise<void>;
	updateProject: (
		projectId: string,
		update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>,
	) => Promise<void>;
	addProjectGroup: (name: string) => Promise<boolean>;
	updateProjectGroup: (groupId: string, name: string) => Promise<boolean>;
	removeProjectGroup: (groupId: string) => Promise<boolean>;
	setProjectGroup: (projectId: string, groupId?: string) => Promise<boolean>;
	reorderProjects: (projectIds: string[]) => Promise<void>;
	reorderSessions: (projectId: string, sessionIds: string[]) => Promise<void>;
	removeProject: (projectId: string) => Promise<void>;
	deleteSession: (sessionId: string) => Promise<boolean>;
	renameSession: (sessionId: string, name: string) => Promise<void>;
	setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
	fork: (entryId: string) => Promise<void>;
	reloadResources: () => Promise<void>;
	compact: (customInstructions?: string) => Promise<void>;
	exportSession: () => Promise<void>;
	updateModel: (provider: string, id: string) => Promise<void>;
	updateThinking: (level: string) => Promise<void>;
	setModelProviderVisibility: (providerId: string, visible: boolean) => void;
	saveModelProvider: (input: WebModelProviderInput) => Promise<void>;
	saveProviderModel: (provider: string, input: WebProviderModelInput) => Promise<void>;
	syncModelProvider: (provider: string) => Promise<void>;
	refreshSkills: () => Promise<void>;
	refreshDiagnostics: () => Promise<void>;
	refreshSecuritySettings: () => Promise<void>;
	saveSecuritySettings: (input: {
		host: string;
		allowedHosts: string[];
		port: number;
		runtimePort: number;
		password?: string;
	}) => Promise<void>;
	restartDiagnosticService: (service: "gateway" | "runtime") => Promise<void>;
	refreshHarnessImports: (targetScope?: "user" | "project") => Promise<void>;
	importHarnessResources: (
		targetScope: "user" | "project",
		itemIds: string[],
		ruleSelections?: Record<string, string[]>,
		replaceItemIds?: string[],
	) => Promise<void>;
	toggleSkill: (skill: WorkbenchState["skills"][number]) => Promise<void>;
	refreshHostInstructions: () => Promise<void>;
	saveHostInstruction: (content: string, expectedHash?: string) => Promise<void>;
	setTheme: (theme: ThemeMode) => void;
	setProjectTrust: (trusted: boolean) => Promise<void>;
	respondUiRequest: (
		request: UiRequestEvent,
		response: { value?: unknown; confirmed?: boolean; cancelled?: boolean },
	) => Promise<void>;
	showToast: (message: string) => void;
}
