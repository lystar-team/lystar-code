import { createContext, useContext } from "react";
import type { InteractiveUiSnapshot } from "@lystar/code-web-protocol";
import type { InteractiveUiViewState } from "./state";

export const InteractiveUiData = createContext<{
	snapshot: InteractiveUiSnapshot;
	view: InteractiveUiViewState;
	setFilter: (filter: InteractiveUiViewState["filter"]) => void;
	toggle: (id: string) => void;
	setTableSearch: (id: string, search: string) => void;
	toggleTableRow: (tableId: string, rowId: string) => void;
	canContinue: boolean;
	pending: boolean;
	continueDiscussion: () => void;
} | null>(null);
export function useInteractiveUiData() {
	const data = useContext(InteractiveUiData);
	if (!data) throw new Error("交互组件缺少内容宿主");
	return data;
}
