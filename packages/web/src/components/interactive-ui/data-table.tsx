import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useInteractiveUiData } from "./context";

export function InteractiveUiDataTable({ tableId }: { tableId: string }) {
	const { snapshot, view, setTableSearch, toggleTableRow } = useInteractiveUiData();
	const table = snapshot.tables?.find((table) => table.id === tableId);
	if (!table)
		return (
			<p role="alert" className="text-sm text-destructive">
				未找到数据表：{tableId}
			</p>
		);
	const search = view.searches[tableId] ?? "";
	const selected = view.tableSelections[tableId] ?? [];
	const query = search.trim().toLocaleLowerCase();
	const rows = table.rows.filter(
		(row) =>
			!query ||
			table.columns.some((column) =>
				String(row.cells[column.key] ?? "")
					.toLocaleLowerCase()
					.includes(query),
			),
	);
	return (
		<div className="grid min-w-0 gap-3">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<label className="grid gap-2 text-sm font-medium">
					{table.label}
					<Input
						type="search"
						value={search}
						placeholder="搜索表格内容"
						onChange={(event) => setTableSearch(tableId, event.currentTarget.value)}
					/>
				</label>
				<span className="text-xs text-muted-foreground">
					显示 {rows.length} / {table.rows.length} 项 · 已选{" "}
					{table.rows.filter((row) => selected.includes(row.id)).length} 项
				</span>
			</div>
			<div className="min-w-0 overflow-x-auto rounded-lg border border-border">
				<table className="w-full text-left text-sm">
					<caption className="sr-only">{table.label}</caption>
					<thead className="bg-muted/40 text-xs text-muted-foreground">
						<tr>
							<th className="w-10 p-3">
								<span className="sr-only">选择</span>
							</th>
							{table.columns.map((column) => (
								<th key={column.key} scope="col" className="whitespace-nowrap p-3 font-medium">
									{column.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y divide-border">
						{rows.map((row) => (
							<tr key={row.id} className={selected.includes(row.id) ? "bg-primary/5" : undefined}>
								<td className="p-3 align-top">
									<input
										type="checkbox"
										className="size-4 accent-primary"
										aria-label={"选择" + String(row.cells[table.columns[0]!.key])}
										checked={selected.includes(row.id)}
										onChange={() => toggleTableRow(tableId, row.id)}
									/>
								</td>
								{table.columns.map((column) => (
									<td key={column.key} className="min-w-24 max-w-80 whitespace-pre-wrap break-words p-3 align-top tabular-nums">
										{row.cells[column.key] === null ? "—" : String(row.cells[column.key])}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				{!rows.length ? (
					<div className="grid justify-items-start gap-2 p-4 text-sm text-muted-foreground">
						<p>没有符合搜索条件的数据。</p>
						{search ? (
							<Button type="button" size="sm" variant="ghost" onClick={() => setTableSearch(tableId, "")}>
								清除搜索
							</Button>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
