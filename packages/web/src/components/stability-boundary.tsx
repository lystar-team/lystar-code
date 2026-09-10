import { AlertTriangle, Download, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { downloadBrowserDiagnostics, recordBrowserDiagnostic } from "../lib/browser-diagnostics";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export interface StabilityFallbackContext {
	error: Error;
	reset: () => void;
	diagnosticId?: string;
}

interface StabilityBoundaryProps {
	children: ReactNode;
	scope: string;
	fallback: (context: StabilityFallbackContext) => ReactNode;
	resetKeys?: readonly unknown[];
}

interface StabilityBoundaryState {
	error?: Error;
	diagnosticId?: string;
}

const EMPTY_STATE: StabilityBoundaryState = {};

function resetKeysChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
	if (previous === next) return false;
	if (!previous || !next || previous.length !== next.length) return true;
	return previous.some((value, index) => !Object.is(value, next[index]));
}

export class StabilityBoundary extends Component<StabilityBoundaryProps, StabilityBoundaryState> {
	state: StabilityBoundaryState = EMPTY_STATE;

	static getDerivedStateFromError(error: Error): StabilityBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		const diagnosticId = recordBrowserDiagnostic(this.props.scope, error, info.componentStack ?? undefined);
		this.setState({ diagnosticId });
	}

	componentDidUpdate(previousProps: StabilityBoundaryProps): void {
		if (this.state.error && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) this.setState(EMPTY_STATE);
	}

	private readonly reset = (): void => {
		this.setState(EMPTY_STATE);
	};

	render(): ReactNode {
		if (!this.state.error) return this.props.children;
		return this.props.fallback({
			error: this.state.error,
			reset: this.reset,
			diagnosticId: this.state.diagnosticId,
		});
	}
}

export function StabilityFallbackPanel({
	title,
	message,
	error,
	onReset,
	className,
	fullHeight = false,
	retryLabel = "重新加载此区域",
}: {
	title: string;
	message: string;
	error: Error;
	onReset: () => void;
	className?: string;
	fullHeight?: boolean;
	retryLabel?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 items-center justify-center bg-background p-5 text-foreground",
				fullHeight && "min-h-dvh",
				className,
			)}
			role="alert"
		>
			<div className="w-full max-w-xl rounded-2xl border border-border bg-background p-5 shadow-sm">
				<div className="flex items-start gap-3">
					<AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
					<div className="min-w-0 flex-1">
						<h2 className="font-semibold">{title}</h2>
						<p className="mt-1 text-sm text-muted-foreground">{message}</p>
						<details className="mt-3 text-xs text-muted-foreground">
							<summary className="cursor-pointer select-none">错误信息</summary>
							<pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono">
								{error.message}
							</pre>
						</details>
						<div className="mt-4 flex flex-wrap gap-2">
							<Button size="sm" onClick={onReset}>
								<RotateCcw className="size-4" />
								{retryLabel}
							</Button>
							<Button size="sm" variant="outline" onClick={downloadBrowserDiagnostics}>
								<Download className="size-4" />
								下载诊断信息
							</Button>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
