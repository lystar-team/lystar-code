export const THINKING_LEVEL_LABELS: Record<string, string> = {
	off: "关闭(Off)",
	minimal: "低(Low)",
	low: "低(Low)",
	medium: "中(Medium)",
	high: "高(High)",
	xhigh: "极高(XHigh)",
	max: "最大(Max)",
	ultra: "极致(Ultra)",
};

export const VISIBLE_THINKING_LEVELS = ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function selectedVisibleThinkingLevel(level: string, visibleLevels: readonly string[]): string {
	return level === "minimal" && visibleLevels.includes("low") ? "low" : level;
}

export function visibleThinkingLevels(levels: readonly string[]): string[] {
	const supported = new Set(levels);
	const visible: string[] = [];
	for (const level of VISIBLE_THINKING_LEVELS) {
		if (level !== "low") {
			if (supported.has(level)) visible.push(level);
			continue;
		}
		if (supported.has("low")) visible.push("low");
		else if (supported.has("minimal")) visible.push("minimal");
	}
	return visible;
}

export const ACTIVE_OPERATION_STATUSES = new Set(["accepted", "running", "waiting_for_input"]);
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 392;

export function sidebarWidthFromPointer(clientX: number, sidebarLeft: number): number {
	const width = clientX - sidebarLeft;
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}
