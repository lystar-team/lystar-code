export interface UiGlyphs {
	prompt: string;
	success: string;
	failure: string;
	tool: string;
	expanded: string;
	collapsed: string;
	branch: string;
	delta: string;
	search: string;
	list: string;
	edit: string;
	file: string;
	image: string;
	running: string;
	open: string;
}

const richGlyphs: UiGlyphs = {
	prompt: "❯",
	success: "✓",
	failure: "✗",
	tool: "◆",
	expanded: "▾",
	collapsed: "▸",
	branch: "↳",
	delta: "±",
	search: "⌕",
	list: "≡",
	edit: "✎",
	file: "▤",
	image: "▣",
	running: "▶",
	open: "↗",
};

const windowsGlyphs: UiGlyphs = {
	prompt: ">",
	success: "+",
	failure: "x",
	tool: "*",
	expanded: "v",
	collapsed: ">",
	branch: ">",
	delta: "+/-",
	search: "?",
	list: "=",
	edit: "E",
	file: "F",
	image: "I",
	running: ">",
	open: ">",
};

export function getUiGlyphs(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): UiGlyphs {
	return platform === "win32" && env.LYSTAR_TERMINAL_HOST !== "1" ? windowsGlyphs : richGlyphs;
}

export function toUiGlyph(
	glyph: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform !== "win32" || env.LYSTAR_TERMINAL_HOST === "1") return glyph;
	const key = (Object.keys(richGlyphs) as Array<keyof UiGlyphs>).find((name) => richGlyphs[name] === glyph);
	return key ? windowsGlyphs[key] : glyph;
}

export const uiGlyphs = getUiGlyphs();
