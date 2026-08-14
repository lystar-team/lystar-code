import hljs from "highlight.js";
import { marked, Renderer, type Tokens } from "marked";
import { useEffect, useMemo, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"'": "&#39;",
			'"': "&quot;",
		};
		return entities[character];
	});
}

function safeUrl(value: string): string | undefined {
	if (!/^(?:https?:|mailto:)/i.test(value.trim())) return undefined;
	try {
		const url = new URL(value);
		return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function resourceTarget(value: string): string | undefined {
	const target = value.trim();
	if (!target || /^(?:javascript|data|vbscript):/i.test(target)) return undefined;
	return target;
}

const renderer = new Renderer();
renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
renderer.code = ({ text, lang }: Tokens.Code) => {
	const language = lang?.split(/\s+/)[0];
	const highlighted = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : hljs.highlightAuto(text).value;
	return `<pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${highlighted}</code></pre>`;
};
renderer.link = function ({ href, title, tokens }: Tokens.Link) {
	const url = safeUrl(href);
	const target = resourceTarget(href);
	const text = this.parser.parseInline(tokens);
	if (!url && !target) return text;
	const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
	return url
		? `<a href="${escapeHtml(url)}" rel="noreferrer noopener"${safeTitle}>${text}</a>`
		: `<a href="#" data-resource-target="${escapeHtml(target!)}"${safeTitle}>${text}</a>`;
};
renderer.image = ({ href, text }: Tokens.Image) => {
	const url = safeUrl(href);
	const target = resourceTarget(href);
	if (url) return `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${escapeHtml(text || "图片")}</a>`;
	return target
		? `<a href="#" data-resource-target="${escapeHtml(target)}" data-resource-image="true">${escapeHtml(text || "查看图片")}</a>`
		: escapeHtml(text);
};

marked.use({ renderer, gfm: true, breaks: false });

export function renderMarkdown(text: string): string {
	return marked.parse(text, { async: false }) as string;
}

function languageFromPath(path: string | undefined): string | undefined {
	const name = path?.split(/[\\/]/).at(-1)?.toLowerCase();
	if (!name) return undefined;
	if (name === "dockerfile") return "dockerfile";
	if (name === "makefile") return "makefile";
	const extension = name.split(".").at(-1);
	return {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		css: "css",
		scss: "scss",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
	}[extension ?? ""];
}

export function HighlightedCode({ code, path }: { code: string; path?: string }) {
	const html = useMemo(() => {
		const language = languageFromPath(path);
		return language && hljs.getLanguage(language)
			? hljs.highlight(code, { language }).value
			: escapeHtml(code);
	}, [code, path]);
	return <pre className="tool-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

export function Markdown({ text, onOpenResource }: { text: string; onOpenResource?: (target: string) => void }) {
	const root = useRef<HTMLDivElement>(null);
	const html = useMemo(() => renderMarkdown(text), [text]);

	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const onClick = (event: MouseEvent) => {
			const link = (event.target as Element).closest("a");
			if (!(link instanceof HTMLAnchorElement)) return;
			event.preventDefault();
			const target = link.dataset.resourceTarget;
			if (target) {
				onOpenResource?.(target);
				return;
			}
			if (isTauri()) void openUrl(link.href);
			else window.open(link.href, "_blank", "noopener,noreferrer");
		};
		element.addEventListener("click", onClick);
		return () => element.removeEventListener("click", onClick);
	}, [onOpenResource]);

	return <div ref={root} className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
