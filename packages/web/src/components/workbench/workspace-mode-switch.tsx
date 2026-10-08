import { MessagesSquare, Users } from "lucide-react";
import { Tabs } from "../ui/tabs";
import { WorkbenchTabBar, type WorkbenchTabOption } from "./workbench-tab-bar";

export type WorkspaceMode = "sessions" | "rooms";

const WORKSPACE_MODE_TABS: readonly WorkbenchTabOption<WorkspaceMode>[] = [
	{ icon: MessagesSquare, label: "会话", value: "sessions" },
	{ icon: Users, label: "智能体协作", value: "rooms" },
];

export function WorkspaceModeSwitch({ mode, onChange }: { mode: WorkspaceMode; onChange: (mode: WorkspaceMode) => void }) {
	return (
		<Tabs value={mode} onValueChange={(value) => onChange(value as WorkspaceMode)} className="min-w-0 gap-0">
			<WorkbenchTabBar activeId={mode} tabs={WORKSPACE_MODE_TABS} label="工作区类型" />
		</Tabs>
	);
}
