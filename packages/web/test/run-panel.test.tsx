import { describe, expect, it } from "vitest";
import type { WebOperation } from "../src/types.ts";
import { operationDetails, operationTaskDisplay } from "../src/components/workbench/run-panel.tsx";

function operation(type: string, extra: Partial<WebOperation> = {}): WebOperation {
	return {
		operationId: `${type}-operation`,
		clientInstanceId: "client",
		clientRequestId: `${type}-request`,
		type,
		status: "completed",
		acceptedAt: 1,
		updatedAt: 2,
		payloadHash: "hash",
		...extra,
	} as WebOperation;
}

describe("审阅工作区任务文案", () => {
	it("把命令任务显示为实际执行命令", () => {
		expect(
			operationTaskDisplay(
				operation("run_bash", {
					progress: { type: "bash", command: "git status --short" },
				}),
			).detail,
		).toBe("命令：git status --short");
	});

	it("把提交内容显示在实时任务摘要中", () => {
		expect(
			operationTaskDisplay(
				operation("prompt", {
					progress: { type: "message", text: "请检查登录流程" },
				}),
			).detail,
		).toBe("提交内容：请检查登录流程");
	});
	it("把思考强度操作显示为具体级别", () => {
		expect(
			operationTaskDisplay(
				operation("set_session_thinking", {
					result: { snapshot: { thinkingLevel: "xhigh" } },
				}),
			).detail,
		).toContain("极高(XHigh)");
	});

	it("把提交内容转成可读的任务明细", () => {
		const details = operationDetails(
			operation("prompt", {
				progress: { type: "message", text: "请检查登录流程", imageCount: 1 },
			}),
		);
		expect(details).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "提交内容", value: "请检查登录流程", multiline: true }),
				expect.objectContaining({ label: "图片附件", value: "1 张" }),
			]),
		);
	});
	it("未知操作显示真实操作类型", () => {
		expect(operationTaskDisplay(operation("refresh_workspace_cache")).detail).toBe("操作类型：refresh_workspace_cache");
	});
});
