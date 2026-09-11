import { gsap } from "gsap";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { runGsapMotion } from "../../lib/gsap-motion";

type GsapRevealProps = {
	animationKey: string | number;
	children: ReactNode;
	className?: string;
	delay?: number;
	distance?: number;
	duration?: number;
};

export function GsapReveal({
	animationKey,
	children,
	className,
	delay = 0,
	distance = 12,
	duration = 0.32,
}: GsapRevealProps) {
	const elementRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const element = elementRef.current;
		if (!element) return;

		return runGsapMotion(element, (reducedMotion) => {
			if (reducedMotion) return;
			gsap.fromTo(
				element,
				{ autoAlpha: 0, y: distance },
				{
					autoAlpha: 1,
					y: 0,
					delay,
					duration,
					ease: "power2.out",
					overwrite: "auto",
					clearProps: "opacity,visibility,transform",
				},
			);
		});
	}, [animationKey, delay, distance, duration]);

	return (
		<div className={className} ref={elementRef}>
			{children}
		</div>
	);
}
