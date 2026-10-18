const CODE_FENCE = /^[ \t]*(?:```|~~~)[^\n]*$/gmu;
const INLINE_CODE = /(`+)([^`\n]*?)\1/gu;
const IMAGE = /!\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])/gu;
const LINK = /\[([^\]\n]*)\](?:\([^)\n]*\)|\[[^\]\n]*\])/gu;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gmu;
const BLOCKQUOTE = /^[ \t]{0,3}(?:>[ \t]?)+/gmu;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gmu;
const THEMATIC_BREAK = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gmu;
const TABLE_DIVIDER = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gmu;
const STRIKETHROUGH = /~~(?=\S)([^\n]*?\S)~~/gu;
const BOLD = /(\*\*|__)(?=\S)([^\n]*?\S)\1/gu;
const ITALIC_STAR = /(?<![\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*/gu;
const ITALIC_UNDERSCORE = /(?<![\p{L}\p{N}])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}])/gu;
const TABLE_PIPE = /[ \t]*\|[ \t]*/gu;
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:[ \t]{1,2}[^<>\n]*)?\/?>/giu;
const AUTOLINK = /<(https?:\/\/[^<>\n]+)>/gu;
const ESCAPED_MARKER = /\\([\\`*_{}[\]()#+.!|>~-])/gu;

/**
 * 把 Markdown 文本转成通知可直接显示的纯文本：表格、围栏、链接语法、强调符号都换成普通文字，
 * 图片统一显示为 `(图片)`，列表项保留为 `· `。输出按空白折叠，并按字符数截断。
 */
export function plainTextSummary(value: string | undefined, limit: number): string {
	const source = value ?? "";
	const stripped = source
		.replace(CODE_FENCE, "")
		.replace(INLINE_CODE, "$2")
		.replace(ESCAPED_MARKER, "$1")
		.replace(IMAGE, "(图片)")
		.replace(LINK, "$1")
		.replace(THEMATIC_BREAK, "")
		.replace(TABLE_DIVIDER, "")
		.replace(HEADING, "")
		.replace(BLOCKQUOTE, "")
		.replace(LIST_ITEM, "· ")
		.replace(STRIKETHROUGH, "$1")
		.replace(BOLD, "$2")
		.replace(ITALIC_STAR, "$1")
		.replace(ITALIC_UNDERSCORE, "$1")
		.replace(AUTOLINK, "$1")
		.replace(TABLE_PIPE, " ")
		.replace(HTML_TAG, "");
	return Array.from(stripped.replace(/\s+/gu, " ").trim()).slice(0, limit).join("");
}
