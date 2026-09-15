import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearMacosGitCredentialAuthorization,
	MACOS_GIT_KEYCHAIN_AUTHORIZATION_MARKER,
	macosGitCredentialError,
	makeMacosGitCredentialWrapper,
	readMacosGitCredentialAuthorization,
	webGitArguments,
	writeMacosGitCredentialAuthorization,
} from "../src/git-environment.ts";

test("macOS Git 命令清空用户 Helper 链后使用受控 Keychain Helper", () => {
	assert.deepEqual(webGitArguments("/tmp/project", ["pull", "--ff-only"], "darwin"), [
		"-C",
		"/tmp/project",
		"-c",
		"credential.helper=",
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

test("macOS HTTPS 凭据缺失时返回本机授权提示", () => {
	const error = macosGitCredentialError(
		"fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
		"darwin",
	);
	assert.equal(error?.code, "git_credentials_required");
	assert.match(error?.message ?? "", /lc web permissions setup/u);
	assert.equal(macosGitCredentialError("fatal: repository not found", "darwin"), undefined);
	assert.equal(
		macosGitCredentialError(
			"fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
			"linux",
		),
		undefined,
	);
});

test("macOS Git 钥匙串授权固定 Helper 身份和 HTTPS 域名", () => {
	const directory = mkdtempSync(join(tmpdir(), "lystar-git-keychain-"));
	const helperPath = join(directory, "git-credential-osxkeychain");
	writeFileSync(helperPath, "helper-v1\n");
	chmodSync(helperPath, 0o700);
	try {
		writeMacosGitCredentialAuthorization(directory, helperPath, ["Gitee.com", "github.com", "gitee.com"]);
		assert.deepEqual(readMacosGitCredentialAuthorization(directory), {
			configured: true,
			valid: true,
			helperPath,
			hosts: ["gitee.com", "github.com"],
		});

		writeFileSync(helperPath, "helper-v2\n");
		assert.equal(readMacosGitCredentialAuthorization(directory).reason, "helper_changed");

		const wrapper = makeMacosGitCredentialWrapper(directory);
		assert.match(wrapper, new RegExp(MACOS_GIT_KEYCHAIN_AUTHORIZATION_MARKER, "u"));
		assert.match(wrapper, /grep -Fqx/u);
		assert.match(wrapper, /sleep 8/u);
		assert.equal(
			readFileSync(join(directory, "web", "git-keychain-authorization.hosts"), "utf8"),
			"gitee.com\ngithub.com\n",
		);
	} finally {
		clearMacosGitCredentialAuthorization(directory);
		rmSync(directory, { recursive: true, force: true });
	}
});
