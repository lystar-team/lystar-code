import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getShareViewerUrl } from "../config.ts";

const execFileAsync = promisify(execFile);

export interface SessionShareResult {
	previewUrl: string;
	gistUrl: string;
}

export class SessionShareError extends Error {
	readonly retryable = false;
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "SessionShareError";
		this.code = code;
	}
}

export async function shareSessionAsPrivateGist(options: {
	exportHtml(path: string): Promise<unknown>;
	signal?: AbortSignal;
}): Promise<SessionShareResult> {
	try {
		await execFileAsync("gh", ["auth", "status"], {
			encoding: "utf8",
			signal: options.signal,
			windowsHide: true,
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new SessionShareError("未安装 GitHub CLI（gh），请从 https://cli.github.com/ 安装。", "gh_not_found");
		}
		throw new SessionShareError("GitHub CLI 尚未登录，请先运行 gh auth login。", "gh_not_authenticated");
	}

	const directory = mkdtempSync(join(tmpdir(), "lystar-share-"));
	const htmlPath = join(directory, "session.html");
	try {
		options.signal?.throwIfAborted();
		try {
			await options.exportHtml(htmlPath);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new SessionShareError(
				`导出会话失败：${error instanceof Error ? error.message : String(error)}`,
				"session_export_failed",
			);
		}

		let stdout: string;
		try {
			const result = await execFileAsync("gh", ["gist", "create", "--public=false", htmlPath], {
				encoding: "utf8",
				signal: options.signal,
				windowsHide: true,
			});
			stdout = result.stdout;
		} catch (error) {
			if (options.signal?.aborted) throw error;
			const stderr = (error as { stderr?: unknown }).stderr;
			const message = typeof stderr === "string" && stderr.trim() ? stderr.trim() : String(error);
			throw new SessionShareError(`创建 gist 失败：${message}`, "gist_create_failed");
		}

		const gistUrl = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
		const gistId = gistUrl?.replace(/\/+$/, "").split("/").pop();
		if (!gistUrl || !gistId) {
			throw new SessionShareError("无法从 gh 输出中识别 gist ID", "invalid_gist_response");
		}
		return { previewUrl: getShareViewerUrl(gistId), gistUrl };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
