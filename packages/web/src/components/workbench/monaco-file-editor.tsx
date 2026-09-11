import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { RefreshCw } from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import type { FileResponse } from "../../types.ts";
import { Button } from "../ui/button.tsx";
import { monacoLanguageForPath } from "./file-language.ts";
import { ensureMonacoLanguage, loadMonacoRuntime, setMonacoTheme } from "./monaco-runtime.ts";

const MAX_CACHED_MODELS = 8;
const LARGE_FILE_BYTES = 512 * 1024;
const LARGE_FILE_LINES = 20_000;

interface CachedModel {
	model: Monaco.editor.ITextModel;
	savedAlternativeVersionId: number;
	serverHash?: string;
	contentVersion?: string;
	pendingFile?: FileResponse;
	viewState?: Monaco.editor.ICodeEditorViewState | null;
	lastUsed: number;
}

const cachedModels = new Map<string, CachedModel>();

export interface MonacoFileEditorState {
	ready: boolean;
	dirty: boolean;
	saving: boolean;
	conflict: boolean;
	error?: string;
}

export interface MonacoFileEditorHandle {
	copy(): Promise<void>;
	download(filename: string): void;
	hasUnsavedChanges(): boolean;
	save(): Promise<void>;
}

interface MonacoFileEditorProps {
	dark: boolean;
	editable: boolean;
	file: FileResponse & { kind: "text"; content: string };
	modelKey: string;
	onSave: (content: string, expectedHash: string) => Promise<FileResponse>;
	onStateChange: (state: MonacoFileEditorState) => void;
}

function serverIdentity(file: FileResponse): string | undefined {
	return file.contentHash ?? file.contentVersion;
}

function isDirty(entry: CachedModel | undefined): boolean {
	return Boolean(entry && entry.model.getAlternativeVersionId() !== entry.savedAlternativeVersionId);
}

function applyServerFile(entry: CachedModel, file: FileResponse & { content: string }): void {
	if (entry.model.getValue() !== file.content) entry.model.setValue(file.content);
	entry.serverHash = file.contentHash;
	entry.contentVersion = file.contentVersion;
	entry.savedAlternativeVersionId = entry.model.getAlternativeVersionId();
	entry.pendingFile = undefined;
	entry.lastUsed = Date.now();
}

function trimModelCache(activeKey: string): void {
	if (cachedModels.size <= MAX_CACHED_MODELS) return;
	const removable = [...cachedModels.entries()]
		.filter(([key, entry]) => key !== activeKey && !isDirty(entry))
		.sort((left, right) => left[1].lastUsed - right[1].lastUsed);
	while (cachedModels.size > MAX_CACHED_MODELS) {
		const candidate = removable.shift();
		if (!candidate) return;
		cachedModels.delete(candidate[0]);
		candidate[1].model.dispose();
	}
}

