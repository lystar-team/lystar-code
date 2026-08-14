import type { GuiHostService } from "./service.ts";
import { runHostStream } from "./stream-transport.ts";

export async function runStdioHost(service: GuiHostService): Promise<void> {
	await runHostStream(service, process.stdin, process.stdout);
}
