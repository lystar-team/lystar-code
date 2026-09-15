export function webGitArguments(
	cwd: string,
	args: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string[] {
	return ["-C", cwd, ...(platform === "darwin" ? ["-c", "credential.helper=lystar"] : []), ...args];
}

export function macosGitCredentialError(
	output: string,
	platform: NodeJS.Platform = process.platform,
): { code: "git_credentials_required"; message: string } | undefined {
	if (platform !== "darwin") return undefined;
	if (
		!/terminal prompts disabled|could not read (?:Username|Password)|authentication failed|credential-osxkeychain/iu.test(
			output,
		)
	)
		return undefined;
	return {
		code: "git_credentials_required",
		message:
			"macOS 钥匙串中没有可用的 Git HTTPS 凭据。请在本机终端进入该仓库执行一次 git pull；如尚未启用钥匙串，先执行 git config --global credential.helper osxkeychain。完成后 Web 会静默复用该凭据。",
	};
}
