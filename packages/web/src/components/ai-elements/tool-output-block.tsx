import { type ComponentProps, type ReactNode, useMemo } from "react";
import type { BundledLanguage } from "shiki";
import { MAX_HIGHLIGHT_CODE_CHARS, MAX_HIGHLIGHT_CODE_LINES, shouldHighlightCode } from "@/lib/code-highlighter";
import { CodeBlock } from "./code-block";

type ToolOutputBlockProps = Omit<ComponentProps<typeof CodeBlock>, "language" | "plainText"> & {
	streaming?: boolean;
	fallback?: ReactNode;
};

export function ToolOutputBlock({ code, streaming = false, fallback, ...props }: ToolOutputBlockProps) {
	const formatted = useMemo(() => {
		if (streaming || !shouldHighlightCode(code)) return undefined;
		let source = code.trim();
		if (!/^(?:[\[{"\d-]|true$|false$|null$)/u.test(source)) return undefined;
		try {
			let value: unknown = JSON.parse(source);
			// 只解开整个结果的 JSON 字符串包装，字段里的转义保持原义。
			for (let layer = 0; layer < 2 && typeof value === "string"; layer++) {
				const nested = value.trim();
				if (!/^[\[{"]/u.test(nested)) break;
				if (!shouldHighlightCode(nested)) return undefined;
				try {
					value = JSON.parse(nested);
				} catch {
					break;
				}
				if (value !== null && typeof value === "object") {
					source = nested;
					break;
				}
			}
		} catch {
			return undefined;
		}

		// 只调整空白，保留大整数、重复字段和字符串的原始表示。
		const tokens = source.match(/"(?:[^"\\]|\\[\s\S])*"|[^\s{}[\],:]+|[{}[\],:]/gu) ?? [];
		const parts: string[] = [];
		let depth = 0;
		let length = 0;
		let lines = 1;
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			let part = token;
			if (token === "{" || token === "[") {
				depth += 1;
				if (tokens[index + 1] !== (token === "{" ? "}" : "]")) {
					part += `\n${"  ".repeat(depth)}`;
					lines += 1;
				}
			} else if (token === "}" || token === "]") {
				depth -= 1;
				if (tokens[index - 1] !== (token === "}" ? "{" : "[")) {
					part = `\n${"  ".repeat(depth)}${token}`;
					lines += 1;
				}
			} else if (token === ",") {
				part += `\n${"  ".repeat(depth)}`;
				lines += 1;
			} else if (token === ":") part += " ";
			length += part.length;
			// 缩进也计入上限，避免紧凑且深层嵌套的 JSON 膨胀。
			if (length > MAX_HIGHLIGHT_CODE_CHARS || lines > MAX_HIGHLIGHT_CODE_LINES) return undefined;
			parts.push(part);
		}
		return parts.join("");
	}, [code, streaming]);

	if (formatted === undefined && fallback !== undefined) return fallback;
	return <CodeBlock {...props} code={formatted ?? code} language={formatted === undefined ? ("text" as BundledLanguage) : "json"} plainText={formatted === undefined} wrap />;
}
