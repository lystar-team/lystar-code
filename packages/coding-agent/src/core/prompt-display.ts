const INTERNAL_FILE_BLOCK_PATTERN = /<file\b[^>]*>[\s\S]*?<\/file>/gu;
const FILE_NAME_ATTRIBUTE_PATTERN = /\bfilename="([^"]*)"/u;
const FILE_PATH_ATTRIBUTE_PATTERN = /\bname="([^"]*)"/u;
const INTERNAL_PROMPT_BLOCK_PATTERNS = [
	INTERNAL_FILE_BLOCK_PATTERN,
	/<skill\b[^>]*\blocation="[^"]+"[^>]*>[\s\S]*?<\/skill>/gu,
	/<skill_references\b[^>]*>[\s\S]*?<\/skill_references>/gu,
] as const;

/**
 * 把 Agent 为模型准备的内部 Prompt 内容投影为用户可见文本。
 *
 * Skill 和文件引用会在输入处理阶段展开为 XML 块；这些块属于模型上下文，
 * 不应出现在 WebUI、会话预览或搜索结果中。其它原始输入保持不变，
 * 因此用户输入的 `$[skill]` 仍然可以在界面中看到。
 */
export function stripInternalPromptContent(value: string): string {
	let projected = value;
	for (const pattern of INTERNAL_PROMPT_BLOCK_PATTERNS) projected = projected.replace(pattern, "");
	return projected
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function decodeFileAttribute(value: string): string {
	return value
		.replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'")
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">");
}

export function promptDisplayText(value: string): string {
	const visible = stripInternalPromptContent(value);
	if (visible) return visible;
	const filenames = new Set<string>();
	for (const match of value.matchAll(INTERNAL_FILE_BLOCK_PATTERN)) {
		const tag = match[0];
		const rawFilename = tag.match(FILE_NAME_ATTRIBUTE_PATTERN)?.[1] ?? tag.match(FILE_PATH_ATTRIBUTE_PATTERN)?.[1];
		const filename = decodeFileAttribute(rawFilename ?? "")
			.trim()
			.split(/[\\/]/u)
			.at(-1);
		if (filename) filenames.add(filename);
	}
	return filenames.size > 0 ? `附件：${[...filenames].join("、")}` : "";
}
