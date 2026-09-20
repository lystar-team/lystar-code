"use client";

import { useEffect, useState } from "react";

/**
 * 引入自 beUI：只有具备真实悬停能力的设备（鼠标、触控板）返回 true。
 * 触摸设备在点按时会触发并保持幽灵 hover，悬停专属效果需要按此开关。
 */
export function useHoverCapable(): boolean {
	const [canHover, setCanHover] = useState(false);

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const media = window.matchMedia("(hover: hover) and (pointer: fine)");
		const update = () => setCanHover(media.matches);
		update();
		media.addEventListener?.("change", update);
		return () => media.removeEventListener?.("change", update);
	}, []);

	return canHover;
}
