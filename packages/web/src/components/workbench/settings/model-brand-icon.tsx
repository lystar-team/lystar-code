import { cn } from "../../../lib/utils";
import { modelIconId, providerIconId } from "../model-utils";

export function ModelBrandIcon({
	providerId,
	modelId,
	name,
	small = false,
}: {
	providerId: string;
	modelId: string;
	name: string;
	small?: boolean;
}) {
	const iconId = modelIconId(providerId, modelId, name);
	const src = iconId ? `/brand/models/${iconId}.svg` : `/brand/providers/${providerIconId(providerId)}.svg`;
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-background",
				small ? "size-9" : "size-9",
			)}
			aria-hidden="true"
		>
			<img src={src} className={cn("object-contain dark:invert", small ? "size-6" : "size-5")} alt="" />
		</span>
	);
}
