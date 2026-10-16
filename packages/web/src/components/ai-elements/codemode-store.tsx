import { codemodeStoreChanges } from "../../adapters/codemode-store-presentation.ts";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "./code-block";

export function CodemodeStoreDetail({ detail }: { detail?: string }) {
	const changes = codemodeStoreChanges(detail);
	const savedCount = changes ? Object.keys(changes.set).length : 0;
	return (
		<div className="grid min-w-0 gap-3 py-1" onClick={(event) => event.stopPropagation()}>
			<p className="text-xs leading-5 text-muted-foreground">
				这是脚本保存的数据，不是项目文件修改。后续脚本可通过 load() 读取，恢复当前会话后仍可使用。
			</p>
			{changes ? (
				<>
					{savedCount ? (
						<CodeBlock className="my-0 border-border/60 bg-muted/25" code={JSON.stringify(changes.set, null, 2)} language="json" plainText wrap>
							<CodeBlockHeader className="border-b-0 bg-transparent px-2 py-1">
								<CodeBlockTitle className="text-foreground">保存项（{savedCount}）</CodeBlockTitle>
								<CodeBlockActions><CodeBlockCopyButton aria-label="复制保存的数据" /></CodeBlockActions>
							</CodeBlockHeader>
						</CodeBlock>
					) : null}
					{changes.delete.length ? (
						<div className="grid min-w-0 gap-1">
							<span className="text-xs text-muted-foreground">删除项（{changes.delete.length}）</span>
							<ul className="grid min-w-0 gap-1 text-xs text-foreground">
								{changes.delete.map((key, index) => <li className="whitespace-pre-wrap break-all font-mono" key={`${index}:${key}`}>{key}</li>)}
							</ul>
						</div>
					) : null}
					{!savedCount && !changes.delete.length ? <p className="text-xs text-muted-foreground">本次记录没有保存或删除数据。</p> : null}
				</>
			) : (
				<div className="grid min-w-0 gap-1">
					<p className="text-xs text-muted-foreground">{detail ? "数据记录不完整，以下为已收到的内容。" : "本次记录未提供数据内容。"}</p>
					{detail ? <CodeBlock className="my-0 border-border/60 bg-muted/25" code={detail} language="json" plainText wrap /> : null}
				</div>
			)}
		</div>
	);
}
