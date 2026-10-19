import type { ServerResponse } from "node:http";
import type { Command, RuntimeProtocolClient, TranscriptPage } from "@lystar/code-web-protocol";

/** HTTP 响应中断只取消对应历史请求，其他请求继续复用 Runtime 连接。 */
export async function readTranscriptForResponse(
	client: RuntimeProtocolClient,
	response: ServerResponse,
	request: Extract<Command, { command: "read_transcript" }>,
): Promise<TranscriptPage> {
	const controller = new AbortController();
	const onClose = () => {
		if (!response.writableFinished) controller.abort();
	};
	response.once("close", onClose);
	if (response.destroyed) controller.abort();
	try {
		return await client.request<TranscriptPage>(request, { signal: controller.signal });
	} finally {
		response.off("close", onClose);
	}
}