export const MonacoFileEditor = forwardRef<MonacoFileEditorHandle, MonacoFileEditorProps>(
	function MonacoFileEditor({ dark, editable, file, modelKey, onSave, onStateChange }, ref) {
		const containerRef = useRef<HTMLDivElement>(null);
		const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor>();
		const monacoRef = useRef<typeof Monaco>();
		const activeKeyRef = useRef(modelKey);
		const darkRef = useRef(dark);
		const editableRef = useRef(editable);
		const onSaveRef = useRef(onSave);
		const onStateChangeRef = useRef(onStateChange);
		const publishStateRef = useRef<(update?: Partial<MonacoFileEditorState>) => void>(() => {});
		const saveRef = useRef<() => Promise<void>>(async () => {});
		const readyRef = useRef(false);
		const requestRef = useRef(0);
		const [ready, setReady] = useState(false);
		const [status, setStatus] = useState<MonacoFileEditorState>({
			ready: false,
			dirty: false,
			saving: false,
			conflict: false,
		});

		activeKeyRef.current = modelKey;
		darkRef.current = dark;
		editableRef.current = editable;
		onSaveRef.current = onSave;
		onStateChangeRef.current = onStateChange;

		const publishState = useCallback((update: Partial<MonacoFileEditorState> = {}) => {
			const entry = cachedModels.get(activeKeyRef.current);
			setStatus((current) => {
				const next = {
					...current,
					ready: readyRef.current,
					dirty: isDirty(entry),
					conflict: Boolean(entry?.pendingFile),
					...update,
				};
				onStateChangeRef.current(next);
				return next;
			});
		}, []);
		publishStateRef.current = publishState;

		const save = useCallback(async () => {
			const entry = cachedModels.get(activeKeyRef.current);
			if (!entry || !editableRef.current || !entry.serverHash || !isDirty(entry)) return;
			publishState({ saving: true, error: undefined });
			try {
				const saved = await onSaveRef.current(entry.model.getValue(), entry.serverHash);
				entry.serverHash = saved.contentHash;
				entry.contentVersion = saved.contentVersion;
				entry.savedAlternativeVersionId = entry.model.getAlternativeVersionId();
				entry.pendingFile = undefined;
				entry.lastUsed = Date.now();
				publishState({ saving: false, error: undefined });
			} catch (error) {
				publishState({
					saving: false,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}, [publishState]);
		saveRef.current = save;

		useImperativeHandle(
			ref,
			() => ({
				copy: async () => {
					const value = editorRef.current?.getValue() ?? "";
					if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持复制");
					await navigator.clipboard.writeText(value);
				},
				download: (filename) => {
					const value = editorRef.current?.getValue() ?? "";
					const url = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
					const link = document.createElement("a");
					link.href = url;
					link.download = filename;
					document.body.append(link);
					link.click();
					link.remove();
					URL.revokeObjectURL(url);
				},
				hasUnsavedChanges: () => isDirty(cachedModels.get(activeKeyRef.current)),
				save,
			}),
			[save],
		);

		useEffect(() => {
			const container = containerRef.current;
			if (!container) return;
			let disposed = false;
			let resizeObserver: ResizeObserver | undefined;
			let contentListener: Monaco.IDisposable | undefined;
			let modelListener: Monaco.IDisposable | undefined;
			void loadMonacoRuntime().then((monaco) => {
				if (disposed) return;
				const editor = monaco.editor.create(container, {
					automaticLayout: false,
					bracketPairColorization: { enabled: false },
					codeLens: false,
					contextmenu: true,
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
					fontSize: 13,
					folding: false,
					hover: { enabled: "off" },
					largeFileOptimizations: true,
					minimap: { enabled: false },
					model: null,
					readOnly: !editableRef.current,
					renderValidationDecorations: "off",
					scrollBeyondLastLine: false,
					stickyScroll: { enabled: false },
					tabSize: 4,
					wordWrap: "off",
				});
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
					void saveRef.current().catch(() => {}),
				);
				contentListener = editor.onDidChangeModelContent(() => publishStateRef.current({ error: undefined }));
				modelListener = editor.onDidChangeModel(() => publishStateRef.current({ error: undefined }));
				resizeObserver = new ResizeObserver(() => editor.layout());
				resizeObserver.observe(container);
				monacoRef.current = monaco;
				editorRef.current = editor;
				setMonacoTheme(monaco, darkRef.current);
				readyRef.current = true;
				setReady(true);
				publishStateRef.current({ ready: true });
			});
			return () => {
				disposed = true;
				const active = cachedModels.get(activeKeyRef.current);
				if (active && editorRef.current?.getModel() === active.model) active.viewState = editorRef.current.saveViewState();
				readyRef.current = false;
				resizeObserver?.disconnect();
				contentListener?.dispose();
				modelListener?.dispose();
				editorRef.current?.setModel(null);
				editorRef.current?.dispose();
				editorRef.current = undefined;
				monacoRef.current = undefined;
			};
		}, []);

		useEffect(() => {
			const editor = editorRef.current;
			const monaco = monacoRef.current;
			if (!ready || !editor || !monaco) return;
			const request = ++requestRef.current;
			const previousKey = editor.getModel()
				? [...cachedModels.entries()].find(([, entry]) => entry.model === editor.getModel())?.[0]
				: undefined;
			if (previousKey && previousKey !== modelKey) {
				const previous = cachedModels.get(previousKey);
				if (previous) previous.viewState = editor.saveViewState();
			}
			let entry = cachedModels.get(modelKey);
			if (!entry) {
				const model = monaco.editor.createModel(
					file.content,
					"text",
					monaco.Uri.parse(`inmemory://lystar-project/${encodeURIComponent(modelKey)}`),
				);
				entry = {
					model,
					savedAlternativeVersionId: model.getAlternativeVersionId(),
					serverHash: file.contentHash,
					contentVersion: file.contentVersion,
					lastUsed: Date.now(),
				};
				cachedModels.set(modelKey, entry);
			} else {
				const incomingIdentity = serverIdentity(file);
				const knownIdentity = entry.serverHash ?? entry.contentVersion;
				if (incomingIdentity && incomingIdentity !== knownIdentity) {
					if (isDirty(entry)) entry.pendingFile = file;
					else applyServerFile(entry, file);
				}
				entry.lastUsed = Date.now();
			}
			const largeFile = file.byteLength >= LARGE_FILE_BYTES || entry.model.getLineCount() >= LARGE_FILE_LINES;
			editor.updateOptions({ readOnly: !editable });
			editor.setModel(entry.model);
			if (entry.viewState) editor.restoreViewState(entry.viewState);
			editor.layout();
			trimModelCache(modelKey);
			publishState({ error: undefined });
			const enhancementFrame = window.requestAnimationFrame(() => {
				if (
					request !== requestRef.current ||
					editorRef.current !== editor ||
					cachedModels.get(modelKey) !== entry
				)
					return;
				editor.updateOptions({
					bracketPairColorization: { enabled: !largeFile },
					codeLens: !largeFile,
					folding: !largeFile,
					hover: { enabled: largeFile ? "off" : "on" },
					minimap: {
						enabled: true,
						maxColumn: 100,
						renderCharacters: !largeFile,
						showSlider: "mouseover",
					},
					stickyScroll: { enabled: !largeFile },
				});
			});
			void ensureMonacoLanguage(monaco, monacoLanguageForPath(file.path)).then((language) => {
				if (
					request !== requestRef.current ||
					editorRef.current !== editor ||
					cachedModels.get(modelKey) !== entry
				)
					return;
				if (entry.model.getLanguageId() !== language) monaco.editor.setModelLanguage(entry.model, language);
			});
			return () => {
				window.cancelAnimationFrame(enhancementFrame);
				if (request === requestRef.current) requestRef.current++;
			};
		}, [editable, file, modelKey, publishState, ready]);

		useEffect(() => {
			const monaco = monacoRef.current;
			if (monaco) setMonacoTheme(monaco, dark);
		}, [dark]);

		const useDiskVersion = useCallback(() => {
			const entry = cachedModels.get(activeKeyRef.current);
			if (typeof entry?.pendingFile?.content !== "string") return;
			applyServerFile(entry, entry.pendingFile as FileResponse & { content: string });
			publishState({ error: undefined });
		}, [publishState]);

		return (
			<div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-background">
				{status.conflict ? (
					<div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
						<span>磁盘文件已变化，本地未保存内容没有被覆盖。</span>
						<Button size="xs" variant="outline" onClick={useDiskVersion}>
							<RefreshCw className="size-3.5" />
							使用磁盘版本
						</Button>
					</div>
				) : null}
				{status.error ? (
					<div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
						{status.error}
					</div>
				) : null}
				<div ref={containerRef} className="min-h-0 flex-1" />
				{!ready ? (
					<div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
						正在加载编辑器
					</div>
				) : null}
			</div>
		);
	},
);
