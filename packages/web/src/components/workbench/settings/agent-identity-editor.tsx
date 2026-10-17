import { UploadCloud, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import { AgentIdentityIcon, AGENT_ICON_OPTIONS } from "../collaboration-session";

function svgDataUrl(svg: string): string {
	const document = new DOMParser().parseFromString(svg, "image/svg+xml");
	if (document.querySelector("parsererror")) throw new Error("SVG 文件格式无效");
	document.querySelectorAll("script, foreignObject").forEach((element) => element.remove());
	for (const element of document.querySelectorAll("*")) {
		for (const attribute of [...element.attributes]) {
			if (
				/^on/u.test(attribute.name) ||
				((attribute.name === "href" || attribute.name.endsWith(":href")) && /^https?:/u.test(attribute.value))
			)
				element.removeAttribute(attribute.name);
		}
	}
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(document.documentElement))}`;
}

export function AgentIconPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string>();
	const upload = (file: File | undefined) => {
		if (!file) return;
		if (file.type !== "image/svg+xml" && !file.name.toLowerCase().endsWith(".svg")) {
			setError("只支持 SVG 图标");
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const icon = svgDataUrl(String(reader.result ?? ""));
				if (icon.length > 4096) throw new Error("SVG 文件过大，请压缩后再上传");
				onChange(icon);
				setError(undefined);
				setOpen(false);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : "SVG 图标读取失败");
			}
		};
		reader.readAsText(file);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					aria-label="选择智能体图标"
					className="grid size-11 shrink-0 place-items-center rounded-lg border border-input bg-background hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					type="button"
				>
					<AgentIdentityIcon iconKey={value} className="size-6 object-contain" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-3">
				<div className="grid gap-3">
					<span className="text-xs font-medium text-muted-foreground">选择图标</span>
					<TooltipProvider delayDuration={180}>
						<div className="grid max-h-64 grid-cols-7 gap-1 overflow-y-auto pr-1">
							{AGENT_ICON_OPTIONS.map(({ value: icon, label, icon: Icon }) => (
								<Tooltip key={icon}>
									<TooltipTrigger asChild>
										<button
											aria-label={label}
											aria-pressed={value === icon}
											className={cn(
												"grid size-9 place-items-center rounded-md border text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
												value === icon && "border-foreground bg-muted text-foreground",
											)}
											onClick={() => {
												onChange(icon);
												setOpen(false);
											}}
											type="button"
										>
											<Icon className="size-4" aria-hidden />
										</button>
									</TooltipTrigger>
									<TooltipContent>{label}</TooltipContent>
								</Tooltip>
							))}
						</div>
					</TooltipProvider>
					<label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-muted focus-within:ring-2 focus-within:ring-ring">
						<UploadCloud className="size-4" aria-hidden />
						上传 SVG
						<input
							accept="image/svg+xml,.svg"
							className="sr-only"
							type="file"
							onChange={(event) => {
								upload(event.target.files?.[0]);
								event.currentTarget.value = "";
							}}
						/>
					</label>
					{error ? (
						<span className="text-xs text-destructive" role="alert">
							{error}
						</span>
					) : null}
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function AgentTagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
	const [input, setInput] = useState("");
	return (
		<div className="grid min-w-0 gap-2 text-sm font-medium">
			<span>擅长标签</span>
			<div className="flex min-h-10 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
				{tags.map((tag) => (
					<span className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 text-xs" key={tag}>
						<span className="max-w-48 truncate" title={tag}>
							{tag}
						</span>
						<button
							aria-label={`移除标签 ${tag}`}
							className="grid size-7 shrink-0 place-items-center rounded-sm hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => onChange(tags.filter((candidate) => candidate !== tag))}
							type="button"
						>
							<X className="size-3" aria-hidden />
						</button>
					</span>
				))}
				<input
					aria-label="添加擅长标签"
					className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
					placeholder={tags.length ? "继续添加标签" : "输入标签后按 Enter"}
					value={input}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (["Enter", ",", "，"].includes(event.key)) {
							event.preventDefault();
							const added = input
								.split(/[,，、\n]/u)
								.map((tag) => tag.trim())
								.filter(Boolean);
							if (added.length) {
								onChange([...new Set([...tags, ...added])].slice(0, 12));
								setInput("");
							}
						}
						if (event.key === "Backspace" && !input && tags.length) onChange(tags.slice(0, -1));
					}}
				/>
			</div>
		</div>
	);
}
