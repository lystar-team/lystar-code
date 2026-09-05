import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WEB_GATEWAY_PORT, hostMatches } from "../src/config.ts";

test("Web Gateway 默认端口固定为 1422", () => {
	assert.equal(DEFAULT_WEB_GATEWAY_PORT, 1422);
});

test("Web Gateway Host 白名单支持通配符 *", () => {
	assert.equal(hostMatches("127.0.0.1", ["*"]), true);
	assert.equal(hostMatches("192.168.2.35", ["*"]), true);
	assert.equal(hostMatches("yean-debian-pc", ["*"]), true);
});
