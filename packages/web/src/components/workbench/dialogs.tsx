import { ArrowLeft, Check, ChevronRight, Folder, HardDrive, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import type { WebProject, UiRequestEvent } from "../../types";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import type { WorkbenchActions } from "./types";

export function DirectoryDialog({
	open,
	state,
	actions,
	onClose,
}: {
	open: boolean;
	state: WorkbenchState;
	actions: WorkbenchActions;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const listing = state.directoryListing;
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) onClose();
			}}
		>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>选择项目目录</DialogTitle>
					<DialogDescription>添加一个本机项目到工作台</DialogDescription>
				</DialogHeader>
				{listing ? (
					<>
						<div className="flex items-center gap-2">
							<HardDrive className="size-4 text-muted-foreground" />
							<Input
								value={listing.path}
								onChange={(event) => void actions.loadDirectory(event.target.value)}
								aria-label="当前目录"
							/>
						</div>
						<div className="flex gap-2">
							<Button size="sm" variant="outline" onClick={() => void actions.loadDirectory(listing.home)}>
								<HardDrive className="size-4" />
								主目录
							</Button>
							{listing.parent ? (
								<Button size="sm" variant="outline" onClick={() => void actions.loadDirectory(listing.parent)}>
									<ArrowLeft className="size-4" />
									上一级
								</Button>
							) : null}
						</div>
						<ScrollArea className="h-72 rounded-md border">
							<div className="grid gap-1 p-2">
								{listing.entries.map((entry) => (
									<Button
										key={entry.path}
										className="justify-start gap-2"
										variant={name === entry.name ? "secondary" : "ghost"}
										onClick={() => setName(entry.name)}
										onDoubleClick={() => void actions.loadDirectory(entry.path)}
									>
										<Folder className="size-4 text-amber-600" />
										<span className="truncate">{entry.name}</span>
										<ChevronRight className="ml-auto size-4" />
									</Button>
								))}
							</div>
						</ScrollArea>
						<DialogFooter>
							<div className="mr-auto min-w-0 text-left">
								<p className="text-xs text-muted-foreground">当前选择</p>
								<p className="max-w-80 truncate font-mono text-xs">{listing.path}</p>
							</div>
							<Button
								onClick={() => {
									void actions.addProject(listing.path, name || undefined);
									onClose();
								}}
							>
								<Plus className="size-4" />
								添加项目
							</Button>
						</DialogFooter>
					</>
				) : (
					<div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
						<LoaderCircle className="mr-2 size-4 animate-spin" />
						正在读取目录
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function ProjectRenameDialog({
	project,
	actions,
	onClose,
}: {
	project?: WebProject;
	actions: WorkbenchActions;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	useEffect(() => {
		setName(project?.name ?? "");
	}, [project]);
	return (
		<Dialog
			open={Boolean(project)}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>编辑项目</DialogTitle>
					<DialogDescription>修改项目在工作台中的显示名称</DialogDescription>
				</DialogHeader>
				<Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						取消
					</Button>
					<Button
						disabled={!name.trim() || !project}
						onClick={() => {
							if (project) void actions.updateProject(project.id, { name: name.trim() });
							onClose();
						}}
					>
						保存
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function UiRequestDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const request = state.pendingUiRequests[0];
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (request) inputRef.current?.focus();
	}, [request]);
	if (!request) return null;
	const payload =
		request.payload && typeof request.payload === "object" ? (request.payload as Record<string, unknown>) : {};
	const options = Array.isArray(payload.options)
		? payload.options.filter((option): option is string => typeof option === "string")
		: [];
	const finish = (response: { value?: unknown; confirmed?: boolean; cancelled?: boolean }) =>
		void actions
			.respondUiRequest(request, response)
			.catch((error) => actions.showToast(error instanceof Error ? error.message : String(error)));
	return (
		<Dialog open onOpenChange={() => undefined}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{request.title || "需要你的输入"}</DialogTitle>
					<DialogDescription>
						{typeof payload.message === "string"
							? payload.message
							: typeof payload.text === "string"
								? payload.text
								: "Agent 正在等待你的确认。"}
					</DialogDescription>
				</DialogHeader>
				{request.kind === "select" && options.length ? (
					<Select onValueChange={(selected) => finish({ value: selected })}>
						<SelectTrigger>
							<SelectValue placeholder="选择一项" />
						</SelectTrigger>
						<SelectContent>
							{options.map((option) => (
								<SelectItem key={option} value={option}>
									{option}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : request.kind === "confirm" ? (
					<DialogFooter>
						<Button variant="outline" onClick={() => finish({ confirmed: false, cancelled: true })}>
							取消
						</Button>
						<Button onClick={() => finish({ confirmed: true })}>确认</Button>
					</DialogFooter>
				) : (
					<>
						<Input
							ref={inputRef}
							type={request.kind === "secret" ? "password" : "text"}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							placeholder={request.kind === "secret" ? "输入内容不会显示" : "输入你的回复"}
						/>
						<DialogFooter>
							<Button variant="outline" onClick={() => finish({ cancelled: true })}>
								取消
							</Button>
							<Button disabled={!value.trim()} onClick={() => finish({ value })}>
								提交
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function Toast({ message }: { message?: string }) {
	if (!message) return null;
	return (
		<Alert
			className="fixed right-4 bottom-4 z-[60] w-[min(420px,calc(100vw-2rem))] border-border/70 bg-background shadow-[0_8px_30px_rgb(0_0_0/0.08)]"
			role="status"
		>
			<Check className="size-4 text-emerald-600" />
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}
