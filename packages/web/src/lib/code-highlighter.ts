import { bundledLanguagesInfo, getSingletonHighlighter } from "shiki";
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import type {
	BundledLanguage as StreamdownBundledLanguage,
	BundledTheme as StreamdownBundledTheme,
	CodeHighlighterPlugin,
} from "streamdown";

const DEFAULT_THEMES: [BundledTheme, BundledTheme] = ["github-light", "github-dark"];
const MAX_CACHE_ENTRIES = 48;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

const supportedLanguages = new Set<string>(bundledLanguagesInfo.map((language) => language.id));

export interface TokenizedCode {
	bg: string;
	fg: string;
	tokens: ThemedToken[][];
}

type CacheEntry = {
	value: TokenizedCode;
	bytes: number;
};

type HighlightListener = (result: TokenizedCode) => void;

const tokenCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<TokenizedCode | undefined>>();
const listeners = new Map<string, Set<HighlightListener>>();
let tokenCacheBytes = 0;
let highlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | undefined;

function hashText(value: string): string {
	let first = 2166136261;
	let second = 0x9e3779b9;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		first = Math.imul(first ^ code, 16777619);
		second = Math.imul(second ^ (code + index), 2246822519);
	}
	return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}-${value.length.toString(36)}`;
}

function cacheKey(code: string, language: BundledLanguage): string {
	return `${language}:${hashText(code)}`;
}

function estimateTokenBytes(value: TokenizedCode): number {
	let bytes = 128 + (value.bg.length + value.fg.length) * 2;
	for (const line of value.tokens) {
		bytes += 32;
		for (const token of line) {
			bytes += 48 + token.content.length * 2;
			if (token.color) bytes += token.color.length * 2;
			if (token.bgColor) bytes += token.bgColor.length * 2;
			if (token.htmlStyle) bytes += Object.keys(token.htmlStyle).length * 32;
		}
	}
	return bytes;
}

function removeCacheEntry(key: string): void {
	const entry = tokenCache.get(key);
	if (!entry) return;
	tokenCache.delete(key);
	tokenCacheBytes -= entry.bytes;
}

function setCacheEntry(key: string, value: TokenizedCode): void {
	const bytes = estimateTokenBytes(value);
	if (bytes > MAX_CACHE_BYTES) return;
	removeCacheEntry(key);
	tokenCache.set(key, { value, bytes });
	tokenCacheBytes += bytes;
	while (tokenCache.size > MAX_CACHE_ENTRIES || tokenCacheBytes > MAX_CACHE_BYTES) {
		const oldest = tokenCache.keys().next().value;
		if (typeof oldest !== "string") break;
		removeCacheEntry(oldest);
	}
}

function cachedValue(key: string): TokenizedCode | undefined {
	const entry = tokenCache.get(key);
	if (!entry) return undefined;
	tokenCache.delete(key);
	tokenCache.set(key, entry);
	return entry.value;
}

function notifyListeners(key: string, value: TokenizedCode): void {
	const pending = listeners.get(key);
	if (!pending) return;
	listeners.delete(key);
	for (const listener of pending) listener(value);
}

function getHighlighter(): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
	highlighterPromise ??= getSingletonHighlighter({ themes: DEFAULT_THEMES, langs: ["text"] });
	return highlighterPromise;
}

function startHighlight(key: string, code: string, language: BundledLanguage): void {
	if (inFlight.has(key)) return;
	const task = Promise.resolve()
		.then(async () => {
			if (!supportedLanguages.has(language)) return undefined;
			const highlighter = await getHighlighter();
			if (!highlighter.getLoadedLanguages().includes(language)) await highlighter.loadLanguage(language);
			const loadedLanguage = highlighter.getLoadedLanguages().includes(language) ? language : "text";
			const result = highlighter.codeToTokens(code, {
				lang: loadedLanguage,
				themes: { light: DEFAULT_THEMES[0], dark: DEFAULT_THEMES[1] },
			});
			return {
				bg: result.bg ?? "transparent",
				fg: result.fg ?? "inherit",
				tokens: result.tokens,
			};
		})
		.then(
			(result) => {
				inFlight.delete(key);
				if (result) {
					setCacheEntry(key, result);
					notifyListeners(key, result);
				}
				return result;
			},
			(error: unknown) => {
				inFlight.delete(key);
				listeners.delete(key);
				console.error("代码高亮失败:", error);
				return undefined;
			},
		);
	inFlight.set(key, task);
}

export function highlightCode(
	code: string,
	language: BundledLanguage,
	callback?: HighlightListener,
): TokenizedCode | null {
	const key = cacheKey(code, language);
	const cached = cachedValue(key);
	if (cached) return cached;
	if (callback) {
		const pending = listeners.get(key) ?? new Set<HighlightListener>();
		pending.add(callback);
		listeners.set(key, pending);
	}
	startHighlight(key, code, language);
	return null;
}

export function subscribeToCodeHighlight(code: string, language: BundledLanguage, callback: HighlightListener): () => void {
	const key = cacheKey(code, language);
	if (cachedValue(key)) return () => {};
	const pending = listeners.get(key) ?? new Set<HighlightListener>();
	pending.add(callback);
	listeners.set(key, pending);
	startHighlight(key, code, language);
	return () => {
		const current = listeners.get(key);
		if (!current) return;
		current.delete(callback);
		if (current.size === 0) listeners.delete(key);
	};
}

export function getCodeHighlightCacheStats(): {
	entries: number;
	bytes: number;
	inFlight: number;
	listeners: number;
	maxEntries: number;
	maxBytes: number;
} {
	return {
		entries: tokenCache.size,
		bytes: tokenCacheBytes,
		inFlight: inFlight.size,
		listeners: [...listeners.values()].reduce((total, current) => total + current.size, 0),
		maxEntries: MAX_CACHE_ENTRIES,
		maxBytes: MAX_CACHE_BYTES,
	};
}

export const projectCodeHighlighter: CodeHighlighterPlugin = {
	name: "shiki",
	type: "code-highlighter",
	getSupportedLanguages: () => [...supportedLanguages] as unknown as StreamdownBundledLanguage[],
	getThemes: () => [...DEFAULT_THEMES] as unknown as [StreamdownBundledTheme, StreamdownBundledTheme],
	supportsLanguage: (language) => supportedLanguages.has(language),
	highlight: ({ code, language }, callback) =>
		highlightCode(
			code,
			language as unknown as BundledLanguage,
			callback as unknown as ((result: TokenizedCode) => void) | undefined,
		),
};
