import { ArrowLeft, FileCode2, FileJson, FileText, FolderOpen, HardDrive, ImageIcon, RefreshCw } from "lucide-react";
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
		<div className="grid gap-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold">项目文件</h2>
					<p className="mt-1 truncate text-xs text-muted-foreground">{tree?.path || "项目根目录"}</p>
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
			<div className="flex gap-2">
				<Button size="sm" variant="outline" onClick={() => void actions.loadProjectTree("")}>
					<HardDrive className="size-4" />
					根目录
				</Button>
				{tree?.parent !== undefined ? (
					<Button size="sm" variant="outline" onClick={() => void actions.loadProjectTree(tree.parent)}>
						<ArrowLeft className="size-4" />
						上一级
					</Button>
				) : null}
			</div>
			{tree ? (
				<FileTree
					selectedPath={state.filePath}
					onSelect={(path) => {
						const entry = findEntry(path, entries);
						if (entry?.kind === "file") void actions.openFile(entry.path);
					}}
				>
					{renderEntries(entries)}
				</FileTree>
			) : (
				<Card>
					<CardContent className="py-8 text-center">
						<Button variant="outline" onClick={() => void actions.loadProjectTree()}>
							<FolderOpen className="size-4" />
							加载文件树
						</Button>
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
