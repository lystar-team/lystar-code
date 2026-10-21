import { createContext, type ReactNode, useCallback, useMemo, useRef } from "react";
import { canSendPrompt } from "../../state/chat-lifecycle";
import type { WorkbenchState } from "../../state/use-workbench";
import type { WorkbenchActions } from "../workbench/types";

export const InteractiveUiActions = createContext<{
	sessionId?: string;
	available: boolean;
	continueDiscussion: (sessionId: string, text: string) => Promise<void>;
} | null>(null);

export function InteractiveUiActionProvider({
	state,
	sendMessage,
	children,
}: {
	state: WorkbenchState;
	sendMessage: WorkbenchActions["sendMessage"];
	children: ReactNode;
}) {
	const current = useRef(state);
	current.current = state;
	const continueDiscussion = useCallback(
		async (sessionId: string, text: string) => {
			const latest = current.current;
			if (latest.sessionId !== sessionId) throw new Error("请回到这份内容所属的会话再继续讨论");
			if (!canSendPrompt(latest) || latest.stoppingSessionIds[sessionId]) throw new Error("当前会话暂时不能发送消息");
			// 沿用已有 prompt → follow-up 转换，不把继续讨论变成 steer。
			await sendMessage(text, "prompt");
		},
		[sendMessage],
	);
	const value = useMemo(
		() => ({
			sessionId: state.sessionId,
			available: canSendPrompt(state) && !state.stoppingSessionIds[state.sessionId ?? ""],
			continueDiscussion,
		}),
		[
			state.sessionId,
			state.sessionReady,
			state.connected,
			state.readOnly,
			state.stoppingSessionIds,
			continueDiscussion,
		],
	);
	return <InteractiveUiActions.Provider value={value}>{children}</InteractiveUiActions.Provider>;
}
