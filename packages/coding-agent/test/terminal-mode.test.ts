import { describe, expect, it } from "vitest";
import { shouldUseAlternateScreen, type TerminalModeContext } from "../src/modes/interactive/terminal-mode.ts";

const plainTerminal: TerminalModeContext = {
	isTTY: true,
	term: "xterm-256color",
	tmuxControlMode: false,
};

describe("alternate screen policy", () => {
	it("uses fullscreen in a regular terminal and normal tmux", () => {
		expect(shouldUseAlternateScreen("auto", plainTerminal)).toBe(true);
		expect(shouldUseAlternateScreen("auto", { ...plainTerminal, tmux: "/tmp/tmux" })).toBe(true);
	});

	it("falls back for zellij, tmux control mode, dumb terminals, and non-TTY output", () => {
		expect(shouldUseAlternateScreen("auto", { ...plainTerminal, zellij: "1" })).toBe(false);
		expect(shouldUseAlternateScreen("auto", { ...plainTerminal, tmux: "/tmp/tmux", tmuxControlMode: true })).toBe(
			false,
		);
		expect(shouldUseAlternateScreen("auto", { ...plainTerminal, term: "dumb" })).toBe(false);
		expect(shouldUseAlternateScreen("auto", { ...plainTerminal, isTTY: false })).toBe(false);
	});

	it("honors explicit always and never modes on a TTY", () => {
		expect(shouldUseAlternateScreen("always", { ...plainTerminal, zellij: "1" })).toBe(true);
		expect(shouldUseAlternateScreen("never", plainTerminal)).toBe(false);
		expect(shouldUseAlternateScreen("always", { ...plainTerminal, isTTY: false })).toBe(false);
	});
});
