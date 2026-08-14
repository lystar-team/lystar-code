function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function selectOptions(value: unknown): Array<{ id: string; label: string; description?: string }> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item === "string") return [{ id: item, label: item }];
		const option = record(item);
		if (typeof option?.id !== "string" || typeof option.label !== "string") return [];
		return [
			{
				id: option.id,
				label: option.label,
				description: typeof option.description === "string" ? option.description : undefined,
			},
		];
	});
}
