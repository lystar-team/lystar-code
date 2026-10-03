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

	it("智能体会话与普通会话对齐，长名称省略且智能体胶囊靠右", () => {
		const longTitle = "检查项目代码并确认会话列表布局".repeat(8);
		const session: WebSessionSummary = {
			id: "session-agent",
			name: longTitle,
			profileId: "code-review",
			profileName: "代码审阅",
			profileIcon: "code",
			createdAt: 1,
			updatedAt: 1,
			messageCount: 1,
			firstMessage: longTitle,
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

		expect(markup.indexOf(truncateSessionTitle(longTitle))).toBeLessThan(markup.indexOf("代码审阅"));
	});

	it("有智能体子会话的父会话输出折叠状态", () => {
		const session: WebSessionSummary = {
			id: "session-parent",
			name: "父会话",
			createdAt: 1,
			updatedAt: 1,
			messageCount: 1,
			firstMessage: "父会话",
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
				hasChildren: true,
				childrenExpanded: false,
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

		expect(markup).toContain('aria-expanded="false"');
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
	});

	it("置顶会话的悬浮按钮显示取消置顶，不显示删除", () => {
		const session: WebSessionSummary = {
			id: "session-1",
			name: "测试会话",
			pinned: true,
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

		expect(markup).toContain('aria-label="取消置顶会话"');
		expect(markup).not.toContain('aria-label="删除会话：测试会话"');
	});
});
