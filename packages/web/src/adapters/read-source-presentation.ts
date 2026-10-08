import type { ToolBatchTool } from "../types.ts";

export interface ReadSourcePresentation {
	code: string;
	startLine: number;
	endLine: number;
	remainingLines: number;
}

/** 读取结果只在展示边界拆解，标题、行号和复制内容共用同一口径。 */
export function readSourcePresentation(tool: Pick<ToolBatchTool, "state" | "summary" | "detail">): ReadSourcePresentation | undefined {
	if (tool.state !== "output-available" || tool.detail === undefined) return undefined;
	const output = tool.detail;
	const lines = output.split(/\r?\n/u);
	const header = lines[0]?.match(/^\[snapshot \S+; lines (\d+)-(\d+) of (\d+)\]$/u);
	if (header) {
		const startLine = Number(header[1]);
		const endLine = Number(header[2]);
		const totalLines = Number(header[3]);
		if (
			!Number.isSafeInteger(startLine) || startLine < 1 ||
			!Number.isSafeInteger(endLine) || endLine < startLine ||
			!Number.isSafeInteger(totalLines) || totalLines < endLine
		) return undefined;

		const lineCount = endLine - startLine + 1;
		if (lines.length < lineCount + 1) return undefined;
		const sourceLines: string[] = [];
		for (let index = 0; index < lineCount; index++) {
			const line = lines[index + 1];
			const prefix = `${startLine + index}| `;
			if (!line.startsWith(prefix)) return undefined;
			sourceLines.push(line.slice(prefix.length));
		}
		return { code: sourceLines.join("\n"), startLine, endLine, remainingLines: totalLines - endLine };
	}

	let startLine = 1;
	try {
		const parameters: unknown = JSON.parse(tool.summary);
		if (parameters && typeof parameters === "object" && "offset" in parameters &&
			typeof parameters.offset === "number" && Number.isSafeInteger(parameters.offset) && parameters.offset > 0)
			startLine = parameters.offset;
	} catch {
		// 已有记录的 summary 也可能直接是路径，此时读取起始行默认为 1。
	}

	// 无快照的读取记录把补读提示附在正文后，仅识别工具生成的结尾。
	const range = output.match(/\r?\n(?:\r?\n)?\[Showing lines (\d+)-(\d+) of (\d+)[^\]\r\n]*\]\s*$/u);
	const continuation = output.match(/\r?\n(?:\r?\n)?\[(\d+) more lines in file\. Use offset=\d+ to continue\.\]\s*$/u);
	const footer = range ?? continuation;
	const code = footer ? output.slice(0, footer.index) : output;
	if (!range && (tool.summary === "read" || !tool.summary)) return undefined;
	if (range) startLine = Number(range[1]);
	const endLine = range ? Number(range[2]) : startLine + code.split(/\r?\n/u).length - 1;
	const remainingLines = range ? Number(range[3]) - endLine : continuation ? Number(continuation[1]) : 0;
	return { code, startLine, endLine, remainingLines };
}
