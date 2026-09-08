import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

type BrandLogoProps = Omit<ComponentProps<"img">, "src">;

export function BrandLogo({ alt = "", className, ...props }: BrandLogoProps) {
	return (
		<span className="brand-logo" aria-hidden={alt ? undefined : true}>
			<img
				{...props}
				className={cn("brand-logo-light", className)}
				src="/brand/lystar-mark-light.png"
				alt={alt}
			/>
			<img
				{...props}
				className={cn("brand-logo-dark", className)}
				src="/brand/lystar-mark-dark.png"
				alt={alt}
			/>
		</span>
	);
}
