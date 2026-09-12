import { gsap } from "gsap";
import type { ComponentProps, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { runGsapMotion } from "../../lib/gsap-motion";
import { CollapsibleContent } from "./collapsible";

type GsapCollapsibleContentProps = Omit<
	ComponentProps<typeof CollapsibleContent>,
	"children" | "forceMount" | "ref"
> & {
	children: ReactNode;
	duration?: number;
	open: boolean;
};

export function GsapCollapsibleContent({
	children,
	duration = 0.18,
	open,
	style,
	...props
}: GsapCollapsibleContentProps) {
	const elementRef = useRef<HTMLDivElement>(null);
	const previousOpenRef = useRef(open);
	const fullyCollapsedRef = useRef(!open);
	const [mounted, setMounted] = useState(open);

	useLayoutEffect(() => {
		const element = elementRef.current;
		if (!element) return;

		if (open && !mounted) {
			setMounted(true);
			return;
		}
		if (!mounted) return;

		if (previousOpenRef.current === open) {
			if (open) {
				fullyCollapsedRef.current = false;
				gsap.set(element, { clearProps: "height,opacity,overflow,transform,visibility" });
			}
			return;
		}
		previousOpenRef.current = open;

		let entranceFrame = 0;
		const cleanupMotion = runGsapMotion(element, (reducedMotion) => {
			gsap.killTweensOf(element);
			if (reducedMotion || duration <= 0) {
				if (open) {
					fullyCollapsedRef.current = false;
					gsap.set(element, { clearProps: "height,opacity,overflow,transform,visibility" });
				} else {
					fullyCollapsedRef.current = true;
					setMounted(false);
				}
				return;
			}

			if (open) {
				const startHeight = fullyCollapsedRef.current ? 0 : element.getBoundingClientRect().height;
				gsap.set(element, { height: "auto", overflow: "hidden" });
				const targetHeight = element.getBoundingClientRect().height;
				if (fullyCollapsedRef.current) gsap.set(element, { autoAlpha: 0, height: 0, y: -4 });
				else gsap.set(element, { height: startHeight });
				fullyCollapsedRef.current = false;
				entranceFrame = window.requestAnimationFrame(() => {
					gsap.to(element, {
						autoAlpha: 1,
						duration,
						ease: "power2.out",
						height: targetHeight,
						overwrite: "auto",
						y: 0,
						onComplete: () => {
							gsap.set(element, { clearProps: "height,opacity,overflow,transform,visibility" });
						},
					});
				});
				return;
			}

			gsap.set(element, { height: element.getBoundingClientRect().height, overflow: "hidden" });
			gsap.to(element, {
				autoAlpha: 0,
				duration,
				ease: "power2.inOut",
				height: 0,
				overwrite: "auto",
				y: -4,
				onComplete: () => {
					fullyCollapsedRef.current = true;
					setMounted(false);
				},
			});
		});
		return () => {
			window.cancelAnimationFrame(entranceFrame);
			gsap.killTweensOf(element);
			cleanupMotion();
		};
	}, [duration, mounted, open]);

	return (
		<CollapsibleContent
			{...props}
			aria-hidden={open ? undefined : true}
			forceMount
			hidden={!mounted}
			ref={elementRef}
			style={{ ...style, pointerEvents: open ? style?.pointerEvents : "none" }}
		>
			{mounted ? children : null}
		</CollapsibleContent>
	);
}
