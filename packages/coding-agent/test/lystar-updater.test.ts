import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnProcess, spawnProcessSync } from "../src/utils/child-process.ts";
import { runLystarInstaller } from "../src/utils/lystar-updater.ts";

vi.mock("../src/utils/child-process.ts", () => ({ spawnProcess: vi.fn(), spawnProcessSync: vi.fn() }));
const platform = process.platform;

afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	vi.resetAllMocks();
});

function installerExit(code: number, inspect?: (command: string, args: string[]) => void): void {
	vi.mocked(spawnProcess).mockImplementation((command, args) => {
		inspect?.(command, args);
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", code, null));
		return child as ReturnType<typeof spawnProcess>;
	});
}

function installedVersion(version: string): void {
	vi.mocked(spawnProcessSync).mockReturnValue({
		pid: 1,
		output: [null, version, ""],
		stdout: version,
		stderr: "",
		status: 0,
		signal: null,
	});
}

const download = () => new Response("#!/bin/bash\nexit 0\n");

describe("LYStar updater", () => {
	it("rejects invalid release repository metadata before downloading", async () => {
		const fetchMock = vi.fn();
		await expect(runLystarInstaller("not-a-repository", [], { fetch: fetchMock })).rejects.toThrow(
			"无效的 LYStar release repository",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reports installer download failures", async () => {
		const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
		await expect(runLystarInstaller("lystar/releases", [], { fetch: fetchMock })).rejects.toThrow(
			"下载安装器失败：HTTP 404",
		);
	});

	it("rejects an installer failure and removes its temporary script", async () => {
		let script = "";
		installerExit(1, (_command, args) => {
			script = args[0];
		});
		await expect(
			runLystarInstaller("lystar/releases", ["--version", "1.0.0-lystar.1"], {
				fetch: vi.fn(async () => download()),
			}),
		).rejects.toThrow("退出码：1");
		expect(spawnProcessSync).not.toHaveBeenCalled();
		expect(existsSync(script)).toBe(false);
	});

	it("rejects false success when the installed version has not changed", async () => {
		installerExit(0);
		installedVersion("0.85.1-lystar.1");
		await expect(
			runLystarInstaller("lystar/releases", ["--version", "0.85.1-lystar.5"], {
				fetch: vi.fn(async () => download()),
			}),
		).rejects.toThrow("安装结果校验失败");
	});

	it("verifies the activated launcher before reporting success", async () => {
		installerExit(0);
		installedVersion("0.85.1-lystar.5");
		await runLystarInstaller("lystar/releases", ["--version", "0.85.1-lystar.5"], {
			fetch: vi.fn(async () => download()),
		});
		expect(spawnProcessSync).toHaveBeenCalledWith(
			expect.stringContaining("lc"),
			["--version"],
			expect.objectContaining({ timeout: 15_000 }),
		);
	});

	it("uses PowerShell parameters and restores the UTF-8 BOM removed by response.text", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		installerExit(0, (command, args) => {
			expect(command).toBe("powershell.exe");
			expect(args.slice(-2)).toEqual(["-Version", "0.85.1-lystar.5"]);
			const bytes = readFileSync(args[args.indexOf("-File") + 1]);
			expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		});
		installedVersion("0.85.1-lystar.5");
		await runLystarInstaller("lystar/releases", ["--version", "0.85.1-lystar.5"], {
			fetch: vi.fn(async () => new Response("\uFEFFexit 0")),
		});
	});
});
