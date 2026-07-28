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
};

const windowsGlyphs: UiGlyphs = {
	prompt: ">",
	success: "+",
	failure: "x",
	tool: "*",
	expanded: "-",
	collapsed: "+",
	branch: ">",
	delta: "+/-",
	search: "?",
	list: "=",
	edit: "E",
};

export function getUiGlyphs(platform: NodeJS.Platform = process.platform): UiGlyphs {
	return platform === "win32" ? windowsGlyphs : richGlyphs;
}

export function toUiGlyph(glyph: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return glyph;
	const key = (Object.keys(richGlyphs) as Array<keyof UiGlyphs>).find((name) => richGlyphs[name] === glyph);
	return key ? windowsGlyphs[key] : glyph;
}

export const uiGlyphs = getUiGlyphs();
