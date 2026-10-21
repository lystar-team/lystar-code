import { createLibrary, defineComponent, useRenderNode, useStateField } from "@openuidev/react-lang";
import { interactiveUiDefinitions } from "@lystar/code-web-protocol/interactive-ui-library";
import { InteractiveUiDataTable } from "./data-table";
import { useInteractiveUiData } from "./context";
import { CheckCircle2, Circle, LoaderCircle, XCircle } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const Stack = defineComponent({
	...interactiveUiDefinitions.Stack,
	component: function StackView({ props }) {
		const renderNode = useRenderNode();
		return <div className="grid min-w-0 gap-5">{renderNode(props.children)}</div>;
	},
});
const Text = defineComponent({
	...interactiveUiDefinitions.Text,
	component: ({ props }) => <p className="text-sm leading-6 text-muted-foreground">{props.text}</p>,
});
const StatusSummary = defineComponent({
	...interactiveUiDefinitions.StatusSummary,
	component: function SummaryView() {
		const { snapshot } = useInteractiveUiData();
		const passed = snapshot.rows.filter((row) => row.state === "passed").length;
		const failed = snapshot.rows.filter((row) => row.state === "failed").length;
		const finished = passed + failed;
		return (
			<div className="grid grid-cols-3 divide-x divide-border border-y border-border py-4" aria-label="检查统计">
				{[
					["已检查", `${finished} / ${snapshot.rows.length}`],
					["通过", passed],
					["未通过", failed],
				].map(([label, value]) => (
					<div key={label} className="px-3 first:pl-0">
						<div className="text-xs text-muted-foreground">{label}</div>
						<div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
					</div>
				))}
			</div>
		);
	},
});
const labels = { pending: "待检查", running: "检查中", passed: "通过", failed: "未通过" } as const;
const icons = { pending: Circle, running: LoaderCircle, passed: CheckCircle2, failed: XCircle };
const ResultsTable = defineComponent({
	...interactiveUiDefinitions.ResultsTable,
	component: function ResultsView() {
		const { snapshot, view, setFilter, toggle } = useInteractiveUiData();
		const rows = snapshot.rows.filter((row) => view.filter === "all" || row.state === view.filter);
		return (
			<div className="grid min-w-0 gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex gap-1" role="group" aria-label="筛选检查结果">
						{(
							[
								["all", "全部"],
								["failed", "未通过"],
								["passed", "通过"],
							] as const
						).map(([filter, label]) => (
							<Button
								key={filter}
								type="button"
								size="sm"
								variant={view.filter === filter ? "secondary" : "ghost"}
								aria-pressed={view.filter === filter}
								onClick={() => setFilter(filter)}
							>
								{label}
							</Button>
						))}
					</div>
					<span className="text-xs tabular-nums text-muted-foreground">
						显示 {rows.length} 项 · 已选{" "}
						{view.selected.filter((id) => snapshot.rows.some((row) => row.id === id)).length} 项
					</span>
				</div>
				<div className="min-w-0 overflow-x-auto rounded-lg border border-border">
					<table className="w-full text-left text-sm">
						<thead className="bg-muted/40 text-xs text-muted-foreground">
							<tr>
								<th className="w-10 p-3">
									<span className="sr-only">选择</span>
								</th>
								<th className="p-3 font-medium">检查项</th>
								<th className="p-3 font-medium">状态</th>
								<th className="p-3 font-medium">结果依据</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{rows.map((row) => {
								const Icon = icons[row.state];
								return (
									<tr key={row.id} className={view.selected.includes(row.id) ? "bg-primary/5" : undefined}>
										<td className="p-3 align-top">
											<input
												type="checkbox"
												className="size-4 accent-primary"
												aria-label={`选择${row.label}`}
												checked={view.selected.includes(row.id)}
												onChange={() => toggle(row.id)}
											/>
										</td>
										<th scope="row" className="min-w-24 p-3 align-top font-medium">
											{row.label}
										</th>
										<td className="p-3 align-top">
											<span
												className={`flex items-center gap-1.5 whitespace-nowrap text-xs ${row.state === "failed" ? "text-destructive" : row.state === "passed" ? "text-[var(--success)]" : "text-muted-foreground"}`}
											>
												<Icon
													aria-hidden="true"
													className={`size-3.5 ${row.state === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}
												/>
												{labels[row.state]}
											</span>
										</td>
										<td className="min-w-40 max-w-80 whitespace-pre-wrap break-words p-3 align-top text-xs leading-5 text-muted-foreground">
											{row.detail}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					{!rows.length ? <p className="p-5 text-sm text-muted-foreground">没有符合当前筛选条件的检查项。</p> : null}
				</div>
			</div>
		);
	},
});
const Continue = defineComponent({
	...interactiveUiDefinitions.Continue,
	component: function ContinueView({ props }) {
		const { canContinue, pending, continueDiscussion } = useInteractiveUiData();
		return (
			<div className="flex flex-wrap items-center gap-3">
				<Button type="button" disabled={!canContinue || pending} onClick={continueDiscussion}>
					{pending ? "正在提交…" : props.label}
				</Button>
				<span className="text-xs text-muted-foreground">发送当前参数和选择，不直接修改项目</span>
			</div>
		);
	},
});
const NumberInput = defineComponent({
	...interactiveUiDefinitions.NumberInput,
	component: function NumberInputView({ props, statementId }) {
		const field = useStateField(statementId ?? props.label, props.value);
		return (
			<label className="grid gap-2 text-sm">
				{props.label}
				<Input
					type="number"
					className="max-w-52"
					value={field.value ?? ""}
					onChange={(event) => {
						const number = event.currentTarget.valueAsNumber;
						if (Number.isFinite(number)) field.setValue(number);
					}}
				/>
			</label>
		);
	},
});
const Value = defineComponent({
	...interactiveUiDefinitions.Value,
	component: ({ props }) => (
		<div>
			<div className="text-xs text-muted-foreground">{props.label}</div>
			<output className="mt-1 block text-2xl font-semibold tabular-nums">{props.value}</output>
		</div>
	),
});

const DataTable = defineComponent({
	...interactiveUiDefinitions.DataTable,
	component: ({ props }) => <InteractiveUiDataTable tableId={props.tableId} />,
});
export const interactiveUiLibrary = createLibrary({
	root: "Stack",
	components: [Stack, Text, StatusSummary, ResultsTable, DataTable, Continue, NumberInput, Value],
});
