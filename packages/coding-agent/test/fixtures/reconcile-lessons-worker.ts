import {
	hashToolRecoveryLessonScope,
	reconcileToolRecoveryLessons,
} from "../../src/core/tool-recovery/lessons-store.ts";

const [agentDir, sessionPath] = process.argv.slice(2);
if (!agentDir || !sessionPath) throw new Error("Expected agentDir and sessionPath");

const applied = await reconcileToolRecoveryLessons(agentDir, sessionPath, hashToolRecoveryLessonScope("project-a"), {
	source: "reconcile-worker",
	now: new Date("2026-08-15T00:00:00.000Z"),
});
console.log(JSON.stringify({ applied }));
