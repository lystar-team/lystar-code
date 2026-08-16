import { describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createRustTuiLaunchOptions, rustTuiLaunchArgv } from "../src/rust-tui-launch-options.ts";

describe("Rust TUI launch options", () => {
	test("maps configured mode and fullscreen exit output without changing the default path", () => {
		const settings = SettingsManager.inMemory({ tuiMode: "fullscreen", fullscreenExitOutput: "resume-hint" });
		const options = createRustTuiLaunchOptions("/tmp/session with space.jsonl", settings, {});
		expect(options).toEqual({
			sessionPath: "/tmp/session with space.jsonl",
			mode: "fullscreen",
			exitOutput: "resume-hint",
		});
		expect(rustTuiLaunchArgv(options)).toEqual([
			"--run",
			"/tmp/session with space.jsonl",
			"--mode",
			"fullscreen",
			"--exit-output",
			"resume-hint",
		]);
	});

	test("keeps Rust auto selection when no TUI mode is configured", () => {
		const settings = SettingsManager.inMemory();
		expect(createRustTuiLaunchOptions("/tmp/session.jsonl", settings, {}).mode).toBe("auto");
	});

	test("leaves PI_TUI_MODE precedence to Rust mode resolution", () => {
		const settings = SettingsManager.inMemory({ tuiMode: "fullscreen" });
		expect(createRustTuiLaunchOptions("/tmp/session.jsonl", settings, { PI_TUI_MODE: "regular" }).mode).toBe("auto");
	});
});
