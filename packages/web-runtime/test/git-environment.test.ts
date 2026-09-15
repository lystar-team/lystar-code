import assert from "node:assert/strict";
import { test } from "node:test";
import { macosGitCredentialError, webGitArguments } from "../src/git-environment.ts";

test("macOS Git 命令显式复用 Keychain credential helper", () => {
	assert.deepEqual(webGitArguments("/tmp/project", ["pull", "--ff-only"], "darwin"), [
		"-C",
		"/tmp/project",
		"-c",
		"credential.helper=lystar",
		"pull",
		"--ff-only",
	]);
	assert.deepEqual(webGitArguments("/tmp/project", ["pull", "--ff-only"], "linux"), [
		"-C",
		"/tmp/project",
		"pull",
		"--ff-only",
	]);
});

test("macOS HTTPS 凭据缺失时返回本机初始化提示", () => {
	const error = macosGitCredentialError(
		"fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
		"darwin",
	);
	assert.equal(error?.code, "git_credentials_required");
	assert.match(error?.message ?? "", /credential\.helper osxkeychain/u);
	assert.equal(macosGitCredentialError("fatal: repository not found", "darwin"), undefined);
	assert.equal(
		macosGitCredentialError(
			"fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
			"linux",
		),
		undefined,
	);
});
