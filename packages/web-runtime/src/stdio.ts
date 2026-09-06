import type { WebRuntimeService } from "./service.ts";
import { runRuntimeStream } from "./stream-transport.ts";

export async function runStdioRuntime(service: WebRuntimeService): Promise<void> {
	await runRuntimeStream(service, process.stdin, process.stdout);
}
