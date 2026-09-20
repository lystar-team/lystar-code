import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { useEffect, useId, useRef, useState } from "react";
import type { ThemeMode } from "../../../state/use-workbench";
import { ensureMonacoLanguage, loadMonacoRuntime, setMonacoTheme } from "../monaco-runtime";

interface MonacoMarkdownEditorProps {
	ariaLabel?: string;
	disabled: boolean;
	fileName?: string;
	onChange: (value: string) => void;
	onSave: () => void;
	theme: ThemeMode;
	value: string;
}

export function MonacoMarkdownEditor({
	ariaLabel = "全局 AGENTS.md 内容",
	disabled,
	fileName = "AGENTS.md",
	onChange,
	onSave,
	theme,
	value,
}: MonacoMarkdownEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor>();
	const modelRef = useRef<Monaco.editor.ITextModel>();
	const monacoRef = useRef<typeof Monaco>();
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	const valueRef = useRef(value);
	const modelId = useId();
	const [ready, setReady] = useState(false);

	onChangeRef.current = onChange;
	onSaveRef.current = onSave;
	valueRef.current = value;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let disposed = false;
		let resizeObserver: ResizeObserver | undefined;
		let contentListener: Monaco.IDisposable | undefined;

		void loadMonacoRuntime().then(async (monaco) => {
			const language = await ensureMonacoLanguage(monaco, "markdown");
			if (disposed) return;
			const model = monaco.editor.createModel(
				valueRef.current,
				language,
				monaco.Uri.parse(`inmemory://lystar-settings/${encodeURIComponent(modelId)}/${encodeURIComponent(fileName)}`),
			);
			const editor = monaco.editor.create(container, {
				accessibilitySupport: "auto",
				ariaLabel,
				automaticLayout: false,
				bracketPairColorization: { enabled: true },
				codeLens: false,
				contextmenu: true,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
				fontSize: 14,
				folding: true,
				glyphMargin: false,
				language,
				lineHeight: 22,
				lineNumbersMinChars: 3,
				minimap: { enabled: true, maxColumn: 100, renderCharacters: false, showSlider: "mouseover" },
				model,
				padding: { bottom: 12, top: 12 },
				readOnly: disabled,
				renderValidationDecorations: "off",
				scrollBeyondLastLine: false,
				stickyScroll: { enabled: true },
				tabSize: 2,
				wordWrap: "on",
				wrappingIndent: "indent",
			});
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
			contentListener = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
			resizeObserver = new ResizeObserver(() => {
				const width = container.clientWidth;
				editor.updateOptions({
					lineNumbers: width < 520 ? "off" : "on",
					minimap: { enabled: width >= 720, maxColumn: 100, renderCharacters: false, showSlider: "mouseover" },
				});
				editor.layout();
			});
			resizeObserver.observe(container);
			monacoRef.current = monaco;
			modelRef.current = model;
			editorRef.current = editor;
			const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
			setMonacoTheme(monaco, theme === "dark" || (theme === "system" && systemDark));
			setReady(true);
		});

		return () => {
			disposed = true;
			resizeObserver?.disconnect();
			contentListener?.dispose();
			editorRef.current?.dispose();
			modelRef.current?.dispose();
			editorRef.current = undefined;
			modelRef.current = undefined;
			monacoRef.current = undefined;
		};
	}, [ariaLabel, fileName, modelId]);

	useEffect(() => {
		const model = modelRef.current;
		if (ready && model && model.getValue() !== value) model.setValue(value);
	}, [ready, value]);

	useEffect(() => {
		editorRef.current?.updateOptions({ readOnly: disabled });
	}, [disabled]);

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const applyTheme = () => {
			const monaco = monacoRef.current;
			if (monaco) setMonacoTheme(monaco, theme === "dark" || (theme === "system" && media.matches));
		};
		applyTheme();
		media.addEventListener("change", applyTheme);
		return () => media.removeEventListener("change", applyTheme);
	}, [theme]);

	return (
		<div className="relative flex h-[clamp(320px,calc(100dvh-23rem),680px)] min-w-0 flex-col overflow-hidden rounded-lg border border-border/70 bg-background md:h-[clamp(360px,calc(100dvh-19rem),800px)]">
			<div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 bg-muted/30 px-3 text-xs text-muted-foreground">
				<span>Markdown</span>
				<span>Ctrl/⌘ + S 保存</span>
			</div>
			<div ref={containerRef} className="min-h-0 flex-1" />
			{!ready ? (
				<div className="absolute inset-x-0 top-9 bottom-0 flex items-center justify-center bg-background text-sm text-muted-foreground" role="status">
					正在加载编辑器
				</div>
			) : null}
		</div>
	);
}
