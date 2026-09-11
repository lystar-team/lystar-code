import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

type BrandLogoProps = Omit<ComponentProps<"img">, "src"> & {
	logo?: string;
};

export function BrandLogo({ alt = "", className, logo, ...props }: BrandLogoProps) {
	if (logo) {
		return (
			<span className="brand-logo" aria-hidden={alt ? undefined : true}>
				<img {...props} className={className} src={logo} alt={alt} />
			</span>
		);
	}

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
