import { type ComponentProps, type ReactNode, useMemo } from "react";
import type { BundledLanguage } from "shiki";
import { CodeBlock } from "./code-block";
import { JsonOutput, parseToolJson } from "./json-output";

type ToolOutputBlockProps = Omit<ComponentProps<typeof CodeBlock>, "language" | "plainText" | "body"> & {
	streaming?: boolean;
	fallback?: ReactNode;
};

export function ToolOutputBlock({ code, streaming = false, fallback, children, ...props }: ToolOutputBlockProps) {
	const root = useMemo(() => (streaming ? undefined : parseToolJson(code)), [code, streaming]);
	if (!root && fallback !== undefined) return fallback;
	return (
		<CodeBlock
			{...props}
			code={code}
			language={root ? "json" : ("text" as BundledLanguage)}
			plainText={!root}
			wrap
			body={root ? <JsonOutput root={root} /> : undefined}
		>
			{children}
		</CodeBlock>
	);
}
