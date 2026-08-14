import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../packages/coding-agent/src/core/index.ts";
import { TranscriptReader } from "../packages/gui-host/src/transcript-reader.ts";

const MiB = 1024 * 1024;
const sizesMiB = [16, 64, 256];
const samples = 10;
const lineBytes = 64 * 1024;
const initialRssMiB = process.memoryUsage().rss / MiB;
const tempDir = mkdtempSync(join(tmpdir(), "lystar-gui-session-benchmark-"));

function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function writeSession(path, targetBytes) {
	const fd = openSync(path, "w");
	let written = 0;
	let index = 0;
	let parentId = null;
	try {
		const header = `${JSON.stringify({
			type: "session",
			version: 3,
			id: `benchmark-${targetBytes}`,
			timestamp: "2026-08-13T00:00:00Z",
			cwd: tempDir,
		})}\n`;
		written += writeSync(fd, header);
		while (written < targetBytes) {
			const id = `entry-${String(index).padStart(6, "0")}`;
			const base = {
				type: "message",
				id,
				parentId,
				timestamp: "2026-08-13T00:00:01Z",
				message: { role: index % 2 === 0 ? "user" : "assistant", content: "", timestamp: 1 },
			};
			const baseBytes = Buffer.byteLength(JSON.stringify(base)) + 1;
			base.message.content = "x".repeat(Math.max(0, lineBytes - baseBytes));
			written += writeSync(fd, `${JSON.stringify(base)}\n`);
			parentId = id;
			index++;
		}
	} finally {
		closeSync(fd);
	}
	return { bytes: statSync(path).size, entries: index, leafId: parentId };
}

async function measureRead(path) {
	for (let index = 0; index < 2; index++) await new TranscriptReader().read(path, { limit: 120 });
	const values = [];
	for (let index = 0; index < samples; index++) {
		const started = performance.now();
		const page = await new TranscriptReader().read(path, { limit: 120 });
		values.push(performance.now() - started);
		if (page.items.length !== 120) throw new Error(`Expected 120 transcript items, received ${page.items.length}`);
	}
	return {
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		maxMs: Math.max(...values),
	};
}

try {
	const files = [];
	for (const sizeMiB of sizesMiB) {
		const path = join(tempDir, `session-${sizeMiB}.jsonl`);
		const generated = writeSession(path, sizeMiB * MiB);
		files.push({ sizeMiB, path, ...generated, read: await measureRead(path) });
	}

	const largest = files.at(-1);
	if (!largest?.leafId) throw new Error("Largest benchmark Session has no leaf entry");
	const source = SessionManager.open(largest.path, tempDir);
	const rewriteStarted = performance.now();
	const branch = source.createBranchedSessionManager(largest.leafId);
	const rewriteMs = performance.now() - rewriteStarted;
	const branchPath = branch.getSessionFile();
	const branchBytes = branchPath ? statSync(branchPath).size : 0;
	branch.dispose();
	source.dispose();

	process.stdout.write(
		`${JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				platform: process.platform,
				arch: process.arch,
				node: process.version,
				samples,
				memory: {
					initialRssMiB,
					finalRssMiB: process.memoryUsage().rss / MiB,
					peakRssMiB: process.resourceUsage().maxRSS / 1024,
				},
				files: files.map(({ path: _path, ...file }) => file),
				rewrite: {
					sourceMiB: largest.sizeMiB,
					sourceBytes: largest.bytes,
					branchBytes,
					elapsedMs: rewriteMs,
					staleMs: 120_000,
					staleMargin: 120_000 / rewriteMs,
				},
			},
			null,
			2,
		)}\n`,
	);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
