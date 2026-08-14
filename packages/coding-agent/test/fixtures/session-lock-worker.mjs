import { SessionManager } from "../../src/core/session-manager.ts";

const [mode, sessionPath] = process.argv.slice(2);

try {
	const manager = SessionManager.open(sessionPath);
	if (mode === "try") {
		manager.appendSessionInfo(`writer-${process.pid}`);
		manager.dispose();
		process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
		process.exit(0);
	}

	process.stdout.write(`${JSON.stringify({ ok: true, ready: true })}\n`);
	process.stdin.setEncoding("utf8");
	process.stdin.once("data", () => {
		manager.dispose();
		process.exit(0);
	});
	setInterval(() => {}, 1_000);
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({
			ok: false,
			name: error instanceof Error ? error.name : "Error",
			code: error && typeof error === "object" && "code" in error ? error.code : undefined,
			retryable: error && typeof error === "object" && "retryable" in error ? error.retryable : undefined,
		})}\n`,
	);
	process.exit(2);
}