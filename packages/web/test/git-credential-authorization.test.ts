import { describe, expect, it } from "vitest";
import {
	gitCredentialAuthorizationMessage,
	gitCredentialAuthorizationMessageFromSystemPermissions,
} from "../src/state/use-workbench.ts";

describe("Git keychain authorization prompt", () => {
	it("keeps the structured Gateway message for the Web dialog", () => {
		const error = Object.assign(new Error("请在本机终端执行 lc web permissions setup"), {
			code: "git_credentials_required",
		});
		expect(gitCredentialAuthorizationMessage(error)).toBe(error.message);
	});

	it("converts the background Helper marker into a user-facing prompt", () => {
		expect(
			gitCredentialAuthorizationMessage("LYSTAR_GIT_KEYCHAIN_AUTHORIZATION_REQUIRED: 远端 gitee.com 需要本机确认"),
		).toContain("lc web permissions setup");
	});

	it("opens the prompt when macOS reports that keychain authorization is required", () => {
		expect(
			gitCredentialAuthorizationMessageFromSystemPermissions({
				platform: "darwin",
				supported: true,
				permissions: [
					{
						id: "keychain",
						name: "用户钥匙串",
						state: "required",
						message: "更新已完成，需要在本机终端运行 lc web permissions setup",
						canRequest: true,
					},
				],
			}),
		).toContain("lc web permissions setup");
	});

	it("does not open the prompt when keychain authorization is already granted", () => {
		expect(
			gitCredentialAuthorizationMessageFromSystemPermissions({
				platform: "darwin",
				supported: true,
				permissions: [
					{
						id: "keychain",
						name: "用户钥匙串",
						state: "granted",
						message: "用户会话钥匙串已就绪",
						canRequest: true,
					},
				],
			}),
		).toBeUndefined();
	});

	it("ignores unrelated Git failures", () => {
		expect(gitCredentialAuthorizationMessage("fatal: repository not found")).toBeUndefined();
	});
});
