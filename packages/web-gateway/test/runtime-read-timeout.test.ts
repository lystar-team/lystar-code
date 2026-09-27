import assert from "node:assert/strict";
import { test } from "node:test";
import { isIsolatedRuntimeRead } from "../src/runtime-client.ts";

test("Gateway 仅隔离无副作用的 Runtime 读取超时", () => {
	assert.equal(isIsolatedRuntimeRead({ command: "list_model_options" }), true);
	assert.equal(isIsolatedRuntimeRead({ command: "read_transcript", sessionPath: "/session", limit: 1 }), true);
	assert.equal(isIsolatedRuntimeRead({ command: "list_subagents", sessionPath: "/session" }), true);
	assert.equal(isIsolatedRuntimeRead({ command: "get_git_status", cwd: "/project" }), true);
	assert.equal(
		isIsolatedRuntimeRead({
			command: "room_read",
			cwd: "/project",
			roomId: "room",
			sessionId: "session",
			markRead: false,
		}),
		true,
	);
	assert.equal(
		isIsolatedRuntimeRead({ command: "room_read", cwd: "/project", roomId: "room", sessionId: "session" }),
		false,
	);
	assert.equal(isIsolatedRuntimeRead({ command: "get_snapshot" }), false);
	assert.equal(
		isIsolatedRuntimeRead({ command: "acquire_session", sessionPath: "/session", clientInstanceId: "client" }),
		false,
	);
	assert.equal(
		isIsolatedRuntimeRead({
			command: "reload_resources",
			sessionPath: "/session",
			leaseId: "lease",
			clientInstanceId: "client",
			clientRequestId: "request",
		}),
		false,
	);
	assert.equal(
		isIsolatedRuntimeRead({
			command: "room_task_claim",
			cwd: "/project",
			roomId: "room",
			taskId: "task",
			sessionId: "session",
		}),
		false,
	);
});
