import { LoaderCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { TooltipProvider } from "./components/ui/tooltip";
import { BrandLogo } from "./components/brand-logo";
import { TokenGate } from "./components/workbench/token-gate";
import { useWorkbench } from "./state/use-workbench";

const Workbench = lazy(() =>
	import("./components/workbench").then((module) => ({ default: module.Workbench })),
);

export default function App() {
	const workbench = useWorkbench();
	const { state, currentProject, orderedProjects } = workbench;

	if (state.authRequired) {
		return <TokenGate loading={state.loading} error={state.connectionError} onSubmit={workbench.submitToken} />;
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
							<BrandLogo className="size-16 object-contain" alt="LYStar Code" />
							<span className="text-base font-semibold tracking-tight">LYStar Code</span>
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
