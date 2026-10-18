import { useEffect, useState } from "react";
import { formatElapsedDuration } from "./conversation-format";
export { formatElapsedDuration } from "./conversation-format";

/** 实时计时沿用已校正的起点，通过单调时钟递增。 */
export function LiveElapsedHeader({ startedAt }: { startedAt: number }) {
	const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - startedAt));
	useEffect(() => {
		const initialElapsed = Math.max(0, Date.now() - startedAt);
		const receivedAt = performance.now();
		setElapsedMs(initialElapsed);
		const timer = window.setInterval(() => setElapsedMs(initialElapsed + performance.now() - receivedAt), 1_000);
		return () => window.clearInterval(timer);
	}, [startedAt]);
	const label = formatElapsedDuration(elapsedMs);
	return (
		<div className="w-full" data-testid="live-elapsed">
			<div className="pb-2 text-xs text-muted-foreground">{label ? `已处理 ${label}` : "已处理"}</div>
			<div
				aria-label="已处理耗时与回复分界"
				className="w-full border-t border-border/50"
				role="separator"
			/>
		</div>
	);
}
