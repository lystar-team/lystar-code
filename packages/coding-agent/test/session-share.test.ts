import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shareSessionAsPrivateGist } from "../src/core/session-share.ts";

const originalPath = process.env.PATH;
const originalViewerUrl = process.env.PI_SHARE_VIEWER_URL;
const directories: string[] = [];

afterEach(() => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalViewerUrl === undefined) delete process.env.PI_SHARE_VIEWER_URL;
	else process.env.PI_SHARE_VIEWER_URL = originalViewerUrl;
	delete process.env.LYSTAR_FAKE_GH_MODE;
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function installFakeGh(): void {
	const directory = mkdtempSync(join(tmpdir(), "lystar-fake-gh-"));
	directories.push(directory);
	const scriptPath = join(directory, "gh.cjs");
	writeFileSync(
		scriptPath,
		[
			'const fs = require("node:fs");',
			"const args = process.argv.slice(2);",
			'const mode = process.env.LYSTAR_FAKE_GH_MODE || "success";',
			'if (args[0] === "auth") process.exit(mode === "auth-fail" ? 1 : 0);',
			'if (args[0] !== "gist" || !fs.readFileSync(args.at(-1), "utf8").includes("shared session")) process.exit(2);',
			'if (mode === "gist-fail") { console.error("gist denied"); process.exit(1); }',
			'if (mode === "delay") setTimeout(() => console.log("https://gist.github.com/test/gist-123"), 10_000);',
			'else console.log("https://gist.github.com/test/gist-123");',
		].join("\n"),
	);
	if (process.platform === "win32") {
		writeFileSync(join(directory, "gh.cmd"), `@"${process.execPath}" "${scriptPath}" %*\r\n`);
	} else {
		const executable = join(directory, "gh");
		writeFileSync(executable, `#!${process.execPath}\nrequire(${JSON.stringify(scriptPath)});\n`);
		chmodSync(executable, 0o755);
	}
	process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
}

describe("shareSessionAsPrivateGist", () => {
	it("exports a temporary HTML file and returns the viewer and gist URLs", async () => {
		installFakeGh();
		process.env.PI_SHARE_VIEWER_URL = "https://viewer.example/session/";
		let exportedPath = "";
		const result = await shareSessionAsPrivateGist({
			exportHtml: async (path) => {
				exportedPath = path;
				writeFileSync(path, "shared session");
			},
		});

		expect(result).toEqual({
			previewUrl: "https://viewer.example/session/#gist-123",
			gistUrl: "https://gist.github.com/test/gist-123",
		});
		expect(existsSync(dirname(exportedPath))).toBe(false);
	});

	it("reports an unauthenticated GitHub CLI without exporting", async () => {
		installFakeGh();
		process.env.LYSTAR_FAKE_GH_MODE = "auth-fail";
		let exported = false;
		await expect(
			shareSessionAsPrivateGist({
				exportHtml: async () => {
					exported = true;
				},
			}),
		).rejects.toMatchObject({
			code: "gh_not_authenticated",
			message: "GitHub CLI 尚未登录，请先运行 gh auth login。",
		});
		expect(exported).toBe(false);
	});

	it("aborts the gist process and removes the temporary export", async () => {
		installFakeGh();
		process.env.LYSTAR_FAKE_GH_MODE = "delay";
		const controller = new AbortController();
		let exportedPath = "";
		const pending = shareSessionAsPrivateGist({
			signal: controller.signal,
			exportHtml: async (path) => {
				exportedPath = path;
				writeFileSync(path, "shared session");
			},
		});
		setTimeout(() => controller.abort(), 50);

		await expect(pending).rejects.toBeDefined();
		expect(existsSync(dirname(exportedPath))).toBe(false);
	});
});
