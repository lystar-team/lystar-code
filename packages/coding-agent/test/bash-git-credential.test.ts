import { afterEach, describe, expect, it } from "vitest";
import { macosWebGitCredentialFailure } from "../src/core/tools/bash.ts";

const originalPlatform = process.platform;

afterEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
});

describe("macOS Web Bash Git credential failures", () => {
	it("marks Git HTTPS credential prompts so the Web client can open the authorization dialog", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		expect(
			macosWebGitCredentialFailure(
				"fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
				{ LYSTAR_WEB_SERVICE_CHILD: "1" },
			),
		).toContain("LYSTAR_GIT_KEYCHAIN_AUTHORIZATION_REQUIRED");
	});

	it("ignores unrelated authentication failures and foreground commands", () => {
		Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
		expect(
			macosWebGitCredentialFailure("API authentication failed", { LYSTAR_WEB_SERVICE_CHILD: "1" }),
		).toBeUndefined();
		expect(
			macosWebGitCredentialFailure("fatal: Authentication failed for 'https://gitee.com/repo.git'", {}),
		).toBeUndefined();
	});
});
