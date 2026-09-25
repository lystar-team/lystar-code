import {
	ArrowLeft,
	Copy,
	Download,
	FileArchive,
	FolderOpen,
	LoaderCircle,
	Pencil,
	RefreshCw,
	Search,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent as ReactDragEvent,
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";
import { webApi } from "../../adapters/host-protocol/api";
import { cn } from "../../lib/utils";
import type { WorkbenchState } from "../../state/use-workbench";
import type { ProjectTreeEntry } from "../../types";
import { FileTree, FileTreeFile, FileTreeFolder } from "../ai-elements/file-tree";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "../ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { FileTypeIcon } from "./file-type-icon";
import { preloadMonacoRuntime } from "./monaco-runtime";
import type { WorkbenchActions } from "./types";


interface ProjectEntryReference {
	kind: "file" | "directory";
	name: string;
	path: string;
}

interface SearchFileResult extends ProjectEntryReference {
	kind: "file";
}

type SelectEvent = ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>;

function fileName(path: string): string {
	return path.split(/[\\/]/u).at(-1) || "文件";
}

function parentProjectPath(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator < 0 ? "" : path.slice(0, separator);
}

function completionFilePath(value: string): string {
	const candidate = value.trim();
	if (candidate.startsWith('@"') && candidate.endsWith('"')) return candidate.slice(2, -1);
	return candidate.startsWith("@") ? candidate.slice(1) : candidate;
}

function absoluteProjectPath(projectPath: string, path: string): string {
	const separator = projectPath.includes("\\") ? "\\" : "/";
	const root = projectPath.replace(/[\\/]+$/u, "");
	return `${root}${separator}${path.replaceAll(/[\\/]/gu, separator)}`;
}

function validFileName(name: string): boolean {
	return Boolean(name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\"));
}

function archiveFileName(value: string): string {
	const name = value.trim();
	return name.toLowerCase().endsWith(".zip") ? name : `${name}.zip`;
}

function defaultArchiveName(paths: readonly string[]): string {
	if (paths.length !== 1) return "archive.zip";
	const name = fileName(paths[0]).replace(/\.zip$/iu, "");
	return `${name}.zip`;
}

function isFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
	return Array.from(event.dataTransfer.types).includes("Files");
}

function ProjectFileRow({
	entry,
	detail,
	selectionCount,
	onArchive,
	onContextOpen,
	onCopyPath,
	onDelete,
	onDownload,
	onOpen,
	onRename,
}: {
	entry: Pick<ProjectTreeEntry, "name" | "path">;
	detail?: string;
	selectionCount: number;
	onArchive: () => void;
	onContextOpen: () => void;
	onCopyPath: () => void;
	onDelete: () => void;
	onDownload: () => void;
	onOpen: () => void;
	onRename: () => void;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div onContextMenu={onContextOpen}>
					<FileTreeFile path={entry.path} name={entry.name}>
						<span className="size-4 shrink-0" aria-hidden="true" />
						<FileTypeIcon path={entry.path} />
						<span className="min-w-0 flex-1">
							<span className="block truncate">{entry.name}</span>
							{detail ? <span className="block truncate text-[11px] text-muted-foreground">{detail}</span> : null}
						</span>
					</FileTreeFile>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-48">
				{selectionCount === 1 ? (
					<>
						<ContextMenuItem onSelect={onOpen}>
							<FolderOpen className="size-4" />
							打开
						</ContextMenuItem>
						<ContextMenuItem onSelect={onRename}>
							<Pencil className="size-4" />
							重命名
						</ContextMenuItem>
						<ContextMenuItem onSelect={onDownload}>
							<Download className="size-4" />
							下载
						</ContextMenuItem>
						<ContextMenuItem onSelect={onCopyPath}>
							<Copy className="size-4" />
							拷贝路径
						</ContextMenuItem>
						<ContextMenuSeparator />
					</>
				) : null}
				<ContextMenuItem onSelect={onArchive}>
					<FileArchive className="size-4" />
					{selectionCount > 1 ? `压缩 ${selectionCount} 项为 ZIP` : "压缩为 ZIP"}
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
					<Trash2 className="size-4" />
					{selectionCount > 1 ? `删除 ${selectionCount} 项` : "删除"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function ProjectFolderRow({
	entry,
	selectionCount,
	dropActive,
	onArchive,
	onContextOpen,
	onCopyPath,
	onDelete,
	onDropFiles,
	onDropState,
	onRename,
	onToggle,
	children,
}: {
	entry: Pick<ProjectTreeEntry, "name" | "path">;
	selectionCount: number;
	dropActive: boolean;
	onArchive: () => void;
	onContextOpen: () => void;
	onCopyPath: () => void;
	onDelete: () => void;
	onDropFiles: (files: readonly File[]) => void;
	onDropState: (active: boolean) => void;
	onRename: () => void;
	onToggle: (path: string, expanded: boolean) => void;
	children: ReactNode;
}) {
	const activateDrop = (event: ReactDragEvent<HTMLDivElement>) => {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "copy";
		onDropState(true);
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					className={cn(dropActive && "rounded bg-primary/10 ring-1 ring-inset ring-primary/40")}
					onContextMenu={onContextOpen}
					onDragEnter={activateDrop}
					onDragOver={activateDrop}
					onDragLeave={(event) => {
						if (!isFileDrag(event)) return;
						event.stopPropagation();
						if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
						onDropState(false);
					}}
					onDrop={(event) => {
						if (!isFileDrag(event)) return;
						event.preventDefault();
						event.stopPropagation();
						onDropState(false);
						const files = Array.from(event.dataTransfer.files);
						if (files.length) onDropFiles(files);
					}}
				>
					<FileTreeFolder path={entry.path} name={entry.name} onToggle={onToggle}>
						{children}
					</FileTreeFolder>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-48">
				{selectionCount === 1 ? (
					<>
						<ContextMenuItem onSelect={onRename}>
							<Pencil className="size-4" />
							重命名
						</ContextMenuItem>
						<ContextMenuItem onSelect={onCopyPath}>
							<Copy className="size-4" />
							拷贝路径
						</ContextMenuItem>
						<ContextMenuSeparator />
					</>
				) : null}
				<ContextMenuItem onSelect={onArchive}>
					<FileArchive className="size-4" />
					{selectionCount > 1 ? `压缩 ${selectionCount} 项为 ZIP` : "压缩为 ZIP"}
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
					<Trash2 className="size-4" />
					{selectionCount > 1 ? `删除 ${selectionCount} 项` : "删除"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

export function FilesPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const tree = state.fileTree;
	const entries = tree?.entries ?? [];
	const cachedTrees = state.fileTreeCache;
	const currentProject = useMemo(
		() => state.projects.find((project) => project.id === state.currentProjectId),
		[state.currentProjectId, state.projects],
	);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchFileResult[]>([]);
	const [searchLoading, setSearchLoading] = useState(false);
	const [searchError, setSearchError] = useState<string>();
	const [searchRevision, setSearchRevision] = useState(0);
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
	const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
	const [selectionAnchor, setSelectionAnchor] = useState<string>();
	const [renameTarget, setRenameTarget] = useState<ProjectEntryReference>();
	const [renameDraft, setRenameDraft] = useState("");
	const [renameBusy, setRenameBusy] = useState(false);
	const [archivePaths, setArchivePaths] = useState<string[]>([]);
	const [archiveDraft, setArchiveDraft] = useState("");
	const [archiveBusy, setArchiveBusy] = useState(false);
	const [deleteTargets, setDeleteTargets] = useState<ProjectEntryReference[]>([]);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [uploadBusy, setUploadBusy] = useState(false);
	const [dropTargetPath, setDropTargetPath] = useState<string>();
	const uploadInputRef = useRef<HTMLInputElement>(null);
	const normalizedSearch = searchQuery.trim();

	useEffect(() => {
		if (!state.currentProjectId) return;
		preloadMonacoRuntime();
	}, [state.currentProjectId]);

	useEffect(() => {
		setExpandedPaths(new Set());
		setSelectedPaths(new Set());
		setSelectionAnchor(undefined);
		setSearchQuery("");
	}, [state.currentProjectId]);

	useEffect(() => {
		const projectId = state.currentProjectId;
		if (!projectId || !normalizedSearch) {
			setSearchResults([]);
			setSearchLoading(false);
			setSearchError(undefined);
			return;
		}
		let cancelled = false;
		const timer = window.setTimeout(() => {
			setSearchLoading(true);
			setSearchResults([]);
			setSearchError(undefined);
			const text = `@"${normalizedSearch.replaceAll('"', "")}`;
			void webApi
				.completions(projectId, text, text.length)
				.then((result) => {
					if (cancelled) return;
					const seen = new Set<string>();
					setSearchResults(
						result.items.flatMap((item) => {
							if (item.kind !== "file") return [];
							const path = completionFilePath(item.value);
							if (!path || seen.has(path)) return [];
							seen.add(path);
							return [{ kind: "file" as const, name: item.label, path }];
						}),
					);
				})
				.catch((error) => {
					if (!cancelled) setSearchError(error instanceof Error ? error.message : String(error));
				})
				.finally(() => {
					if (!cancelled) setSearchLoading(false);
				});
		}, 160);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [normalizedSearch, searchRevision, state.currentProjectId]);

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

	const visiblePaths = useMemo(() => {
		if (normalizedSearch) return searchResults.map((entry) => entry.path);
		const result: string[] = [];
		const append = (items: readonly ProjectTreeEntry[]) => {
			for (const entry of items) {
				result.push(entry.path);
				if (entry.kind === "directory" && expandedPaths.has(entry.path)) {
					const childTree = cachedTrees[entry.path];
					if (childTree) append(childTree.entries);
				}
			}
		};
		append(entries);
		return result;
	}, [cachedTrees, entries, expandedPaths, normalizedSearch, searchResults]);

	const entryForPath = (path: string): ProjectTreeEntry | SearchFileResult | undefined =>
		searchResults.find((entry) => entry.path === path) ?? findEntry(path, entries);

	const selectedUploadEntry =
		selectedPaths.size === 1 ? entryForPath(selectedPaths.values().next().value ?? "") : undefined;
	const buttonUploadPath = selectedUploadEntry?.kind === "directory" ? selectedUploadEntry.path : "";

	const handleError = (error: unknown) => actions.showToast(error instanceof Error ? error.message : String(error));

	const openFile = (path: string) => {
		void actions.openFile(path).catch(handleError);
	};

	const copyPath = (path: string) => {
		void (async () => {
			if (!currentProject) throw new Error("当前项目不可用");
			if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持复制路径");
			await navigator.clipboard.writeText(absoluteProjectPath(currentProject.path, path));
			actions.showToast("路径已复制");
		})().catch(handleError);
	};

	const downloadFile = (path: string) => {
		void (async () => {
			if (!state.currentProjectId) throw new Error("当前项目不可用");
			const blob = await webApi.downloadProjectFile(state.currentProjectId, path);
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = fileName(path);
			document.body.append(link);
			link.click();
			link.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
			actions.showToast("已开始下载");
		})().catch(handleError);
	};

	const uploadFiles = async (files: readonly File[], targetPath: string) => {
		if (!state.currentProjectId || uploadBusy || files.length === 0) return;
		setUploadBusy(true);
		setDropTargetPath(undefined);
		let uploadedCount = 0;
		try {
			for (const file of files) {
				await webApi.uploadProjectFile(state.currentProjectId, targetPath, file);
				uploadedCount += 1;
			}
			await actions.loadProjectTree(targetPath, tree?.path !== targetPath);
			setSearchRevision((current) => current + 1);
			const targetLabel = targetPath ? `目录“${fileName(targetPath)}”` : "项目根目录";
			actions.showToast(`已上传 ${uploadedCount} 个文件到${targetLabel}`);
		} catch (error) {
			if (uploadedCount > 0) {
				await actions.loadProjectTree(targetPath, tree?.path !== targetPath).catch(() => {});
				setSearchRevision((current) => current + 1);
			}
			const message = error instanceof Error ? error.message : String(error);
			actions.showToast(uploadedCount > 0 ? `已上传 ${uploadedCount} 个文件；${message}` : message);
		} finally {
			setUploadBusy(false);
		}
	};

	const handleTreeSelect = (path: string, event: SelectEvent): boolean => {
		const entry = entryForPath(path);
		if (!entry) return false;
		const toggleSelection = event.ctrlKey || event.metaKey;
		const rangeSelection = event.shiftKey;
		setSelectedPaths((current) => {
			if (rangeSelection && selectionAnchor) {
				const anchorIndex = visiblePaths.indexOf(selectionAnchor);
				const targetIndex = visiblePaths.indexOf(path);
				if (anchorIndex >= 0 && targetIndex >= 0) {
					const start = Math.min(anchorIndex, targetIndex);
					const end = Math.max(anchorIndex, targetIndex);
					const range = visiblePaths.slice(start, end + 1);
					return toggleSelection ? new Set([...current, ...range]) : new Set(range);
				}
			}
			if (toggleSelection) {
				const next = new Set(current);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				return next;
			}
			return new Set([path]);
		});
		if (!rangeSelection || !selectionAnchor) setSelectionAnchor(path);
		if (entry.kind === "directory") return !toggleSelection && !rangeSelection;
		if (!toggleSelection && !rangeSelection) openFile(path);
		return false;
	};

	const prepareContextSelection = (path: string) => {
		if (!selectedPaths.has(path)) setSelectedPaths(new Set([path]));
		setSelectionAnchor(path);
	};

	const selectionCountFor = (path: string): number => (selectedPaths.has(path) ? selectedPaths.size : 1);

	const selectedPathsFor = (path: string): string[] => (selectedPaths.has(path) ? [...selectedPaths] : [path]);

	const beginRename = (entry: ProjectEntryReference) => {
		setRenameTarget(entry);
		setRenameDraft(entry.name);
	};

	const closeRename = () => {
		if (renameBusy) return;
		setRenameTarget(undefined);
		setRenameDraft("");
	};

	const submitRename = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!renameTarget || !state.currentProjectId) return;
		const name = renameDraft.trim();
		if (!validFileName(name)) {
			actions.showToast("请输入不含路径分隔符的文件名");
			return;
		}
		if (name === renameTarget.name) {
			closeRename();
			return;
		}
		setRenameBusy(true);
		try {
			const result = await webApi.renameProjectEntry(state.currentProjectId, renameTarget.path, name);
			const parent = parentProjectPath(renameTarget.path);
			await actions.loadProjectTree(parent, tree?.path !== parent);
			const activeFilePath = state.filePath;
			if (
				activeFilePath &&
				(activeFilePath === renameTarget.path ||
					(renameTarget.kind === "directory" && activeFilePath.startsWith(`${renameTarget.path}/`)))
			) {
				await actions.openFile(`${result.path}${activeFilePath.slice(renameTarget.path.length)}`);
			}
			setSelectedPaths((current) => {
				const next = new Set<string>();
				for (const path of current) {
					next.add(
						path === renameTarget.path || path.startsWith(`${renameTarget.path}/`)
							? `${result.path}${path.slice(renameTarget.path.length)}`
							: path,
					);
				}
				return next;
			});
			setExpandedPaths(
				(current) =>
					new Set(
						[...current].filter(
							(path) => path !== renameTarget.path && !path.startsWith(`${renameTarget.path}/`),
						),
					),
			);
			setSearchRevision((current) => current + 1);
			setRenameTarget(undefined);
			setRenameDraft("");
			actions.showToast(`${renameTarget.kind === "directory" ? "目录" : "文件"}已重命名`);
		} catch (error) {
			handleError(error);
		} finally {
			setRenameBusy(false);
		}
	};

	const beginArchive = (path: string) => {
		const paths = selectedPathsFor(path);
		setArchivePaths(paths);
		setArchiveDraft(defaultArchiveName(paths));
	};

	const closeArchive = () => {
		if (archiveBusy) return;
		setArchivePaths([]);
		setArchiveDraft("");
	};

	const submitArchive = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!state.currentProjectId || archivePaths.length === 0) return;
		if (!validFileName(archiveDraft.trim())) {
			actions.showToast("请输入不含路径分隔符的 ZIP 文件名");
			return;
		}
		const name = archiveFileName(archiveDraft);
		setArchiveBusy(true);
		try {
			const result = await webApi.createProjectArchive(state.currentProjectId, archivePaths, name);
			await actions.loadProjectTree("", tree?.path !== "");
			setSearchRevision((current) => current + 1);
			setSelectedPaths(new Set());
			setSelectionAnchor(undefined);
			setArchivePaths([]);
			setArchiveDraft("");
			actions.showToast(`已生成 ${result.path}`);
		} catch (error) {
			handleError(error);
		} finally {
			setArchiveBusy(false);
		}
	};

	const beginDelete = (entry: ProjectEntryReference) => {
		const targets = selectedPathsFor(entry.path).flatMap((path) => {
			const candidate = entryForPath(path);
			return candidate ? [{ kind: candidate.kind, name: candidate.name, path: candidate.path }] : [];
		});
		setDeleteTargets(targets.length ? targets : [entry]);
	};

	const closeDelete = () => {
		if (deleteBusy) return;
		setDeleteTargets([]);
	};

	const submitDelete = async () => {
		if (!state.currentProjectId || deleteTargets.length === 0) return;
		setDeleteBusy(true);
		try {
			const result = await webApi.deleteProjectEntries(
				state.currentProjectId,
				deleteTargets.map((entry) => entry.path),
			);
			const activeFilePath = state.filePath;
			if (
				activeFilePath &&
				deleteTargets.some(
					(entry) =>
						activeFilePath === entry.path ||
						(entry.kind === "directory" && activeFilePath.startsWith(`${entry.path}/`)),
				)
			) {
				actions.closeFilePreview();
			}
			const deletedDirectories = deleteTargets.filter((entry) => entry.kind === "directory");
			const refreshParents = [
				...new Set(
					deleteTargets
						.map((entry) => parentProjectPath(entry.path))
						.filter(
							(parent) =>
								!deletedDirectories.some(
									(directory) => parent === directory.path || parent.startsWith(`${directory.path}/`),
								),
						),
				),
			];
			for (const parent of refreshParents) await actions.loadProjectTree(parent, tree?.path !== parent);
			setExpandedPaths(
				(current) =>
					new Set(
						[...current].filter(
							(path) =>
								!deletedDirectories.some(
									(directory) => path === directory.path || path.startsWith(`${directory.path}/`),
								),
						),
					),
			);
			setSearchRevision((current) => current + 1);
			setSelectedPaths(new Set());
			setSelectionAnchor(undefined);
			setDeleteTargets([]);
			actions.showToast(result.paths.length > 1 ? `已删除 ${result.paths.length} 项` : "已删除");
		} catch (error) {
			handleError(error);
		} finally {
			setDeleteBusy(false);
		}
	};

	const fileRow = (entry: SearchFileResult, detail?: string) => (
		<ProjectFileRow
			key={entry.path}
			entry={entry}
			detail={detail}
			selectionCount={selectionCountFor(entry.path)}
			onContextOpen={() => prepareContextSelection(entry.path)}
			onOpen={() => openFile(entry.path)}
			onRename={() => beginRename(entry)}
			onDelete={() => beginDelete(entry)}
			onDownload={() => downloadFile(entry.path)}
			onCopyPath={() => copyPath(entry.path)}
			onArchive={() => beginArchive(entry.path)}
		/>
	);

	const renderEntries = (items: readonly ProjectTreeEntry[]): ReactNode =>
		items.map((entry) =>
			entry.kind === "directory" ? (
				<ProjectFolderRow
					key={entry.path}
					entry={entry}
					selectionCount={selectionCountFor(entry.path)}
					dropActive={dropTargetPath === entry.path}
					onContextOpen={() => prepareContextSelection(entry.path)}
					onRename={() => beginRename(entry)}
					onCopyPath={() => copyPath(entry.path)}
					onDelete={() => beginDelete(entry)}
					onDropFiles={(files) => void uploadFiles(files, entry.path)}
					onDropState={(active) => setDropTargetPath(active ? entry.path : undefined)}
					onArchive={() => beginArchive(entry.path)}
					onToggle={(path, expanded) => {
						if (expanded && !cachedTrees[path]) void actions.loadProjectTree(path, true);
					}}
				>
					{cachedTrees[entry.path] ? renderEntries(cachedTrees[entry.path].entries) : null}
				</ProjectFolderRow>
			) : (
				fileRow({ kind: "file", name: entry.name, path: entry.path })
			),
		);

	const treeProps = {
		expanded: expandedPaths,
		onExpandedChange: setExpandedPaths,
		onSelect: handleTreeSelect,
		selectedPaths,
	};

	const fileContent = normalizedSearch ? (
		searchLoading ? (
			<div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
				<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
				正在搜索文件
			</div>
		) : searchError ? (
			<div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
				搜索失败：{searchError}
			</div>
		) : searchResults.length ? (
			<ScrollArea className="h-full w-full">
				<FileTree className="min-w-0 rounded-none border-0 bg-transparent" {...treeProps}>
					{searchResults.map((entry) => fileRow(entry, entry.path))}
				</FileTree>
			</ScrollArea>
		) : (
			<div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
				没有找到匹配文件
			</div>
		)
	) : tree ? (
		<ScrollArea className="h-full w-full">
			<FileTree className="min-w-0 rounded-none border-0 bg-transparent" {...treeProps}>
				{renderEntries(entries)}
			</FileTree>
		</ScrollArea>
	) : null;

	return (
		<>
			<div className="flex h-full min-h-0 flex-col gap-2 p-4">
				<div className="flex shrink-0 items-center justify-between gap-3">
					<div className="min-w-0">
						<h2 className="font-semibold">项目文件</h2>
						{tree?.path ? <p className="mt-1 truncate text-xs text-muted-foreground">{tree.path}</p> : null}
					</div>
					<div className="flex items-center gap-1">
						<input
							ref={uploadInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={(event) => {
								const files = Array.from(event.target.files ?? []);
								event.target.value = "";
								void uploadFiles(files, buttonUploadPath);
							}}
						/>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={uploadBusy || !state.currentProjectId}
							aria-label={buttonUploadPath ? `上传文件到${fileName(buttonUploadPath)}` : "上传文件到项目根目录"}
							onClick={() => uploadInputRef.current?.click()}
						>
							{uploadBusy ? (
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
							) : (
								<Upload className="size-4" aria-hidden="true" />
							)}
							上传
						</Button>
						<Button
							size="icon"
							variant="ghost"
							onClick={() => void actions.loadProjectTree(tree?.path)}
							aria-label="刷新文件树"
						>
							<RefreshCw className={cn("size-4", state.fileTreeLoading && "animate-spin")} />
						</Button>
					</div>
				</div>
				<div className="relative shrink-0">
					<Search
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						type="search"
						aria-label="搜索项目文件"
						className="pr-9 pl-9"
						placeholder="搜索文件"
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
					/>
					{searchQuery ? (
						<Button
							type="button"
							size="icon-sm"
							variant="ghost"
							className="absolute top-1/2 right-1 -translate-y-1/2"
							aria-label="清空文件搜索"
							onClick={() => setSearchQuery("")}
						>
							<X className="size-3.5" />
						</Button>
					) : null}
				</div>
				{selectedPaths.size > 1 ? (
					<div className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
						<span>已选择 {selectedPaths.size} 项</span>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 px-2 text-xs"
							onClick={() => {
								setSelectedPaths(new Set());
								setSelectionAnchor(undefined);
							}}
						>
							清除选择
						</Button>
					</div>
				) : null}
				{!normalizedSearch && tree?.parent !== undefined ? (
					<div className="flex shrink-0 gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setSelectedPaths(new Set());
								setSelectionAnchor(undefined);
								void actions.loadProjectTree(tree.parent);
							}}
						>
							<ArrowLeft className="size-4" />
							上一级
						</Button>
					</div>
				) : null}
				{tree || normalizedSearch ? (
					<div
						className={cn(
							"relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background",
							dropTargetPath === "" && "border-primary/60 bg-primary/5",
						)}
						onDragEnter={(event) => {
							if (!isFileDrag(event)) return;
							event.preventDefault();
							event.dataTransfer.dropEffect = "copy";
							setDropTargetPath("");
						}}
						onDragOver={(event) => {
							if (!isFileDrag(event)) return;
							event.preventDefault();
							event.dataTransfer.dropEffect = "copy";
							setDropTargetPath("");
						}}
						onDragLeave={(event) => {
							if (!isFileDrag(event)) return;
							if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
							setDropTargetPath(undefined);
						}}
						onDrop={(event) => {
							if (!isFileDrag(event)) return;
							event.preventDefault();
							setDropTargetPath(undefined);
							const files = Array.from(event.dataTransfer.files);
							if (files.length) void uploadFiles(files, "");
						}}
					>
						{fileContent}
						{dropTargetPath === "" ? (
							<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80 text-sm font-medium text-foreground backdrop-blur-[1px]">
								释放以上传到项目根目录
							</div>
						) : null}
					</div>
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
			<Dialog open={Boolean(renameTarget)} onOpenChange={(open) => !open && closeRename()}>
				<DialogContent>
					<form className="grid gap-4" onSubmit={submitRename}>
						<DialogHeader>
							<DialogTitle>重命名{renameTarget?.kind === "directory" ? "目录" : "文件"}</DialogTitle>
							<DialogDescription className="truncate">{renameTarget?.path}</DialogDescription>
						</DialogHeader>
						<Input
							autoFocus
							aria-label="新文件名"
							aria-invalid={Boolean(renameDraft.trim() && !validFileName(renameDraft.trim()))}
							disabled={renameBusy}
							value={renameDraft}
							onChange={(event) => setRenameDraft(event.target.value)}
						/>
						<DialogFooter>
							<Button type="button" variant="outline" disabled={renameBusy} onClick={closeRename}>
								取消
							</Button>
							<Button type="submit" disabled={renameBusy || !validFileName(renameDraft.trim())}>
								{renameBusy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
								保存
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<Dialog open={archivePaths.length > 0} onOpenChange={(open) => !open && closeArchive()}>
				<DialogContent>
					<form className="grid gap-4" onSubmit={submitArchive}>
						<DialogHeader>
							<DialogTitle>生成 ZIP 压缩包</DialogTitle>
							<DialogDescription>
								将在项目根目录生成 ZIP，包含 {archivePaths.length} 个选中项。
							</DialogDescription>
						</DialogHeader>
						<Input
							autoFocus
							aria-label="ZIP 文件名"
							aria-invalid={Boolean(archiveDraft.trim() && !validFileName(archiveDraft.trim()))}
							disabled={archiveBusy}
							value={archiveDraft}
							onChange={(event) => setArchiveDraft(event.target.value)}
						/>
						<DialogFooter>
							<Button type="button" variant="outline" disabled={archiveBusy} onClick={closeArchive}>
								取消
							</Button>
							<Button type="submit" disabled={archiveBusy || !validFileName(archiveDraft.trim())}>
								{archiveBusy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
								生成 ZIP
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<Dialog open={deleteTargets.length > 0} onOpenChange={(open) => !open && closeDelete()}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>确认删除</DialogTitle>
						<DialogDescription>
							{deleteTargets.length === 1
								? `确定删除“${deleteTargets[0]?.name}”？${deleteTargets[0]?.kind === "directory" ? "目录内所有内容将一并删除。" : ""}`
								: `确定删除选中的 ${deleteTargets.length} 项？所选目录内所有内容将一并删除。`}此操作无法撤销。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" disabled={deleteBusy} onClick={closeDelete}>
							取消
						</Button>
						<Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void submitDelete()}>
							{deleteBusy ? (
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
							) : (
								<Trash2 className="size-4" />
							)}
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
