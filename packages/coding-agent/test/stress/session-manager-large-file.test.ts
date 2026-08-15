import { constants as bufferConstants } from "node:buffer";
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

it("opens session files larger than Node's max string length", () => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-session-large-file-"));
	const file = join(tempDir, "large.jsonl");
	writeFileSync(file, '{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

	const fd = openSync(file, "r+");
	try {
		const newline = Buffer.from("\n");
		const stride = 16 * 1024 * 1024;
		for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
			writeSync(fd, newline, 0, newline.length, offset);
		}
	} finally {
		closeSync(fd);
	}

	appendFileSync(
		file,
		'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
	);

	const sessionManager = SessionManager.open(file, tempDir);
	expect(sessionManager.getSessionId()).toBe("abc");
	expect(sessionManager.getEntries()).toHaveLength(1);
	expect(sessionManager.buildSessionContext().messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
});
