import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettingsTab } from "../src/state/use-workbench.ts";
import { SettingsShortcuts } from "../src/components/workbench/settings-shortcuts.tsx";
import { WorkspaceNavigationRail } from "../src/components/workbench/workspace-navigation-rail.tsx";

describe("设置快捷入口", () => {
	it("桌面侧栏复用技能、智能体和模型与认证三个现有页面入口", () => {
		const markup = renderToStaticMarkup(
			<WorkspaceNavigationRail
				branding={{ name: "LYStar Code" }}
				mode="sessions"
				panelOpen
				onModeChange={() => {}}
				onPanelOpen={() => {}}
				expandButtonRef={null}
				actions={{ openSettings: async () => {}, signOut: () => {} }}
			/>,
		);
		expect(markup).toContain('aria-label="设置快捷入口"');
		expect(markup).toContain("技能</span>");
		expect(markup).toContain("智能体</span>");
		expect(markup).toContain("模型与认证</span>");
		expect(markup).toContain("设置</span>");
		expect(markup).toContain("退出</span>");
		expect(markup.match(/data-slot="button"/gu)).toHaveLength(7);
	});

	it("三个按钮跳转到对应的现有设置页", () => {
		const selectedTabs: SettingsTab[] = [];
		const shortcuts = SettingsShortcuts({
			openSettings: async (tab) => {
				if (tab) selectedTabs.push(tab);
			},
		});
		for (const button of Children.toArray(shortcuts.props.children)) {
			if (isValidElement<{ onClick: () => void }>(button)) button.props.onClick();
		}
		expect(selectedTabs).toEqual(["skills", "subagents", "models"]);
	});

	it("移动端快捷入口使用三列触控按钮，不改变项目与会话文字样式", () => {
		const markup = renderToStaticMarkup(<SettingsShortcuts openSettings={async () => {}} mobile />);
		expect(markup).toContain("grid-cols-3");
		expect(markup.match(/data-slot="button"/gu)).toHaveLength(3);
		expect(markup).toContain("h-11");
		expect(markup).not.toContain("project-list-item-label");
	});
});
