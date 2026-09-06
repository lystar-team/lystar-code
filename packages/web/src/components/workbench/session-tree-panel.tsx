import { RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils";
import type { WorkbenchState } from "../../state/use-workbench";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Task, TaskContent, TaskItem, TaskTrigger } from "../ai-elements/task";
import type { WorkbenchActions } from "./types";

export function SessionTreePanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }) {
	return (
		<div className="grid gap-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold">会话树</h2>
					<p className="mt-1 text-xs text-muted-foreground">从父级消息回到另一个上下文分支。</p>
				</div>
				<Button size="icon" variant="ghost" onClick={() => void actions.loadSessionTree()} aria-label="刷新会话树">
					<RefreshCw className={cn("size-4", state.sessionTreeLoading && "animate-spin")} />
				</Button>
			</div>
			<Task defaultOpen>
				<TaskTrigger title="上下文分支" />
				<TaskContent>
					{state.sessionTree.length ? (
						state.sessionTree.map((node) => (
							<Button
								key={node.id}
								className="w-full justify-start gap-2 text-left"
								variant={node.isLeaf ? "secondary" : "ghost"}
								style={{ paddingLeft: `${12 + node.depth * 14}px` }}
								onClick={() => void actions.navigateTree(node.id)}
							>
								<span className="size-2 shrink-0 rounded-full border border-primary" />
								<span className="min-w-0 flex-1 truncate">{node.label || node.preview || node.kind}</span>
								{node.isLeaf ? <Badge variant="outline">当前</Badge> : null}
							</Button>
						))
					) : (
						<TaskItem>还没有会话树记录</TaskItem>
					)}
				</TaskContent>
			</Task>
		</div>
	);
}
