import { gsap } from "gsap";

export function runGsapMotion(scope: Element, animate: (reducedMotion: boolean) => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		animate(false);
		return () => {};
	}

	const media = gsap.matchMedia();
	media.add(
		{ all: "all", reduceMotion: "(prefers-reduced-motion: reduce)" },
		(context) => {
			animate(Boolean(context.conditions?.reduceMotion));
		},
		scope,
	);
	return () => media.revert();
}
