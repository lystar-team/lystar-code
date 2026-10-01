import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationView, type ConversationActions, type ConversationState } from "../../src/components/workbench/conversation.tsx";
import { decorateTranscriptItems } from "../../src/state/transcript-state.ts";
import type { WebTranscriptItem } from "../../src/types.ts";
import "../../src/styles/tokens.css";
import "../../src/styles/prose.css";
import "../../src/styles.css";

const mode = new URLSearchParams(location.search).get("mode");
const toolMode = mode === "tools";
const flatMode = mode === "messages";

function page(start: number, count: number): WebTranscriptItem[] {
	return Array.from({ length: count }, (_, offset) => {
		const index = start + offset;
		const base = { parentId: index ? `review-${index - 1}` : null, timestamp: new Date(0).toISOString(), kind: "message", payload: null };
		return toolMode ? [
			{ ...base, entryId: `call-${index}`, view: { type: "tool_call" as const, calls: [{ id: `read-${index}`, name: "read", summary: `src/file-${index}.ts` }] } },
			{ ...base, entryId: `review-${index}`, view: { type: "tool_result" as const, callId: `read-${index}`, name: "read", status: "success" as const, summary: `src/file-${index}.ts`, detail: `文件 ${index} 的结果` } },
		] : [{ ...base, entryId: `review-${index}`, view: { type: "assistant" as const, text: `### 内容 ${index}\n\n这是步骤中的第 ${index} 段正文。\n\n检查标记 ${index}。` } }];
	}).flat();
}

function initial(): ConversationState {
	const step = { id: "review-step", title: "跨分页步骤", status: "running" as const, startedAt: Date.now(), toolCallIds: [], messageEntryIds: Array.from({ length: 100 }, (_, index) => `review-${index}`) };
	return {
		sessionId: toolMode ? "review-tools" : "review-step", loading: false, connected: true, sessionReady: true, readOnly: true,
		session: { activity: "running" }, transcript: decorateTranscriptItems(page(50, 50)),
		agentSteps: toolMode || flatMode ? {} : { [step.id]: step }, liveSteps: toolMode || flatMode ? {} : { [step.id]: step },
		transcriptPageLoaded: true, transcriptLoading: false, hasMorePrevious: false, loadingEarlier: false,
		pendingUserPrompts: [], queuedUserPrompts: [], promptSendTimes: {}, liveTools: {}, liveTurnItems: [], liveTurnId: 1,
	};
}

function ReviewConversation() {
	const [state, setState] = useState(initial);
	const [prepended, setPrepended] = useState(false);
	const prepend = async () => {
		if (prepended) return;
		setPrepended(true);
		setState((current) => ({ ...current, loadingEarlier: true }));
		await new Promise((resolve) => setTimeout(resolve, 80));
		setState((current) => ({ ...current, loadingEarlier: false, transcript: decorateTranscriptItems([...page(40, 10), ...current.transcript], current.transcript) }));
	};
	const actions: ConversationActions = { loadEarlier: prepend, openResource: async () => {}, queueAction: async () => {}, showToast: (message) => { throw new Error(message); } };
	return <main className="flex h-screen flex-col bg-background text-foreground">
		<div className="flex shrink-0 gap-4 border-b p-3">
			<button id="prepend" onClick={() => void prepend()} type="button">补入上一页</button>
			<button id="grow" onClick={() => setState((current) => ({ ...current, transcript: current.transcript.map((item, index) => index === 0 && item.view?.type === "assistant" ? { ...item, view: { ...item.view, text: `${item.view.text}\n\n${"异步增加正文。\n\n".repeat(30)}` } } : item) }))} type="button">上方内容增高</button>
			<button id="reset" onClick={() => { setState(initial()); setPrepended(false); }} type="button">重置</button>
			<span>{toolMode ? "工具组跨页" : flatMode ? "消息跨页" : "步骤内跨页"}</span>
		</div>
		<ConversationView state={state} actions={actions} sessionTitleText="对话复盘验证" onEditPrompt={() => {}} allowPromptEditing={false} />
	</main>;
}

createRoot(document.getElementById("root")!).render(<ReviewConversation />);
