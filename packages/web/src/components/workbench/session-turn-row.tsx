import { Bot, GitFork, ListRestart, MessageSquareText, Wrench } from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	formatSessionTreeTimestamp,
	sessionTreeNodeKindLabel,
	sessionTurnLabel,
	type SessionTurn,
} from "./session-tree-utils";

function sessionTurnIcon(turn: SessionTurn) {
	if (turn.toolNodes.length > 0) return <Wrench className="size-4" />;
	if (turn.supportingNodes.some((node) => node.kind === "compaction")) return <ListRestart className="size-4" />;
	if (turn.supportingNodes.some((node) => node.kind === "branch_summary")) return <GitFork className="size-4" />;
	if (turn.userNode) return <MessageSquareText className="size-4" />;
	if (turn.responseNodes.length > 0) return <Bot className="size-4" />;
	return <MessageSquareText className="size-4" />;
}

export function SessionTurnRow({
	turn,
	selected,
	disabled,
	compact = false,
	onSelect,
}: {
	turn: SessionTurn;
	selected: boolean;
	disabled: boolean;
	compact?: boolean;
	onSelect: () => void;
}) {
	const lastResponse = turn.responseNodes.at(-1);

	return (
		<div
			className={cn(
				"flex h-full w-full min-w-0 max-w-full flex-col justify-center rounded-lg border bg-card px-2.5 py-1.5 shadow-none",
				selected && "border-primary bg-primary/5 ring-1 ring-primary/30",
			)}
		>
			<div className="flex min-w-0 items-center">
				<Button
					className={cn(
						"h-6 min-w-0 min-h-0 flex-1 justify-start gap-2 overflow-hidden whitespace-normal p-0 text-left leading-4 hover:bg-transparent",
						compact && "gap-1.5",
					)}
					variant="ghost"
					disabled={disabled}
					aria-pressed={selected}
					aria-label={`${sessionTurnLabel(turn)}${turn.isLeaf ? "，当前位置" : ""}`}
					onClick={onSelect}
				>
						<span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
							{sessionTurnIcon(turn)}
						</span>
					<span className="min-w-0 flex-1 truncate text-sm font-medium" title={sessionTurnLabel(turn)}>
						{sessionTurnLabel(turn)}
					</span>
					{turn.isLeaf ? <Badge className="shrink-0" variant="outline">当前位置</Badge> : null}
				</Button>
			</div>

			<div className="flex min-w-0 items-center justify-between gap-2 pl-7">
				<span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
					<span className="shrink-0">会话轮次</span>
					<span aria-hidden="true">·</span>
					<time className="shrink-0" dateTime={turn.timestamp}>
						{formatSessionTreeTimestamp(turn.timestamp)}
					</time>
					{lastResponse ? (
						<>
							<span aria-hidden="true">·</span>
							<span className="truncate">{sessionTreeNodeKindLabel(lastResponse)}</span>
						</>
					) : null}
				</span>
			</div>
		</div>
	);
}
