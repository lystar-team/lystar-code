import { existsSync, statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { WorkspaceDatabaseStorage, type WorkspaceWrite } from "./workspace-database-storage.ts";

const port = parentPort;
if (!port) throw new Error("工作区写线程缺少通信端口");
const { agentDir } = workerData as { agentDir: string };
const storage = new WorkspaceDatabaseStorage(agentDir);
storage.configureWriter();
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
let dirty = false;
// 检查点与 COMMIT 分开执行，避免跨过 WAL 阈值的那次提交承担整批回写。
const checkpointTimer = setInterval(() => {
	if (!dirty) return;
	dirty = false;
	const wal = `${storage.path}-wal`;
	if (!existsSync(wal) || statSync(wal).size < CHECKPOINT_BYTES) return;
	const startedAt = performance.now();
	try {
		const result = storage.checkpoint();
		port.postMessage({ type: "checkpoint", durationMs: performance.now() - startedAt, ...result });
	} catch (error) {
		port.postMessage({
			type: "checkpoint",
			durationMs: performance.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}, 1_000);
checkpointTimer.unref();

port.on("message", ({ id, write }: { id: number; write: WorkspaceWrite | "close" }) => {
	try {
		if (write === "close") {
			clearInterval(checkpointTimer);
			storage.close();
			port.postMessage({ id, result: { applied: true } });
			port.close();
			return;
		}
		const result = storage.commit(write);
		if (result.metrics?.changes) dirty = true;
		port.postMessage({ id, result });
	} catch (error) {
		port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
