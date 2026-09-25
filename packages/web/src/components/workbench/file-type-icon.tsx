import {
	FileCode2,
	FileJson,
	FileSpreadsheet,
	FileText,
	FileType2,
	ImageIcon,
	Presentation,
} from "lucide-react";

export function FileTypeIcon({ path }: { path: string }) {
	const fileName = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
	const extension = fileName.split(".").at(-1) ?? "";
	const Icon = ["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)
		? ImageIcon
		: ["csv", "ods", "tsv", "xls", "xlsx"].includes(extension)
			? FileSpreadsheet
			: ["odp", "pot", "pps", "ppt", "pptx"].includes(extension)
				? Presentation
				: ["doc", "docm", "docx", "odt", "rtf"].includes(extension)
					? FileType2
					: extension === "md" || extension === "mdx"
						? FileText
						: extension === "json"
							? FileJson
							: [
									"css",
									"go",
									"java",
									"js",
									"jsx",
									"py",
									"rs",
									"sql",
									"ts",
									"tsx",
									"vue",
									"yaml",
									"yml",
								].includes(extension)
								? FileCode2
								: FileText;
	return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}
