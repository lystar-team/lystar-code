import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { BrandLogo } from "./components/brand-logo";
import { StabilityBoundary, StabilityFallbackPanel } from "./components/stability-boundary";
import { TooltipProvider } from "./components/ui/tooltip";
import { TokenGate } from "./components/workbench/token-gate";
import { useWorkbench } from "./state/use-workbench";

const Workbench = lazy(() =>
	import("./components/workbench").then((module) => ({ default: module.Workbench })),
);

function AppContent() {
	const workbench = useWorkbench();
	const { state, currentProject, orderedProjects } = workbench;

	useEffect(() => {
		document.title = state.branding.name;
	}, [state.branding.name]);

	if (state.authRequired) {
		return <TokenGate branding={state.branding} loading={state.loading} error={state.connectionError} onSubmit={workbench.submitToken} />;
	}

	return (
		<TooltipProvider>
			<Suspense
				fallback={
					<div className="grid min-h-dvh place-items-center bg-background text-foreground">
						<div
							className="flex flex-col items-center gap-2"
							role="status"
							aria-live="polite"
							aria-busy="true"
						>
							<BrandLogo logo={state.branding.logo} className="size-16 object-contain" alt={state.branding.name} />
							<span className="text-base font-semibold tracking-tight">{state.branding.name}</span>
							<span className="mt-2 text-sm text-muted-foreground">正在进入工作台</span>
							<LoaderCircle className="mt-1 size-5 animate-spin" aria-hidden="true" />
						</div>
					</div>
				}
			>
				<Workbench state={state} actions={workbench} projects={orderedProjects} currentProject={currentProject} />
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
