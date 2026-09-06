import { TooltipProvider } from "./components/ui/tooltip";
import { TokenGate, Workbench } from "./components/workbench";
import { useWorkbench } from "./state/use-workbench";

export default function App() {
	const workbench = useWorkbench();
	const { state, currentProject, orderedProjects } = workbench;

	if (state.authRequired) {
		return <TokenGate loading={state.loading} error={state.connectionError} onSubmit={workbench.submitToken} />;
	}

	return (
		<TooltipProvider>
			<Workbench state={state} actions={workbench} projects={orderedProjects} currentProject={currentProject} />
		</TooltipProvider>
	);
}
