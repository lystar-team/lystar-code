import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { CURRENT_SESSION_VERSION } from "../../coding-agent/src/core/session-manager.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = fileURLToPath(new URL("./fixtures/embedded-lc.ts", import.meta.url));
const tsxImport = import.meta.resolve("tsx");
const rustBinary = join(repositoryRoot, "target", "debug", "lystar-tui");
const hasScript = spawnSync("script", ["--version"]).status === 0;
const tmuxSockets = new Set<string>();
const tempDirs = new Set<string>();

afterEach(() => {
	for (const socket of tmuxSockets) spawnSync("tmux", ["-L", socket, "kill-server"]);
	tmuxSockets.clear();
	for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
	tempDirs.clear();
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tmux(socket: string, args: string[]): string {
	const result = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || `tmux ${args.join(" ")} failed`);
	return result.stdout;
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function sessionEntries(rounds: number, cwd: string): string {
	const entries: object[] = [
		{
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "main-rust",
			timestamp: "2026-08-20T00:00:00Z",
			cwd,
		},
	];
	let parentId: string | null = null;
	for (let index = 0; index < rounds; index++) {
		const assistant = `assistant-${index}`;
		const result = `result-${index}`;
		entries.push({
			type: "message",
			id: assistant,
			parentId,
			timestamp: "2026-08-20T00:00:00Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `src/${index}.ts` } }],
				stopReason: "toolUse",
				timestamp: index,
			},
		});
		entries.push({
			type: "message",
			id: result,
			parentId: assistant,
			timestamp: "2026-08-20T00:00:00Z",
			message: {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: `needle ${index}` }],
				isError: false,
				timestamp: index,
			},
		});
		parentId = result;
	}
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("lc embedded Rust TUI startup", () => {
	test.runIf(process.platform === "linux" && existsSync(rustBinary) && hasScript)(
		"streams a 620-record exit transcript through the interactive main path",
		async () => {
			const tempDir = mkdtempSync(join(tmpdir(), "lystar-main-rust-"));
			tempDirs.add(tempDir);
			const cwd = join(tempDir, "project");
			const agentDir = join(tempDir, "agent");
			const sessionPath = join(tempDir, "session.jsonl");
			const beforePath = join(tempDir, "stty-before");
			const afterPath = join(tempDir, "stty-after");
			const exitPath = join(tempDir, "exit-code");
			const rawOutputPath = join(tempDir, "terminal.raw");
			const tracePath = join(tempDir, "rust.trace");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(sessionPath, sessionEntries(620, cwd));
			writeFileSync(
				join(agentDir, "settings.json"),
				`${JSON.stringify({ tuiMode: "fullscreen", fullscreenExitOutput: "transcript" })}\n`,
			);

			const socket = `lystar-main-rust-${process.pid}-${Date.now()}`;
			tmuxSockets.add(socket);
			const lcCommand = `env PI_CODING_AGENT_DIR=${shellQuote(agentDir)} PI_TUI_FRONTEND=rust PI_RUST_TUI_BINARY=${shellQuote(rustBinary)} PI_RUST_TUI_TRACE=1 PI_OFFLINE=1 ${shellQuote(process.execPath)} --import ${shellQuote(tsxImport)} ${shellQuote(entry)} --session ${shellQuote(sessionPath)} 2> ${shellQuote(tracePath)}`;
			const command = [
				`stty -g > ${shellQuote(beforePath)}`,
				`script -q -e -c ${shellQuote(lcCommand)} ${shellQuote(rawOutputPath)}`,
				`code=$?`,
				`stty -g > ${shellQuote(afterPath)}`,
				`printf '%s\\n' "$code" > ${shellQuote(exitPath)}`,
			].join("; ");
			tmux(socket, ["new-session", "-d", "-s", "tui", "-x", "80", "-y", "24", command]);

			try {
				await waitFor("Rust Composer", () => {
					const pane = tmux(socket, ["capture-pane", "-p", "-t", "tui", "-S", "-24"]);
					return pane.includes("LYStar Code") && pane.includes("Ctrl+O 展开") && pane.includes("上下文");
				});
			} catch (error) {
				const pane = tmux(socket, ["capture-pane", "-p", "-t", "tui", "-S", "-24"]);
				const exit = existsSync(exitPath) ? readFileSync(exitPath, "utf8").trim() : "running";
				throw new Error(`${error instanceof Error ? error.message : String(error)}; exit=${exit}\n${pane}`);
			}
			tmux(socket, ["send-keys", "-t", "tui", "/quit"]);
			await waitFor("quit command", () => {
				const pane = tmux(socket, ["capture-pane", "-p", "-t", "tui", "-S", "-24"]);
				return pane.includes("/quit");
			});
			tmux(socket, ["send-keys", "-t", "tui", "Enter"]);
			try {
				await waitFor("lc exit", () => existsSync(exitPath), 30_000);
			} catch (error) {
				const pane = tmux(socket, ["capture-pane", "-p", "-t", "tui", "-S", "-24"]);
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${pane}`);
			}

			const exit = readFileSync(exitPath, "utf8").trim();
			expect(
				exit,
				`Rust TUI exited unexpectedly.\ntrace:\n${readFileSync(tracePath, "utf8")}\nterminal:\n${readFileSync(rawOutputPath, "utf8").slice(-8_000)}`,
			).toBe("0");
			expect(readFileSync(afterPath, "utf8").trim()).toBe(readFileSync(beforePath, "utf8").trim());
			const rawOutput = readFileSync(rawOutputPath, "utf8");
			const trace = readFileSync(tracePath, "utf8");
			const traceEvents = [
				...trace.matchAll(/trace=(exit_transcript_(?:request|response)) at_ms=([\d.]+) id=([^\s]+)/g),
			].map(([, event, atMs, id]) => ({ event, atMs: Number(atMs), id }));
			expect(rawOutput).toContain("needle 0");
			expect(rawOutput).toContain("needle 619");
			expect(rawOutput.indexOf("needle 0")).toBeLessThan(rawOutput.lastIndexOf("needle 619"));
			expect(traceEvents.length).toBeGreaterThanOrEqual(8);
			expect(traceEvents.length % 2).toBe(0);
			const responseLatencies: number[] = [];
			for (let index = 0; index < traceEvents.length; index += 2) {
				expect(traceEvents[index]?.event).toBe("exit_transcript_request");
				expect(traceEvents[index + 1]?.event).toBe("exit_transcript_response");
				responseLatencies.push(traceEvents[index + 1]!.atMs - traceEvents[index]!.atMs);
			}
			if (responseLatencies.some((latency) => latency >= 3_000)) {
				throw new Error(`退出记录回包超过 3 秒：${JSON.stringify(responseLatencies)}`);
			}
			tmuxSockets.delete(socket);
		},
		45_000,
	);
});
