import { createToolRecoveryLesson, hashToolRecoveryLessonScope } from "../../src/core/tool-recovery/lessons-store.ts";

const [agentDir, index] = process.argv.slice(2);
if (!agentDir || !index) throw new Error("usage: lessons-store-worker <agent-dir> <index>");

await createToolRecoveryLesson(agentDir, {
	scope: "project",
	scopeHash: hashToolRecoveryLessonScope(`project-${index}`),
	matcher: { toolName: "read", failureCode: "TARGET_NOT_FOUND", fingerprintPrefix: "a".repeat(16) },
	guidance: `确认父目录 ${index}。`,
	allowedAction: "guidance",
	evidence: { occurrences: 1, sessions: 1, recovered: 1, failed: 0 },
	expiresAt: "2030-01-01T00:00:00.000Z",
});
