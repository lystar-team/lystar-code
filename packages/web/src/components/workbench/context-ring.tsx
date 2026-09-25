import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";

function formatContextTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

export function ContextRing({ contextWindow, usedTokens }: { contextWindow: number; usedTokens: number }) {
	const radius = 8;
	const circumference = 2 * Math.PI * radius;
	const usage = contextWindow > 0 ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0;
	const percent = Math.round(usage * 100);

	return (
		<HoverCard openDelay={0} closeDelay={0}>
			<HoverCardTrigger asChild>
				<button
					type="button"
					className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none"
					aria-label={`上下文使用率 ${percent}%`}
				>
					<svg
						className="size-5"
						viewBox="0 0 24 24"
						role="img"
						aria-label={`上下文使用率 ${percent}%`}
					>
						<circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
						<circle
							cx="12"
							cy="12"
							r={radius}
							fill="none"
							stroke="currentColor"
							strokeDasharray={`${circumference} ${circumference}`}
							strokeDashoffset={circumference * (1 - usage)}
							strokeLinecap="round"
							strokeWidth="2"
							style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
						/>
					</svg>
				</button>
			</HoverCardTrigger>
			<HoverCardContent
				side="top"
				align="center"
				sideOffset={4}
				className="w-max max-w-[calc(100vw-1rem)] rounded-xl border-border bg-background px-4 py-3 text-center text-sm shadow-[0_2px_8px_rgb(0_0_0/0.05)]"
			>
				<div className="grid gap-2 whitespace-nowrap">
					<div className="text-muted-foreground">背景信息窗口：</div>
					<div className="text-muted-foreground">{percent}% 已用</div>
					<div className="font-medium text-foreground">
						已用 {formatContextTokens(usedTokens)} 标记，共 {formatContextTokens(contextWindow)}
					</div>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}
