import { CircleCheck, List, Play } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs } from "../src/components/ui/tabs.tsx";
import { WorkbenchTabBar } from "../src/components/workbench/workbench-tab-bar.tsx";

describe("工作区状态标签", () => {
	it("复用审阅工作区轨道，显示三项图标、数量和选中态", () => {
		const markup = renderToStaticMarkup(
			<Tabs value="completed">
				<WorkbenchTabBar
					activeId="completed"
					label="会话状态"
					compact
					tabs={[
						{ icon: List, label: "全部", value: "all", count: 942 },
						{ icon: Play, label: "进行中", value: "running", count: 2 },
						{ icon: CircleCheck, label: "已完成", value: "completed", count: 901 },
					]}
				/>
			</Tabs>,
		);
		expect(markup).toContain('aria-label="会话状态"');
		expect(markup).toContain('aria-label="全部，942 个会话"');
		expect(markup).toContain('aria-label="已完成，901 个会话"');
		expect(markup).toContain('!px-0.5');
		expect(markup).toContain('!flex-auto');
		expect(markup).toContain('data-state="active"');
		expect(markup.match(/data-slot="tabs-trigger"/g)).toHaveLength(3);
		expect(markup.match(/data-slot="badge"/g)).toHaveLength(3);
		expect(markup.match(/class="lucide /g)).toHaveLength(3);
	});

	it("审阅工作区的标签不展示会话数量", () => {
		const markup = renderToStaticMarkup(
			<Tabs value="files">
				<WorkbenchTabBar activeId="files" label="审阅视图" tabs={[{ icon: List, label: "文件", value: "files" }]} />
			</Tabs>,
		);
		expect(markup).toContain('aria-label="文件"');
		expect(markup).not.toContain('data-slot="badge"');
		expect(markup).toContain('!px-1.5');
		expect(markup).toContain('!flex-1');
	});
});
