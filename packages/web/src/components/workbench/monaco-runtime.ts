import type * as Monaco from "monaco-editor/editor/editor.api.js";

interface MonacoEnvironment {
	getWorker: (moduleId: string, label: string) => Worker;
}

const globalScope = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoEnvironment };
const languageLoadPromises = new Map<string, Promise<unknown>>();
let runtimePromise: Promise<typeof Monaco> | undefined;

const lazyLanguageLoaders: Record<string, () => Promise<unknown>> = {
	bat: () => import("monaco-editor/languages/definitions/bat/register.js"),
	c: () => import("monaco-editor/languages/definitions/cpp/register.js"),
	cpp: () => import("monaco-editor/languages/definitions/cpp/register.js"),
	csharp: () => import("monaco-editor/languages/definitions/csharp/register.js"),
	css: () => import("monaco-editor/languages/definitions/css/register.js"),
	dart: () => import("monaco-editor/languages/definitions/dart/register.js"),
	dockerfile: () => import("monaco-editor/languages/definitions/dockerfile/register.js"),
	go: () => import("monaco-editor/languages/definitions/go/register.js"),
	graphql: () => import("monaco-editor/languages/definitions/graphql/register.js"),
	hcl: () => import("monaco-editor/languages/definitions/hcl/register.js"),
	html: () => import("monaco-editor/languages/definitions/html/register.js"),
	ini: () => import("monaco-editor/languages/definitions/ini/register.js"),
	java: () => import("monaco-editor/languages/definitions/java/register.js"),
	javascript: () => import("monaco-editor/languages/definitions/javascript/register.js"),
	json: () => import("monaco-editor/languages/features/json/register.js"),
	julia: () => import("monaco-editor/languages/definitions/julia/register.js"),
	kotlin: () => import("monaco-editor/languages/definitions/kotlin/register.js"),
	less: () => import("monaco-editor/languages/definitions/less/register.js"),
	markdown: () => import("monaco-editor/languages/definitions/markdown/register.js"),
	mdx: () => import("monaco-editor/languages/definitions/mdx/register.js"),
	objectivec: () => import("monaco-editor/languages/definitions/objective-c/register.js"),
	perl: () => import("monaco-editor/languages/definitions/perl/register.js"),
	php: () => import("monaco-editor/languages/definitions/php/register.js"),
	powershell: () => import("monaco-editor/languages/definitions/powershell/register.js"),
	python: () => import("monaco-editor/languages/definitions/python/register.js"),
	ruby: () => import("monaco-editor/languages/definitions/ruby/register.js"),
	rust: () => import("monaco-editor/languages/definitions/rust/register.js"),
	scala: () => import("monaco-editor/languages/definitions/scala/register.js"),
	scss: () => import("monaco-editor/languages/definitions/scss/register.js"),
	shell: () => import("monaco-editor/languages/definitions/shell/register.js"),
	solidity: () => import("monaco-editor/languages/definitions/solidity/register.js"),
	sql: () => import("monaco-editor/languages/definitions/sql/register.js"),
	swift: () => import("monaco-editor/languages/definitions/swift/register.js"),
	systemverilog: () => import("monaco-editor/languages/definitions/systemverilog/register.js"),
	typescript: () => import("monaco-editor/languages/definitions/typescript/register.js"),
	xml: () => import("monaco-editor/languages/definitions/xml/register.js"),
	yaml: () => import("monaco-editor/languages/definitions/yaml/register.js"),
};

export function loadMonacoRuntime(): Promise<typeof Monaco> {
	if (runtimePromise) return runtimePromise;
	runtimePromise = Promise.all([
		import("monaco-editor/editor/editor.api.js"),
		import("monaco-editor/editor/editor.worker.js?worker"),
	]).then(([monaco, editorWorkerModule]) => {
		globalScope.MonacoEnvironment = {
			getWorker() {
				return new editorWorkerModule.default();
			},
		};
		return monaco;
	});
	return runtimePromise;
}

function loadMonacoLanguageModule(language: string): Promise<unknown> {
	const loader = lazyLanguageLoaders[language];
	if (!loader) return Promise.resolve();
	const existing = languageLoadPromises.get(language);
	if (existing) return existing;
	const promise = loader();
	languageLoadPromises.set(language, promise);
	return promise;
}

export function preloadMonacoRuntime(): void {
	void loadMonacoRuntime().catch(() => {});
}

export function preloadMonacoLanguage(language: string): void {
	if (!lazyLanguageLoaders[language]) return;
	void Promise.all([loadMonacoRuntime(), loadMonacoLanguageModule(language)]).catch(() => {});
}

export function ensureMonacoLanguage(monaco: typeof Monaco, language: string): Promise<string> {
	if (language === "text" || monaco.languages.getLanguages().some((entry) => entry.id === language)) {
		return Promise.resolve(language);
	}
	return loadMonacoLanguageModule(language).then(
		() => (monaco.languages.getLanguages().some((entry) => entry.id === language) ? language : "text"),
		() => "text",
	);
}

export function setMonacoTheme(monaco: typeof Monaco, dark: boolean): void {
	monaco.editor.setTheme(dark ? "vs-dark" : "vs");
}
