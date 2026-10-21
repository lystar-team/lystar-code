import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent/core";
import {
	type InteractiveUiRow,
	type InteractiveUiSnapshot,
	serializeInteractiveUiSnapshot,
} from "@lystar/code-web-protocol";
import { Type } from "typebox";
import { createInteractiveUiPresentationTools } from "./interactive-ui-tool.ts";

export const PROJECT_INSPECTION_PROGRAM = `root = Stack([Text("检查结果来自本机执行。筛选和勾选只改变当前视图，不修改项目。"), StatusSummary(), ResultsTable(), Continue("继续讨论所选项目")])`;

export function createInteractiveUiTools(
	exec: (
		command: string,
		args: string[],
		options: { cwd: string; signal?: AbortSignal },
	) => Promise<{ code: number; stdout: string; stderr: string }>,
) {
	return [
		...createInteractiveUiPresentationTools(),
		defineTool({
			name: "inspect_project_ui",
			label: "交互式项目检查",
			description:
				"OpenUI 接入验证：读取当前项目配置、检查锁文件和 Git 差异格式，可选运行 Web 类型检查；通过执行事件连续展示真实结果，不写项目文件。",
			parameters: Type.Object({
				checkTypes: Type.Optional(Type.Boolean({ description: "同时运行现有 Web 类型检查，默认不运行" })),
			}),
			executionMode: "sequential",
			async execute(_id, params, signal, onUpdate, ctx) {
				const rows: InteractiveUiRow[] = [
					{ id: "manifest", label: "项目配置", state: "pending", detail: "等待读取 package.json" },
					{ id: "lockfile", label: "依赖锁文件", state: "pending", detail: "等待读取 package-lock.json" },
					{ id: "diff", label: "差异格式", state: "pending", detail: "等待运行 git diff --check" },
					...(params.checkTypes
						? [{ id: "types", label: "Web 类型检查", state: "pending" as const, detail: "等待运行现有检查命令" }]
						: []),
				];
				let revision = 0;
				const publish = () => {
					const snapshot: InteractiveUiSnapshot = {
						kind: "lystar.interactive-ui",
						version: 1,
						revision: ++revision,
						title: "项目检查",
						program: PROJECT_INSPECTION_PROGRAM,
						updatedAt: new Date().toISOString(),
						rows: rows.map((row) => ({ ...row })),
						source: { kind: "tool", label: ctx.cwd },
					};
					return {
						content: [{ type: "text" as const, text: serializeInteractiveUiSnapshot(snapshot) }],
						details: snapshot,
					};
				};
				for (const row of rows) {
					signal?.throwIfAborted();
					row.state = "running";
					onUpdate?.(publish());
					try {
						if (row.id === "manifest") {
							const manifest: unknown = JSON.parse(await readFile(join(ctx.cwd, "package.json"), "utf8"));
							if (
								!manifest ||
								typeof manifest !== "object" ||
								!("name" in manifest) ||
								typeof manifest.name !== "string"
							)
								throw new Error("package.json 缺少项目名称");
							row.detail = manifest.name;
						} else if (row.id === "lockfile") {
							const lock: unknown = JSON.parse(await readFile(join(ctx.cwd, "package-lock.json"), "utf8"));
							if (
								!lock ||
								typeof lock !== "object" ||
								!("packages" in lock) ||
								!lock.packages ||
								typeof lock.packages !== "object"
							)
								throw new Error("锁文件缺少 packages");
							row.detail = `已读取 ${Object.keys(lock.packages).length} 个依赖条目；未执行安装`;
						} else {
							const command = row.id === "diff" ? "git" : "npm";
							const args =
								row.id === "diff" ? ["diff", "--check"] : ["run", "check", "--workspace=@lystar/code-web"];
							const result = await exec(command, args, { cwd: ctx.cwd, signal });
							if (result.code !== 0)
								throw new Error(
									`${command} ${args.join(" ")} 退出码 ${result.code}\n${result.stdout}\n${result.stderr}`.slice(
										0,
										2048,
									),
								);
							row.detail = row.id === "diff" ? "git diff --check · 退出码 0" : "Web TypeScript · 退出码 0";
						}
						row.state = "passed";
					} catch (error) {
						signal?.throwIfAborted();
						row.state = "failed";
						row.detail = error instanceof Error ? error.message : String(error);
					}
					onUpdate?.(publish());
				}
				return publish();
			},
		}),
	];
}
