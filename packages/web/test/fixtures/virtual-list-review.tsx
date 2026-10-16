import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageResponse } from "../../src/components/ai-elements/message.tsx";
import { RunPanel } from "../../src/components/workbench/run-panel.tsx";
import type { WorkbenchActions } from "../../src/components/workbench/types.ts";
import { VirtualizedSessionList } from "../../src/components/workbench/virtualized-session-list.tsx";
import { initialState } from "../../src/state/workbench-state.ts";
import type { WebOperation } from "../../src/types.ts";
import "../../src/styles/tokens.css";
import "../../src/styles/prose.css";
import "../../src/styles.css";

const mode = new URLSearchParams(location.search).get("mode") ?? "sessions";
const sessions = Array.from({ length: 5000 }, (_, index) => "会话-" + index);
const operations: WebOperation[] = Array.from({ length: 5000 }, (_, index) => ({
	operationId: "operation-" + index, sessionId: "review", clientInstanceId: "review", clientRequestId: "request-" + index,
	type: "run_bash", status: "completed", acceptedAt: index, updatedAt: index, payloadHash: "review",
	progress: { type: "bash", command: "检查记录 " + index },
}));
const state = { ...initialState(), sessionId: "review", readOnly: true, operations };
const actions = { compact: async () => {}, exportSession: async () => {} } as WorkbenchActions;
const markdown = Array.from({ length: 700 }, (_, index) => "## 段落-" + index + "\n\n" + "用于核对长正文滚动位置和窄屏换行。".repeat(12)).join("\n\n");

function ReviewList() {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [request, setRequest] = useState(0);
	const [tall, setTall] = useState(false);
	const [extra, setExtra] = useState(false);
	return <main className="flex h-screen flex-col bg-background text-foreground">
		<div className="flex shrink-0 gap-4 border-b p-3">
			<button id="locate" type="button" onClick={() => setRequest((value) => value + 1)}>定位会话 4000</button>
			<button id="header" type="button" onClick={() => setTall((value) => !value)}>切换标题高度</button>
			<button id="extra" type="button" onClick={() => setExtra((value) => !value)}>切换第二个列表</button>
		</div>
		{mode === "markdown" ? <div className="is-assistant min-h-0 flex-1"><MessageResponse mode="static" virtualize>{markdown}</MessageResponse></div> :
			<div ref={scrollRef} id="scroll" className="min-h-0 flex-1 overflow-auto">
				<div style={{ height: tall ? 216 : 96 }}>列表上方内容</div>
				{mode === "run" ? <RunPanel state={state} actions={actions} scrollRef={scrollRef} /> :
					<VirtualizedSessionList items={sessions} getKey={(item) => item} scrollRef={scrollRef}
						scrollToKey={request ? "会话-4000" : undefined} scrollRequestId={request}
						renderItem={(item) => <button className="h-8 w-full text-left" type="button">{item}</button>} />}
				{extra ? <VirtualizedSessionList items={sessions.slice(0, 5)} getKey={(item) => item} scrollRef={scrollRef}
					renderItem={(item) => <div className="h-8">{item}</div>} /> : null}
			</div>}
	</main>;
}

createRoot(document.getElementById("root")!).render(<ReviewList />);
