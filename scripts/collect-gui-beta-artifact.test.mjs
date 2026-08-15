import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const collector = new URL("./collect-gui-beta-artifact.mjs", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../packages/gui/package.json", import.meta.url), "utf8")).version;

function elf(machine) {
	const bytes = Buffer.alloc(20);
	bytes.write("\u007fELF");
	bytes.writeUInt16LE(machine, 18);
	return bytes;
}

function pe(machine) {
	const bytes = Buffer.alloc(0x100);
	bytes.write("MZ");
	bytes.writeUInt32LE(0x80, 0x3c);
	bytes.write("PE\0\0", 0x80);
	bytes.writeUInt16LE(machine, 0x84);
	return bytes;
}

function collect(source, output, platform) {
	return execFileSync(process.execPath, [collector.pathname, source, output, version, platform], {
		cwd: root.pathname,
		encoding: "utf8",
		stdio: "pipe",
	});
}

test("GUI artifact collector verifies Linux ELF and Windows PE architectures", () => {
	const directory = mkdtempSync(join(tmpdir(), "lystar-gui-artifact-"));
	try {
		for (const [platform, extension, bytes] of [
			["linux-x64", "AppImage", elf(0x3e)],
			["linux-arm64", "AppImage", elf(0xb7)],
			["windows-x64", "exe", pe(0x8664)],
		]) {
			const source = join(directory, platform, "source");
			const output = join(directory, platform, "output");
			mkdirSync(source, { recursive: true });
			writeFileSync(join(source, `bundle.${extension}`), bytes);
			collect(source, output, platform);
		}

		const mismatchedSource = join(directory, "mismatch", "source");
		mkdirSync(mismatchedSource, { recursive: true });
		writeFileSync(join(mismatchedSource, "bundle.AppImage"), elf(0xb7));
		assert.throws(
			() => collect(mismatchedSource, join(directory, "mismatch", "output"), "linux-x64"),
			(error) => error && typeof error === "object" && error.status !== 0,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
