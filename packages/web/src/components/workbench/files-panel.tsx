import { ArrowLeft, FileCode2, FileJson, FileText, ImageIcon, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectTreeEntry } from "../../types";
import type { WorkbenchState } from "../../state/use-workbench";
import { FileTree, FileTreeFile, FileTreeFolder } from "../ai-elements/file-tree";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { cn } from "../../lib/utils";
import type { WorkbenchActions } from "./types";

export function FilesPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const tree = state.fileTree;
	const entries = tree?.entries ?? [];
	const cachedTrees = state.fileTreeCache;

	const findEntry = (path: string, items: readonly ProjectTreeEntry[]): ProjectTreeEntry | undefined => {
		for (const entry of items) {
			if (entry.path === path) return entry;
			if (entry.kind === "directory") {
				const childTree = cachedTrees[entry.path];
				const childEntry = childTree ? findEntry(path, childTree.entries) : undefined;
				if (childEntry) return childEntry;
			}
		}
		return undefined;
	};

	const renderEntries = (items: readonly ProjectTreeEntry[]): ReactNode =>
		items.map((entry) =>
			entry.kind === "directory" ? (
				<FileTreeFolder
					key={entry.path}
					path={entry.path}
					name={entry.name}
					onToggle={(path, expanded) => {
						if (expanded && !cachedTrees[path]) void actions.loadProjectTree(path, true);
					}}
				>
					{cachedTrees[entry.path] ? renderEntries(cachedTrees[entry.path].entries) : null}
				</FileTreeFolder>
			) : (
				<FileTreeFile
					key={entry.path}
					path={entry.path}
					name={entry.name}
					icon={<FileTypeIcon path={entry.path} />}
				/>
			),
		);

	return (
		<div className="flex h-full min-h-0 flex-col gap-2 p-4">
			<div className="flex shrink-0 items-center justify-between gap-3">
				<div className="min-w-0">
					<h2 className="font-semibold">项目文件</h2>
					{tree?.path ? <p className="mt-1 truncate text-xs text-muted-foreground">{tree.path}</p> : null}
				</div>
				<Button
					size="icon"
					variant="ghost"
					onClick={() => void actions.loadProjectTree(tree?.path)}
					aria-label="刷新文件树"
				>
					<RefreshCw className={cn("size-4", state.fileTreeLoading && "animate-spin")} />
				</Button>
			</div>
			{tree?.parent !== undefined ? (
				<div className="flex shrink-0 gap-2">
					<Button size="sm" variant="outline" onClick={() => void actions.loadProjectTree(tree.parent)}>
						<ArrowLeft className="size-4" />
						上一级
					</Button>
				</div>
			) : null}
			{tree ? (
				<FileTree
					className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
					selectedPath={state.filePath}
					onSelect={(path) => {
						const entry = findEntry(path, entries);
						if (entry?.kind === "file") void actions.openFile(entry.path);
					}}
				>
					{renderEntries(entries)}
				</FileTree>
			) : (
				<Card className="min-h-0 flex-1">
					<CardContent className="flex h-full items-center justify-center py-8 text-center text-sm text-muted-foreground">
						{state.fileTreeLoading ? (
							<span className="flex items-center gap-2">
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
								正在加载文件树
							</span>
						) : (
							<span>文件树加载失败，请点击右上角刷新。</span>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
}

export function FileTypeIcon({ path }: { path: string }) {
	const fileName = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
	const extension = fileName.split(".").at(-1) ?? "";
	const Icon = ["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)
		? ImageIcon
		: extension === "md" || extension === "mdx"
			? FileText
			: extension === "json"
				? FileJson
				: ["css", "go", "java", "js", "jsx", "py", "rs", "sql", "ts", "tsx", "vue", "yaml", "yml"].includes(
							extension,
						)
					? FileCode2
					: FileText;
	return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}
