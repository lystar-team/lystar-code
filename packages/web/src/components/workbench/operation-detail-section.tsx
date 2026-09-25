export type OperationDetail = {
	label: string;
	value: string;
	multiline?: boolean;
};

export function OperationDetailSection({ detail }: { detail: OperationDetail }) {
	return (
		<section className="space-y-1.5">
			<h3 className="text-xs font-medium text-muted-foreground">{detail.label}</h3>
			{detail.multiline ? (
				<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs leading-5">
					{detail.value}
				</pre>
			) : (
				<div className="break-words rounded-md border bg-muted/20 px-3 py-2 text-sm">{detail.value}</div>
			)}
		</section>
	);
}
