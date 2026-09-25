import { useEffect, useState } from "react";
import { formatElapsedDuration } from "./conversation-format";
export { formatElapsedDuration } from "./conversation-format";

/**
 * 回合处理中的实时耗时行，回合结束后由最终回复下方的“本次耗时”接手。
 * 计时起点是用户按下发送的时刻。
 */
export function LiveElapsedHeader({
	startedAt,
	onElapsedChange,
}: {
	startedAt: number;
	/** 每次跳动后回报当前显示的秒数，让回合结束时下方数字与用户看到的最后一个数字一致。 */
	onElapsedChange?: (startedAt: number, seconds: number) => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [startedAt]);
	const elapsedMs = Math.max(0, now - startedAt);
	const seconds = Math.floor(elapsedMs / 1_000);
	useEffect(() => {
		onElapsedChange?.(startedAt, seconds);
	}, [onElapsedChange, seconds, startedAt]);
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
