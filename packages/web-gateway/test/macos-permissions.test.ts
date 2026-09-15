import assert from "node:assert/strict";
import { test } from "node:test";
import { getMacosPermissionsStatus, requestMacosPermission } from "../src/macos-permissions.ts";

test("非 macOS 不暴露系统授权项目", () => {
	const originalPlatform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
	try {
		assert.deepEqual(getMacosPermissionsStatus("/tmp/lystar-agent"), {
			platform: "linux",
			supported: false,
			permissions: [],
		});
		assert.throws(() => requestMacosPermission("accessibility", "/tmp/lystar-agent"), /只适用于 macOS/u);
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
	}
});
