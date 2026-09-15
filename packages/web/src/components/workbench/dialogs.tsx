import { gsap } from "gsap";
import { ArrowLeft, Check, ChevronRight, Folder, HardDrive, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { sessionTitle, type WorkbenchState } from "../../state/use-workbench";
import type { WebProject, UiRequestEvent, WebSessionSummary } from "../../types";
import { runGsapMotion } from "../../lib/gsap-motion";
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
	const [selectedDirectory, setSelectedDirectory] = useState<string>();
	const directoryPathRef = useRef<string>();
	const listing = state.directoryListing;
	const requestDirectory = useCallback(
		(path?: string) => {
			directoryPathRef.current = path;
			void actions.loadDirectory(path).catch(() => {});
		},
		[actions.loadDirectory],
	);
	useEffect(() => {
		if (!open) setSelectedDirectory(undefined);
		directoryPathRef.current = listing?.path;
	}, [listing?.path, open]);
	useEffect(() => {
		if (!open) return;
		const refresh = () => {
			if (document.visibilityState === "visible") requestDirectory(directoryPathRef.current);
		};
		refresh();
		const timer = window.setInterval(refresh, 3000);
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [open, requestDirectory]);
	useEffect(() => {
		if (!open || !listing || !selectedDirectory || selectedDirectory === listing.path) return;
		if (!listing.entries.some((entry) => entry.path === selectedDirectory)) setSelectedDirectory(undefined);
	}, [listing, open, selectedDirectory]);
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
								className="min-w-0 flex-1"
								value={listing.path}
								onChange={(event) => {
									const path = event.target.value;
									setSelectedDirectory(path);
									requestDirectory(path);
								}}
								aria-label="当前目录"
							/>
							<Button
								size="icon"
								variant="ghost"
								onClick={() => requestDirectory(listing.path)}
								disabled={state.directoryLoading}
								aria-label="刷新当前目录"
							>
								<RefreshCw className={state.directoryLoading ? "size-4 animate-spin" : "size-4"} />
							</Button>
						</div>
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setSelectedDirectory(listing.home);
									requestDirectory(listing.home);
								}}
							>
								<HardDrive className="size-4" />
								主目录
							</Button>
							{listing.parent ? (
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										setSelectedDirectory(listing.parent);
										requestDirectory(listing.parent);
									}}
								>
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
										className="justify-start gap-2 text-xs"
										variant={selectedDirectory === entry.path ? "secondary" : "ghost"}
										onClick={() => setSelectedDirectory(entry.path)}
										onDoubleClick={() => {
											setSelectedDirectory(entry.path);
											requestDirectory(entry.path);
										}}
									>
										<Folder className="size-4 text-blue-500" />
										<span className="truncate font-mono !text-xs">{entry.name}</span>
										<ChevronRight className="ml-auto size-4" />
									</Button>
								))}
							</div>
						</ScrollArea>
						<DialogFooter>
							<div className="mr-auto min-w-0 text-left">
								<p className="text-xs text-muted-foreground">当前选择</p>
								<p className="max-w-80 truncate font-mono text-xs">{selectedDirectory ?? listing.path}</p>
							</div>
							<Button
								onClick={() => {
									void actions.addProject(selectedDirectory ?? listing.path);
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

export function SessionRenameDialog({
	session,
	actions,
	onClose,
}: {
	session?: WebSessionSummary;
	actions: WorkbenchActions;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setName(sessionTitle(session));
	}, [session]);

	const save = async () => {
		if (!session || saving) return;
		const nextName = name.trim();
		if (!nextName) return;
		setSaving(true);
		try {
			await actions.renameSession(session.id, nextName);
			onClose();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog
			open={Boolean(session)}
			onOpenChange={(open) => {
				if (!open && !saving) onClose();
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>重命名会话</DialogTitle>
					<DialogDescription>修改会话在工作台中的显示名称</DialogDescription>
				</DialogHeader>
				<Input aria-label="会话名称" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={saving}>
						取消
					</Button>
					<Button disabled={!session || !name.trim() || saving} onClick={() => void save()}>
						{saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
						保存
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function GitCredentialAuthorizationDialog({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	const message = state.gitCredentialAuthorizationMessage;
	return (
		<Dialog
			open={Boolean(message)}
			onOpenChange={(open) => {
				if (!open) actions.closeGitCredentialAuthorization();
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>需要在 Mac 本机授权 Git 钥匙串</DialogTitle>
					<DialogDescription>{message}</DialogDescription>
				</DialogHeader>
				<Alert>
					<AlertDescription>
						后台不会等待系统密码窗口。需要 HTTPS 凭据的 Git 操作会暂停；其他 Web 功能和已经完成的应用更新不受影响。请在运行服务的 Mac 本机终端执行下面的命令，终端会隐藏输入一次 macOS 登录钥匙串密码，并批量授权全部已登记的 Git HTTPS 凭据。
						<code className="mt-2 block w-fit rounded bg-muted px-2 py-1 text-xs">lc web permissions setup</code>
					</AlertDescription>
				</Alert>
				<DialogFooter>
					<Button variant="outline" onClick={actions.closeGitCredentialAuthorization}>
						关闭
					</Button>
					<Button
						onClick={() => {
							actions.closeGitCredentialAuthorization();
							void actions.openSettings("permissions");
						}}
					>
						查看系统授权
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
	const [displayMessage, setDisplayMessage] = useState(message);
	const [dismissedMessage, setDismissedMessage] = useState<string>();
	const toastRef = useRef<HTMLDivElement>(null);
	const isDismissed = Boolean(message && dismissedMessage === message);
	const displayed = Boolean(displayMessage);
	const visible = Boolean(message && !isDismissed);

	useEffect(() => {
		if (!message && !displayMessage) setDismissedMessage(undefined);
	}, [displayMessage, message]);

	useLayoutEffect(() => {
		if (visible && displayMessage !== message) setDisplayMessage(message);
	}, [displayMessage, message, visible]);

	useLayoutEffect(() => {
		const element = toastRef.current;
		if (!element || !displayed) return;

		let cancelMotion: (() => void) | undefined;
		const frameId = window.requestAnimationFrame(() => {
			cancelMotion = runGsapMotion(element, (reducedMotion) => {
				if (!visible) {
					if (reducedMotion) {
						setDisplayMessage(undefined);
						return;
					}
					gsap.to(element, {
						autoAlpha: 0,
						y: -8,
						duration: 0.18,
						ease: "power2.in",
						overwrite: "auto",
						onComplete: () => setDisplayMessage(undefined),
					});
					return;
				}

				if (reducedMotion) return;
				gsap.fromTo(
					element,
					{ autoAlpha: 0, y: -8 },
					{
						autoAlpha: 1,
						y: 0,
						duration: 0.22,
						ease: "power2.out",
						overwrite: "auto",
						clearProps: "opacity,visibility,transform",
					},
				);
			});
		});

		return () => {
			window.cancelAnimationFrame(frameId);
			cancelMotion?.();
		};
	}, [displayed, visible]);

	if (!displayMessage) return null;
	return (
		<div
			ref={toastRef}
			className="pointer-events-none fixed top-[calc(env(safe-area-inset-top)+5rem)] right-4 left-auto z-40 w-[min(420px,calc(100vw-2rem))] max-w-full"
		>
			<Alert
				className="pointer-events-auto w-full rounded-xl border border-border/70 bg-card pr-12 shadow-[0_12px_32px_rgb(0_0_0/0.14)]"
				role="status"
			>
				<Check className="size-4 text-emerald-600" />
				<AlertDescription className="min-w-0 break-words">{displayMessage}</AlertDescription>
				<Button
					aria-label="关闭提示"
					className="absolute top-2 right-2 text-muted-foreground"
					onClick={() => {
						if (message) setDismissedMessage(message);
					}}
					size="icon-sm"
					variant="ghost"
				>
					<X className="size-4" />
				</Button>
			</Alert>
		</div>
	);
}
