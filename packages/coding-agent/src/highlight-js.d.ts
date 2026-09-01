type HighlightLanguage = (hljs?: unknown) => unknown;

interface HighlightCore {
	registerLanguage(name: string, language: HighlightLanguage): void;
	highlight(
		code: string,
		options: { language: string; ignoreIllegals?: boolean },
	): { value: string };
	highlightAuto(code: string, languageSubset?: string[]): { value: string };
	getLanguage(name: string): unknown;
}

declare module "highlight.js/lib/core.js" {
	const hljs: HighlightCore;
	export default hljs;
}

declare module "highlight.js/lib/index.js" {
	const hljs: HighlightCore;
	export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
	const language: HighlightLanguage;
	export default language;
}
