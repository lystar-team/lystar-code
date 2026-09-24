import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionButton, truncateSessionTitle } from "../src/components/workbench/session-button";
import type { WebSessionSummary } from "../src/types.ts";

describe("会话标题展示", () => {
	it("40 个字符以内保持原文", () => {
		const title = "会".repeat(40);
		expect(truncateSessionTitle(title)).toBe(title);
	});

	it("超过 40 个字符时只保留前 40 个字符并追加省略号", () => {
		const title = "会".repeat(41);
		expect(truncateSessionTitle(title)).toBe(`${"会".repeat(40)}...`);
	});

	it("按 Unicode 字符截断，不拆分代理项", () => {
		const title = "🙂".repeat(41);
		expect(truncateSessionTitle(title)).toBe(`${"🙂".repeat(40)}...`);
	});

	it("组件使用 React memo 隔离未变化的会话行", () => {
		expect((SessionButton as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
	});

	it("智能体会话行显示智能体名称和图标身份", () => {
		const session: WebSessionSummary = {
			id: "session-agent",
			name: "检查项目代码",
			profileId: "code-review",
			profileName: "代码审阅",
			profileIcon: "code",
			createdAt: 1,
			updatedAt: 1,
			messageCount: 1,
			firstMessage: "检查项目代码",
			activity: "idle",
			writeAccess: "available",
		};
		const markup = renderToStaticMarkup(
			createElement(SessionButton, {
				projectName: "测试项目",
				session,
				active: false,
				running: false,
				unread: false,
				onClick: () => {},
				onRename: async () => {},
				onContextRename: () => {},
				onTogglePinned: () => {},
				onDelete: () => {},
				dragging: false,
				dropTarget: false,
				onDragStart: () => {},
				onDragOver: () => {},
				onDrop: () => {},
				onDragEnd: () => {},
			}),
		);

		expect(markup).toContain("代码审阅");
		expect(markup).toContain("检查项目代码");
		expect(markup).toContain("lucide-braces");
	});

	it("会话行提供独立的删除按钮", () => {
		const session: WebSessionSummary = {
			id: "session-1",
			name: "测试会话",
			createdAt: 1,
			updatedAt: 1,
			messageCount: 1,
			firstMessage: "测试会话",
			activity: "idle",
			writeAccess: "available",
		};
		const markup = renderToStaticMarkup(
			createElement(SessionButton, {
				projectName: "测试项目",
				session,
				active: false,
				running: false,
				unread: false,
				onClick: () => {},
				onRename: async () => {},
				onContextRename: () => {},
				onTogglePinned: () => {},
				onDelete: () => {},
				dragging: false,
				dropTarget: false,
				onDragStart: () => {},
				onDragOver: () => {},
				onDrop: () => {},
				onDragEnd: () => {},
			}),
		);

		expect(markup).toContain('aria-label="删除会话：测试会话"');
		expect(markup).toContain("group-hover/session:opacity-100");
	});
});
