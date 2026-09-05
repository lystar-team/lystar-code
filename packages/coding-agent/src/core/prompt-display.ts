const INTERNAL_PROMPT_BLOCK_PATTERNS = [
	/<skill\b[^>]*\blocation="[^"]+"[^>]*>[\s\S]*?<\/skill>/gu,
	/<skill_references\b[^>]*>[\s\S]*?<\/skill_references>/gu,
] as const;

/**
 * 把 Agent 为模型准备的内部 Prompt 内容投影为用户可见文本。
 *
 * Skill 引用会在输入处理阶段展开为 XML 块；这些块属于模型上下文，
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
