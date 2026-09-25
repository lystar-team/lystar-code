import { FileCode2 } from "lucide-react";
import type { BundledLanguage } from "shiki";
import { cn } from "../../lib/utils";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockCopyButton,
	CodeBlockDownloadButton,
	CodeBlockFilename,
	CodeBlockHeader,
	CodeBlockTitle,
} from "../ai-elements/code-block";

export function CodeBlockView({
	code,
	language,
	wrap = false,
	embedded = false,
	showActions = true,
}: {
	code: string;
	language: string;
	wrap?: boolean;
	embedded?: boolean;
	showActions?: boolean;
}) {
	return (
		<CodeBlock
			className={cn("my-0", embedded && "border-0 bg-transparent shadow-none")}
			code={code}
			language={language as BundledLanguage}
			transparent={embedded}
			wrap={wrap}
		>
			{showActions ? (
				<CodeBlockHeader
					className={cn(embedded ? "justify-end border-b-0 bg-transparent px-0 py-0 text-foreground" : undefined)}
				>
					{embedded ? null : (
						<CodeBlockTitle>
							<FileCode2 className="size-4" />
							<CodeBlockFilename>{language}</CodeBlockFilename>
						</CodeBlockTitle>
					)}
					<CodeBlockActions className={embedded ? "-my-1 -mr-1" : undefined}>
						<CodeBlockDownloadButton aria-label="下载代码" filename={`code.${language}`} />
						<CodeBlockCopyButton aria-label="复制代码" />
					</CodeBlockActions>
				</CodeBlockHeader>
			) : null}
		</CodeBlock>
	);
}
