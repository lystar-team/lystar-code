import { useCallback, useState } from "react";
import type { ConversationListNode } from "./conversation-list-model";

/** 收起动画结束后才退出可见行，避免先移除正文再播放空动画。 */
export function useConversationGroupTransitions(sessionKey: string) {
	const [transition, setTransition] = useState({ sessionKey, retained: new Set<string>(), opened: new Set<string>() });
	if (transition.sessionKey !== sessionKey) setTransition({ sessionKey, retained: new Set(), opened: new Set() });
	const syncGroups = (nodes: ConversationListNode[]) => {
		if (transition.sessionKey !== sessionKey) return;
		const opened = new Set<string>();
		const present = new Set<string>();
		const collect = (groups: ConversationListNode[]) => {
			for (const group of groups) {
				if (group.entry) {
					present.add(group.key);
					if (group.open) opened.add(group.key);
				}
				if (group.children) collect(group.children);
			}
		};
		collect(nodes);
		if (opened.size === transition.opened.size && [...opened].every((key) => transition.opened.has(key))) return;
		const retained = new Set(transition.retained);
		for (const key of transition.opened) {
			if (present.has(key) && !opened.has(key)) retained.add(key);
		}
		for (const key of opened) retained.delete(key);
		setTransition({ sessionKey, retained, opened });
	};
	const changeGroup = useCallback((key: string, open: boolean) => {
		setTransition((current) => {
			const retained = new Set(current.retained);
			if (open) retained.delete(key);
			else retained.add(key);
			return { ...current, retained };
		});
	}, []);
	const finishCollapse = useCallback((key: string) => {
		setTransition((current) => {
			if (current.sessionKey !== sessionKey || !current.retained.has(key)) return current;
			const retained = new Set(current.retained);
			retained.delete(key);
			return { ...current, retained };
		});
	}, [sessionKey]);
	return { retainedGroups: transition.retained, changeGroup, finishCollapse, syncGroups };
}
