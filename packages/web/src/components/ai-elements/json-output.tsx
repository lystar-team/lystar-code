import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { VirtualList } from "../ui/virtual-list";
import { CodeBlockActions, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from "./code-block";

export type JsonOutputNode = {
	id: number;
	label?: string;
	value: string;
	children?: JsonOutputNode[];
};

/** 根据原始 token 建树，保留大整数、重复字段和转义表示。 */
export function parseToolJson(code: string): JsonOutputNode | undefined {
	let source = code.trim();
	if (!/^(?:[\[{"\d-]|true$|false$|null$)/u.test(source)) return undefined;
	try {
		let value: unknown = JSON.parse(source);
		for (let layer = 0; layer < 2 && typeof value === "string"; layer++) {
			const nested = value.trim();
			if (!/^[\[{"]/u.test(nested)) break;
			try {
				value = JSON.parse(nested);
				source = nested;
			} catch {
				break;
			}
		}
	} catch {
		return undefined;
	}
	const tokens = [...source.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[^\s{}[\],:]+|[{}[\],:]/gu)];
	const parents: JsonOutputNode[] = [];
	let label: string | undefined;
	let root: JsonOutputNode | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]![0];
		if (token === "," || token === ":") continue;
		if (token === "}" || token === "]") {
			parents.pop();
			continue;
		}
		if (tokens[index + 1]?.[0] === ":") {
			label = token;
			continue;
		}
		const parent = parents.at(-1);
		const node: JsonOutputNode = {
			id: index,
			label: parent?.value === "[" ? String(parent.children!.length) : label,
			value: token,
			...(token === "{" || token === "[" ? { children: [] } : {}),
		};
		label = undefined;
		if (parent) parent.children!.push(node);
		else root = node;
		if (node.children) parents.push(node);
	}
	return root;
}

type JsonOutputRow = { node: JsonOutputNode; depth: number; closing?: boolean };

export function JsonOutput({ root }: { root: JsonOutputNode }) {
	const [view, setView] = useState({ root, all: false, expanded: new Map([[root.id, true]]) });
	if (view.root !== root) setView({ root, all: false, expanded: new Map([[root.id, true]]) });
	const rows = useMemo(() => {
		const visible: JsonOutputRow[] = [];
		const pending: JsonOutputRow[] = [{ node: root, depth: 0 }];
		while (pending.length) {
			const row = pending.pop()!;
			visible.push(row);
			if (row.closing || !row.node.children?.length || !(view.expanded.get(row.node.id) ?? view.all)) continue;
			pending.push({ ...row, closing: true });
			for (let index = row.node.children.length - 1; index >= 0; index--) {
				pending.push({ node: row.node.children[index]!, depth: row.depth + 1 });
			}
		}
		return visible;
	}, [root, view.all, view.expanded]);
	return (
		<div data-json-output className="min-w-0">
			<CodeBlockHeader className="gap-2 border-border/50 bg-transparent px-2 py-1 font-sans">
				<CodeBlockTitle className="shrink-0">JSON</CodeBlockTitle>
				<CodeBlockActions className="ml-auto gap-0">
					<Button
						className="h-7 px-1.5 font-normal"
						size="xs"
						variant="ghost"
						onClick={() => setView({ root, all: true, expanded: new Map() })}
					>
						全部展开
					</Button>
					<Button
						className="h-7 px-1.5 font-normal"
						size="xs"
						variant="ghost"
						onClick={() => setView({ root, all: false, expanded: new Map() })}
					>
						全部折叠
					</Button>
					<CodeBlockCopyButton aria-label="复制 JSON 原文" />
				</CodeBlockActions>
			</CodeBlockHeader>
			<div style={{ height: Math.min(320, rows.length * 24 + 8) }} className="min-w-0 py-1">
				<VirtualList
					items={rows}
					getKey={(row) => `${row.node.id}:${row.closing ? "end" : "value"}`}
					estimateSize={() => 24}
					renderItem={({ node, depth, closing }) => {
						const open = view.expanded.get(node.id) ?? view.all;
						const expandable = Boolean(node.children?.length);
						const close = node.value === "[" ? "]" : "}";
						const value = closing
							? close
							: node.children
								? `${node.value}${open && expandable ? "" : close}`
								: node.value;
						const text = (
							<span className="min-w-0 whitespace-pre-wrap break-all">
								{!closing && node.label !== undefined ? (
									<span className="text-muted-foreground">{node.label}: </span>
								) : null}
								<span>{value}</span>
								{!closing && node.children ? (
									<span className="ml-2 inline-block whitespace-nowrap font-sans text-xs text-muted-foreground">
										{node.children.length} 项
									</span>
								) : null}
							</span>
						);
						const style = { paddingLeft: 8 + depth * 16 };
						return expandable && !closing ? (
							<button
								type="button"
								data-json-toggle
								aria-expanded={open}
								aria-label={`${node.label ?? "JSON"}，${open ? "折叠" : "展开"}`}
								className="grid min-h-6 w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-1 rounded-sm pr-2 text-left font-mono! text-[13px]! leading-6! hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								style={style}
								onClick={() =>
									setView((current) => ({
										...current,
										expanded: new Map(current.expanded).set(node.id, !open),
									}))
								}
							>
								<ChevronRight aria-hidden className={`mt-1 size-4 shrink-0 ${open ? "rotate-90" : ""}`} />
								{text}
							</button>
						) : (
							<div className="grid min-h-6 grid-cols-[16px_minmax(0,1fr)] items-start gap-1 pr-2 font-mono text-[13px] leading-6" style={style}>
								<span aria-hidden className="size-4" />
								{text}
							</div>
						);
					}}
				/>
			</div>
		</div>
	);
}
