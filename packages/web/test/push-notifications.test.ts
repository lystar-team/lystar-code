import { describe, expect, it } from "vitest";
import { pushErrorMessage } from "../src/state/use-push-notifications.ts";

describe("浏览器推送错误", () => {
	it("推送服务注册失败时说明权限已允许，提示安卓设备检查推送服务", () => {
		const message = pushErrorMessage(new Error("Registration failed - push service error"));
		expect(message).toContain("通知权限已允许");
		expect(message).toContain("Google Play 服务和网络连接");
		expect(message).toContain("还不能接收后台通知");
	});

	it("其他错误保留原有消息", () => {
		expect(pushErrorMessage(new Error("请求失败（503）"))).toBe("请求失败（503）");
	});
});
