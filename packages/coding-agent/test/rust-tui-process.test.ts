import { describe, expect, test } from "vitest";
import { launchRustTuiProcess } from "../src/rust-tui-process.ts";

describe("Rust TUI process", () => {
	test("injects the Host endpoint and reports the child exit", async () => {
		const managed = await launchRustTuiProcess({
			rust: {
				command: process.execPath,
				args: ["-e", "process.exit(process.env.PI_RUST_TUI_HOST_ENDPOINT === '/tmp/host.sock' ? 0 : 2)"],
			},
			endpoint: "/tmp/host.sock",
			stdio: "ignore",
		});
		expect(await managed.wait()).toEqual({ code: 0, signal: null });
	});

	test("rejects when the frontend binary cannot be started", async () => {
		await expect(
			launchRustTuiProcess({
				rust: { command: "/missing/lystar-tui", args: [] },
				endpoint: "/tmp/host.sock",
				stdio: "ignore",
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
