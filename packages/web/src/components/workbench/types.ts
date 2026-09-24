import type { GitMutation } from "@lystar/code-web-protocol";
import type { ComposerMode, InspectorMode, SettingsTab, ThemeMode, WorkbenchState } from "../../state/use-workbench";
import type {
	FileResponse,
	PromptAttachment,
	PromptAttachmentPreview,
	SubagentConfig,
	UiRequestEvent,
	WebModelProviderInput,
	WebProject,
	WebProviderModelInput,
	WebThinkingLevel,
} from "../../types";

export interface PromptEditRequest {
	sessionId: string;
	entryId: string;
	text: string;
	attachments: PromptAttachmentPreview[];
}

export interface WorkbenchActions {
	selectProject: (projectId: string) => Promise<void>;
	selectSession: (sessionId: string) => Promise<void>;
	createSession: (agentProfile?: Pick<SubagentConfig, "name" | "icon">) => Promise<void>;
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
	refreshSessionNameSettings: () => Promise<void>;
	saveSessionNameSettings: (input: { model?: string; thinkingLevel: WebThinkingLevel }) => Promise<void>;
	closeSettings: () => void;
	signOut: () => void;
	setComposerMode: (mode: ComposerMode) => void;
	loadEarlier: () => Promise<void>;
	openSubagent: (agentId: string) => Promise<void>;
	closeSubagent: () => void;
	loadEarlierSubagent: () => Promise<void>;
	abortSubagent: () => Promise<void>;
	continueSubagent: (text: string) => Promise<void>;
	loadTranscript: () => Promise<void>;
	loadGitStatus: () => Promise<void>;
	loadGitRepositoryStats: (repositoryPath?: string) => Promise<void>;
	loadGitBranches: (repositoryPath?: string) => Promise<void>;
	loadGitHistory: (repositoryPath?: string, offset?: number, append?: boolean) => Promise<void>;
	loadGitCommit: (revision: string, repositoryPath?: string, path?: string) => Promise<void>;
	closeGitCommit: () => void;
	mutateGit: (mutation: GitMutation, repositoryPath?: string) => Promise<boolean>;
	closeGitCredentialAuthorization: () => void;
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
	reorderProjectGroups: (groupIds: string[]) => Promise<void>;
	reorderProjects: (projectIds: string[]) => Promise<void>;
	reorderSessions: (projectId: string, sessionIds: string[]) => Promise<void>;
	removeProject: (projectId: string) => Promise<void>;
	deleteSession: (sessionId: string) => Promise<boolean>;
	deleteSessions: (sessionIds: string[]) => Promise<string[]>;
	renameSession: (sessionId: string, name: string) => Promise<void>;
	setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
	fork: (entryId: string) => Promise<void>;
	reloadResources: () => Promise<void>;
	refreshProjectSessions: (projectId: string) => Promise<void>;
	compact: (customInstructions?: string) => Promise<void>;
	exportSession: () => Promise<void>;
	updateModel: (provider: string, id: string) => Promise<void>;
	updateThinking: (level: string) => Promise<void>;
	setModelProviderVisibility: (providerId: string, visible: boolean) => void;
	saveModelProvider: (input: WebModelProviderInput) => Promise<void>;
	removeModelProvider: (providerId: string) => Promise<void>;
	saveProviderModel: (provider: string, input: WebProviderModelInput) => Promise<void>;
	setProviderModelEnabled: (provider: string, modelId: string, enabled: boolean) => Promise<void>;
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
	refreshHarnessImports: () => Promise<void>;
	importHarnessResources: (itemIds: string[]) => Promise<void>;
	refreshSubagentConfigs: () => Promise<void>;
	saveSubagentConfig: (input: {
		scope: "user" | "project";
		originalName?: string;
		name: string;
		description: string;
		icon?: string;
		provider?: string;
		model?: string;
		thinkingLevel?: WebThinkingLevel;
		tools?: string[];
		skills?: string[];
		tags?: string[];
		content: string;
		expectedHash?: string;
	}) => Promise<boolean>;
	deleteSubagentConfig: (config: SubagentConfig) => Promise<boolean>;
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
