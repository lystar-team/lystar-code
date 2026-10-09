import { lazy, Suspense, useEffect } from "react";
import { StabilityBoundary, StabilityFallbackPanel } from "./components/stability-boundary";
import { TooltipProvider } from "./components/ui/tooltip";
import type { Workbench as WorkbenchComponent } from "./components/workbench";
import { TokenGate } from "./components/workbench/token-gate";
import { useWorkbench } from "./state/use-workbench";

const workbenchModules = import.meta.glob<{ Workbench: typeof WorkbenchComponent }>("./components/workbench.tsx");
const Workbench = lazy(() =>
	workbenchModules["./components/workbench.tsx"]!().then((module) => ({ default: module.Workbench })),
);

function WorkbenchLoadingShell() {
	return (
		<div
			className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground"
			role="status"
			aria-label="正在加载工作台"
			aria-busy="true"
		>
			<div className="hidden w-16 shrink-0 flex-col items-center border-r border-border/60 px-3 py-4 md:flex">
				<div className="size-8 animate-pulse rounded bg-muted" />
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex h-16 shrink-0 items-center justify-between border-b border-border/60 px-4">
					<div className="h-4 w-40 animate-pulse rounded bg-muted" />
					<div className="size-8 animate-pulse rounded bg-muted" />
				</header>
				<div className="flex min-h-0 flex-1">
					<aside className="hidden w-72 shrink-0 space-y-3 border-r border-border/60 p-4 md:block">
						{Array.from({ length: 7 }, (_, index) => (
							<div className="h-8 animate-pulse rounded bg-muted/70" key={index} />
						))}
					</aside>
					<main className="flex min-w-0 flex-1 flex-col">
						<div className="h-16 shrink-0 border-b border-border/60" />
						<div className="flex min-h-0 flex-1 justify-center p-5 sm:p-8">
							<div className="w-full max-w-3xl space-y-6">
								<div className="h-12 w-3/4 animate-pulse rounded bg-muted/70" />
								<div className="h-24 animate-pulse rounded bg-muted/70" />
								<div className="h-16 w-5/6 animate-pulse rounded bg-muted/70" />
							</div>
						</div>
					</main>
				</div>
			</div>
		</div>
	);
}
function AppContent() {
	const workbench = useWorkbench();
	const { state, currentProject, orderedProjects } = workbench;

	useEffect(() => {
		document.title = state.branding.name;
	}, [state.branding.name]);

	if (state.authRequired) {
		return (
			<TokenGate
				branding={state.branding}
				loading={state.loading}
				error={state.connectionError}
				onSubmit={workbench.submitToken}
			/>
		);
	}

	return (
		<TooltipProvider>
			<Suspense fallback={<WorkbenchLoadingShell />}>
				<Workbench
					state={state}
					actions={workbench.actions}
					projects={orderedProjects}
					currentProject={currentProject}
				/>
			</Suspense>
		</TooltipProvider>
	);
}

export default function App() {
	return (
		<StabilityBoundary
			scope="app-root"
			fallback={({ error }) => (
				<StabilityFallbackPanel
					title="工作台没有正常加载"
					message="页面已停止继续渲染，避免出现白屏。重新加载后可以继续使用。"
					error={error}
					onReset={() => window.location.reload()}
					retryLabel="重新加载页面"
					fullHeight
				/>
			)}
		>
			<AppContent />
		</StabilityBoundary>
	);
}
