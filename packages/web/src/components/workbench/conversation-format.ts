export function formatElapsedDuration(durationMs: number): string | undefined {
	if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
	const totalSeconds = Math.floor(durationMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}秒`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const secondsLabel = seconds > 0 ? `${String(seconds).padStart(2, "0")}秒` : "";
	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours === 0) return `${totalMinutes}分钟${secondsLabel}`;
	const paddedMinutes = String(minutes).padStart(2, "0");
	if (totalHours < 24) return `${totalHours}小时${paddedMinutes}分钟${secondsLabel}`;
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return `${days}天${String(hours).padStart(2, "0")}小时${paddedMinutes}分钟${secondsLabel}`;
}
