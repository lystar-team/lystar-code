import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/components/workbench/composer.tsx";
import { buildConversationRenderItems, buildPersistedRenderItems } from "../src/components/workbench/conversation-render-model.ts";
import { TranscriptMessageView } from "../src/components/workbench/transcript-message.tsx";
import type { WorkbenchActions } from "../src/components/workbench/types.ts";
import type { WorkbenchState } from "../src/state/use-workbench.ts";

const image = { id: "image-1", filename: "截图.png", mediaType: "image/png", url: "" };

describe("原位编辑 Prompt", () => {
	it("停止后，纯图片的已发送消息保留编辑入口", () => {
		const persisted = buildPersistedRenderItems(
			[{
				entryId: "user-image",
				parentId: null,
				timestamp: "2026-09-28T00:00:00.000Z",
				kind: "message",
				view: { type: "user", text: "", images: [{ contentRef: image.id, mimeType: image.mediaType, byteLength: 4 }] },
			}],
			{ callIds: new Set(), results: new Map(), statuses: new Map() },
		);
		const idle = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false, true);
		const editing = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, false, true, {}, undefined, "user-image");
		const running = buildConversationRenderItems(persisted, [], {}, new Set(), undefined, 1, true, false, {}, undefined, "user-image");

		expect(idle[0]).toMatchObject({ kind: "message", entryId: "user-image", editable: true, editing: false });
		expect(editing[0]).toMatchObject({ kind: "message", editable: true, editing: true });
		expect(running[0]).toMatchObject({ kind: "message", editable: false, editing: false });
		const html = renderToStaticMarkup(createElement(TranscriptMessageView, {
			role: "user", text: "", attachments: [image], showCopy: false, onOpenPath: async () => {}, onEdit: () => {},
		}));
		expect(html).toContain("编辑 Prompt");
		expect(html).not.toContain("复制</span>");
	});

	it("原位编辑器恢复消息内容，并保留独立的取消与发送操作", () => {
		const state = {
			composerMode: "prompt", connected: true, currentProjectId: "project-1", hiddenModelProviders: [],
			liveTools: {}, liveTurnActive: false, modelOptions: [], modelOptionProviders: [], models: [], providers: [],
			queuedUserPrompts: [], subagents: [], readOnly: false, session: { id: "session-1" },
			sessionId: "session-1", sessionReady: true,
		} as WorkbenchState;
		const request = { sessionId: "session-1", entryId: "user-1", text: "修改前的 Prompt", attachments: [] };
		const html = renderToStaticMarkup(createElement(Composer, {
			state, actions: {} as WorkbenchActions, editRequest: request, inline: true,
			onCancelEdit: () => {}, onEditComplete: () => {},
		}));

		expect(html).toContain("修改前的 Prompt");
		expect(html).toContain('aria-label="编辑 Prompt"');
		expect(html).toContain("取消");
		expect(html).toContain("发送");
		expect(html).toContain('data-size="sm"');
		expect(html).toContain("text-muted-foreground");
		expect(html).not.toContain("选择模型");
	});

	it("编辑历史 Prompt 时禁用底部输入框", () => {
		const state = {
			composerMode: "prompt", connected: true, currentProjectId: "project-1", hiddenModelProviders: [],
			liveTools: {}, liveTurnActive: false, modelOptions: [], modelOptionProviders: [], models: [], providers: [],
			queuedUserPrompts: [], subagents: [], readOnly: false, session: { id: "session-1" },
			sessionId: "session-1", sessionReady: true,
		} as WorkbenchState;
		const html = renderToStaticMarkup(createElement(Composer, {
			state, actions: {} as WorkbenchActions, disabled: true,
			onCancelEdit: () => {}, onEditComplete: () => {},
		}));

		expect(html).toContain("请先完成当前 Prompt 编辑");
		expect(html).toContain('aria-label="输入 Prompt"');
		expect(html).toContain("disabled");
	});
});
