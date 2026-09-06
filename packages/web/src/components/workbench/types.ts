import type { ComposerMode, InspectorMode, SettingsTab, ThemeMode, WorkbenchState } from "../../state/use-workbench";
import type { UiRequestEvent, WebModelProviderInput, WebProject, WebProviderModelInput } from "../../types";

export interface WorkbenchActions {
	selectProject: (projectId: string) => Promise<void>;
	selectSession: (sessionId: string) => Promise<void>;
	createSession: () => Promise<void>;
	sendMessage: (
		text: string,
		mode?: ComposerMode,
		images?: Array<{ data: string; mimeType: string }>,
	) => Promise<void>;
	abort: () => Promise<void>;
	openInspector: (mode?: InspectorMode) => Promise<void>;
	closeInspector: () => void;
	openSettings: (tab?: SettingsTab) => Promise<void>;
	closeSettings: () => void;
	signOut: () => void;
	setComposerMode: (mode: ComposerMode) => void;
	loadEarlier: () => Promise<void>;
	loadTranscript: () => Promise<void>;
	loadGitStatus: () => Promise<void>;
	loadGitDiff: (path?: string, staged?: boolean) => Promise<void>;
	loadProjectTree: (path?: string, preserveCurrentTree?: boolean) => Promise<void>;
	openFile: (path: string) => Promise<void>;
	openResource: (path: string) => Promise<void>;
	closeFilePreview: () => void;
	loadSessionTree: () => Promise<void>;
	navigateTree: (entryId: string) => Promise<void>;
	loadDirectory: (path?: string) => Promise<void>;
	addProject: (cwd: string, name?: string) => Promise<void>;
	updateProject: (
		projectId: string,
		update: Partial<Pick<WebProject, "name" | "pinned" | "color" | "archived">>,
	) => Promise<void>;
	reorderProjects: (projectIds: string[]) => Promise<void>;
	reorderSessions: (projectId: string, sessionIds: string[]) => Promise<void>;
	removeProject: (projectId: string) => Promise<void>;
	deleteSession: (sessionId: string) => Promise<void>;
	renameSession: (sessionId: string, name: string) => Promise<void>;
	setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;
	fork: (entryId: string) => Promise<void>;
	compact: () => Promise<void>;
	exportSession: () => Promise<void>;
	updateModel: (provider: string, id: string) => Promise<void>;
	updateThinking: (level: string) => Promise<void>;
	setModelProviderVisibility: (providerId: string, visible: boolean) => void;
	saveModelProvider: (input: WebModelProviderInput) => Promise<void>;
	saveProviderModel: (provider: string, input: WebProviderModelInput) => Promise<void>;
	syncModelProvider: (provider: string) => Promise<void>;
	refreshSkills: () => Promise<void>;
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
