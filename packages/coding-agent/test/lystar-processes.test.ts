import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findOldLystarProcesses } from "../src/utils/lystar-processes.ts";

describe("LYStar 旧版进程发现", () => {
	it("只匹配旧版本的交互式 lc，不匹配当前版本和 Web 子进程", async () => {
		const root = await mkdtemp(join(tmpdir(), "lystar-processes-"));
		try {
			const oldDirectory = join(root, "versions", "0.84.2-lystar.2");
			const currentDirectory = join(root, "versions", "0.84.4-lystar.1");
			await mkdir(oldDirectory, { recursive: true });
			await mkdir(currentDirectory, { recursive: true });
			await Promise.all([
				writeFile(join(oldDirectory, "lc"), "old"),
				writeFile(join(oldDirectory, "lystar"), "old"),
				writeFile(join(currentDirectory, "lc"), "current"),
			]);
			const oldPath = join(oldDirectory, "lc");
			const oldAliasPath = join(oldDirectory, "lystar");
			const currentPath = join(currentDirectory, "lc");
			const found = findOldLystarProcesses(
				[
					{ pid: 101, executablePath: oldPath, commandLine: oldPath },
					{ pid: 102, executablePath: oldAliasPath, commandLine: oldAliasPath },
					{ pid: 103, executablePath: oldPath, commandLine: `${oldPath} web` },
					{ pid: 104, executablePath: oldPath, commandLine: `${oldPath} web-runtime serve` },
					{ pid: 105, executablePath: currentPath, commandLine: currentPath },
				],
				{ installRoot: root, currentVersionDirectory: currentDirectory, excludePid: 999 },
			);
			expect(found.map((process) => process.pid)).toEqual([101, 102]);
			expect(found[0]?.versionDirectory).toBe(oldDirectory);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
