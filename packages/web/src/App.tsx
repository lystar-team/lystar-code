import { lazy, Suspense } from "react";
import { TooltipProvider } from "./components/ui/tooltip";
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
					<div className="grid min-h-dvh place-items-center bg-background text-sm text-muted-foreground">
						正在加载工作台
					</div>
				}
			>
				<Workbench state={state} actions={workbench} projects={orderedProjects} currentProject={currentProject} />
			</Suspense>
		</TooltipProvider>
	);
}
