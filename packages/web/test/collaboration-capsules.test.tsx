import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	collaborationAlias,
	collaborationStatus,
} from "../src/components/workbench/collaboration-session.tsx";
import { CollaborationCapsules } from "../src/components/workbench/collaboration-capsules.tsx";
import { Composer } from "../src/components/workbench/composer.tsx";
import type { WorkbenchActions } from "../src/components/workbench/types.ts";
import type { WorkbenchState } from "../src/state/use-workbench.ts";
import type { WebSessionSummary } from "../src/types.ts";

function session(input: Partial<WebSessionSummary> & Pick<WebSessionSummary, "id">): WebSessionSummary {
	return {
		createdAt: 1,
		updatedAt: 1,
		messageCount: 1,
		firstMessage: "检查任务",
		activity: "idle",
		writeAccess: "available",
		...input,
	};
}

describe("协作子会话胶囊", () => {
	it("协作子会话使用对话滚动条和小字号，状态只显示图标", () => {
		const children = (["running", "completed", "failed"] as const).map((activity) =>
			session({ id: activity, parentId: "root", relation: "collaboration", activity })
		);
		const root = session({ id: "root" });
		const html = renderToStaticMarkup(
			<CollaborationCapsules sessions={[root, ...children]} onOpenSession={() => {}} />,
		);

		expect(html).toContain('aria-label="协作子会话"');
		for (const child of children) {
			expect(html).toContain(`aria-label="打开协作子会话 ${collaborationAlias(child.id)}，${collaborationStatus(child)}"`);
		}
		expect(html).not.toMatch(/>(已完成|进行中|失败)</);
		expect(html).not.toContain(collaborationAlias(root.id));
	});

	it("没有协作子会话时不占用输入区空间", () => {
		const html = renderToStaticMarkup(<CollaborationCapsules sessions={[session({ id: "root" })]} onOpenSession={() => {}} />);

		expect(html).toBe("");
	});

	it("胶囊位于非 Room 输入框上方，Room 和原位编辑器不显示", () => {
		const state = {
			composerMode: "prompt", connected: true, currentProjectId: "project-1", hiddenModelProviders: [],
			liveTools: {}, liveTurnActive: false, modelOptions: [], modelOptionProviders: [], models: [], providers: [],
			queuedUserPrompts: [], subagents: [], readOnly: false, session: { id: "root" },
			sessionId: "root", sessionReady: true,
		} as WorkbenchState;
		const child = session({ id: "child", parentId: "root", relation: "collaboration", activity: "completed" });
		const props = {
			state, actions: {} as WorkbenchActions, collaborationSessions: [child],
			onCancelEdit: () => {}, onEditComplete: () => {},
		};
		const html = renderToStaticMarkup(<Composer {...props} />);

		expect(html.indexOf('aria-label="协作子会话"')).toBeGreaterThanOrEqual(0);
		expect(html.indexOf('aria-label="协作子会话"')).toBeLessThan(html.indexOf('aria-label="输入 Prompt"'));
		expect(renderToStaticMarkup(<Composer {...props} roomMode roomId="room-1" />)).not.toContain('aria-label="协作子会话"');
		expect(renderToStaticMarkup(<Composer {...props} inline />)).not.toContain('aria-label="协作子会话"');
	});
});
