import { gsap } from "gsap";
import { Menu, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkbenchState } from "../../state/use-workbench";
import type { RoomMemberSelection, RoomProjectList } from "../../state/use-room-workspace";
import type { WebProject } from "../../types";
import { StabilityBoundary, StabilityFallbackPanel } from "../stability-boundary";
import { Button } from "../ui/button";
import { ProjectRail } from "./project-rail";
import { RoomRail } from "./room-rail";
import type { WorkspaceMode } from "./workspace-mode-switch";
import type { WorkbenchActions } from "./types";

export function MobileProjectRailDialog({
	actions,
	currentProject,
	onAddProject,
	onEditProject,
	projects,
	state,
	workspaceMode,
	onWorkspaceModeChange,
	roomProjects,
	roomAgentSessionIds,
	roomsLoading,
	roomsError,
	selectedRoomId,
	onSelectRoom,
	onCreateRoom,
}: {
	actions: WorkbenchActions;
	currentProject?: WebProject;
	onAddProject: () => void;
	onEditProject: (project: WebProject) => void;
	projects: WebProject[];
	state: WorkbenchState;
	workspaceMode: WorkspaceMode;
	onWorkspaceModeChange: (mode: WorkspaceMode) => void;
	roomProjects: RoomProjectList[];
	roomAgentSessionIds: ReadonlySet<string>;
	roomsLoading: boolean;
	roomsError?: string;
	selectedRoomId?: string;
	onSelectRoom: (projectId: string, roomId: string) => void;
	onCreateRoom: (projectId: string, title: string, member: RoomMemberSelection) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLButtonElement>(null);
	const timelineRef = useRef<gsap.core.Timeline | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const close = useCallback(() => {
		const content = contentRef.current;
		const overlay = overlayRef.current;
		if (!content || !overlay || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setOpen(false);
			window.requestAnimationFrame(() => triggerRef.current?.focus());
			return;
		}

		timelineRef.current?.kill();
		gsap.killTweensOf([overlay, content]);
		timelineRef.current = gsap
			.timeline({
				defaults: { overwrite: "auto" },
				onComplete: () => {
					timelineRef.current = null;
					setOpen(false);
					triggerRef.current?.focus();
				},
			})
			.to(overlay, { autoAlpha: 0, duration: 0.12, ease: "power1.in" }, 0)
			.to(content, { duration: 0.16, ease: "power2.inOut", xPercent: -100 }, 0);
	}, []);

	useLayoutEffect(() => {
		const content = contentRef.current;
		const overlay = overlayRef.current;
		if (!content || !overlay) return;
		content.inert = !open;
		timelineRef.current?.kill();
		gsap.killTweensOf([overlay, content]);

		if (!open) {
			gsap.set(overlay, { autoAlpha: 0 });
			gsap.set(content, { autoAlpha: 0, xPercent: -100 });
			return;
		}

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			gsap.set(overlay, { autoAlpha: 1 });
			gsap.set(content, { autoAlpha: 1, xPercent: 0 });
			closeButtonRef.current?.focus();
			return;
		}

		gsap.set(overlay, { autoAlpha: 0 });
		gsap.set(content, { autoAlpha: 1, xPercent: -100 });
		const entranceFrame = window.requestAnimationFrame(() => {
			timelineRef.current = gsap
				.timeline({
					defaults: { overwrite: "auto" },
					onComplete: () => {
						timelineRef.current = null;
						closeButtonRef.current?.focus();
					},
				})
				.to(overlay, { autoAlpha: 1, duration: 0.12, ease: "power1.out" }, 0)
				.to(content, { duration: 0.18, ease: "power2.out", xPercent: 0 }, 0);
		});

		return () => {
			window.cancelAnimationFrame(entranceFrame);
			timelineRef.current?.kill();
			timelineRef.current = null;
			gsap.killTweensOf([overlay, content]);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return;
			}
			if (event.key !== "Tab") return;
			const content = contentRef.current;
			if (!content) return;
			const focusable = Array.from(
				content.querySelectorAll<HTMLElement>(
					'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
				),
			).filter((element) => element.getClientRects().length > 0);
			const first = focusable[0];
			const last = focusable.at(-1);
			if (!first || !last) return;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [close, open]);

	return (
		<>
			<Button
				ref={triggerRef}
				className="lg:hidden"
				size="icon"
				variant="ghost"
				aria-expanded={open}
				aria-label="打开项目和会话"
				onClick={() => setOpen(true)}
			>
				<Menu className="size-4" />
			</Button>
			<button
				ref={overlayRef}
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				className="fixed inset-0 z-50 cursor-default border-0 bg-black/50 p-0 lg:hidden"
				onClick={close}
				style={{ opacity: 0, visibility: "hidden" }}
			/>
			<div
				ref={contentRef}
				role="dialog"
				aria-label="项目与会话"
				aria-modal="true"
				aria-hidden={!open}
				className="fixed inset-y-0 left-0 z-50 flex w-[min(88vw,360px)] flex-col border-r border-border/60 bg-background shadow-lg will-change-transform lg:hidden"
				style={{ opacity: 0, visibility: "hidden" }}
			>
				<Button
					ref={closeButtonRef}
					className="absolute top-4 right-3 z-20"
					size="icon-sm"
					variant="ghost"
					aria-label="关闭项目和会话"
					onClick={close}
				>
					<X className="size-4" />
				</Button>
				<StabilityBoundary
					scope="mobile-project-rail"
					resetKeys={[state.currentProjectId]}
					fallback={({ error, reset }) => (
						<StabilityFallbackPanel
							className="h-full"
							title="项目栏没有正常显示"
							message="关闭面板后仍可使用当前会话。"
							error={error}
							onReset={reset}
						/>
					)}
				>
					{workspaceMode === "rooms" ? (
						<RoomRail
							state={state}
							actions={actions}
							projects={projects}
							roomProjects={roomProjects}
							roomsLoading={roomsLoading}
							roomsError={roomsError}
							selectedRoomId={selectedRoomId}
							onSelectRoom={(projectId, summary) => onSelectRoom(projectId, summary.room.id)}
							onCreateRoom={onCreateRoom}
							onModeChange={onWorkspaceModeChange}
							onNavigate={close}
						/>
					) : (
						<ProjectRail
							state={state}
							actions={actions}
							projects={projects}
							roomAgentSessionIds={roomAgentSessionIds}
							currentProject={currentProject}
							onAddProject={onAddProject}
							onEditProject={onEditProject}
							onNavigate={close}
							workspaceMode={workspaceMode}
							onWorkspaceModeChange={onWorkspaceModeChange}
						/>
					)}
				</StabilityBoundary>
			</div>
		</>
	);
}
