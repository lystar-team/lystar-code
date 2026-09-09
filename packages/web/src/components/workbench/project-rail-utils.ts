export type DropPosition = "before" | "after";

export function reorderIds(
	ids: readonly string[],
	sourceId: string,
	targetId: string,
	position: DropPosition,
): string[] {
	if (sourceId === targetId) return [...ids];
	const next = ids.filter((id) => id !== sourceId);
	const targetIndex = next.indexOf(targetId);
	if (targetIndex < 0) return [...ids];
	next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
	return next;
}
