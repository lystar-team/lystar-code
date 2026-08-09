import { describe, expect, it } from "vitest";
import { shouldLaunchWindowsTerminalHost } from "../src/utils/windows-terminal.ts";

describe("Windows terminal launch routing", () => {
	it("keeps automation and one-shot commands attached", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const tty = { stdinIsTTY: true, stdoutIsTTY: true };
			for (const args of [
				["--attached"],
				["--version"],
				["--print", "hello"],
				["--mode", "json"],
				["install", "npm:test"],
				["auth", "check"],
			]) {
				expect(shouldLaunchWindowsTerminalHost(args, tty, {}, true)).toBe(false);
			}
			expect(shouldLaunchWindowsTerminalHost([], { stdinIsTTY: false, stdoutIsTTY: true }, {}, true)).toBe(false);
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});

	it("launches only standalone Windows interactive sessions", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			expect(shouldLaunchWindowsTerminalHost([], { stdinIsTTY: true, stdoutIsTTY: true }, {}, true)).toBe(true);
			expect(
				shouldLaunchWindowsTerminalHost(["--continue"], { stdinIsTTY: true, stdoutIsTTY: true }, {}, true),
			).toBe(true);
			expect(
				shouldLaunchWindowsTerminalHost(
					[],
					{ stdinIsTTY: true, stdoutIsTTY: true },
					{ LYSTAR_TERMINAL_HOST: "1" },
					true,
				),
			).toBe(false);
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});
});
