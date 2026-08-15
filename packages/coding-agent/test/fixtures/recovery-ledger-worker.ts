import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendSessionRecoveryLedger, createRecoveryLedgerEntry } from "../../src/core/tool-recovery/ledger.ts";

const [agentDir, sessionPath, id] = process.argv.slice(2);
if (!agentDir || !sessionPath || !id) throw new Error("Expected agentDir, sessionPath, and entry id");
mkdirSync(dirname(sessionPath), { recursive: true });
writeFileSync(sessionPath, "{}\n", { flag: "a" });

await appendSessionRecoveryLedger(
	agentDir,
	sessionPath,
	createRecoveryLedgerEntry({
		sessionId: "worker-session",
		turnId: "0",
		toolCallId: `worker-${id}`,
		toolName: "read",
		callSignature: "a".repeat(64),
		failureFingerprint: "b".repeat(64),
		failureCode: "PERMISSION_DENIED",
		attempt: 1,
		action: "observe",
		outcome: "failed",
		durationMs: 1,
		createdAt: "2026-08-15T00:00:00.000Z",
	}),
);
