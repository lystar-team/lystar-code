import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeClientMessage, encodeServerMessage } from "../src/index.ts";
import { goldenFixtures } from "./rust-golden-fixtures.ts";

const directory = resolve(import.meta.dirname, "../../../crates/lystar-protocol/tests/fixtures");
mkdirSync(directory, { recursive: true });
for (const fixture of goldenFixtures) {
	const frame = fixture.direction === "client" ? encodeClientMessage(fixture.message) : encodeServerMessage(fixture.message);
	writeIfChanged(resolve(directory, `ts-${fixture.name}.frame`), frame);
}

function writeIfChanged(path, content) {
	if (!Buffer.from(readFileSyncSafe(path)).equals(content)) writeFileSync(path, content);
}

function readFileSyncSafe(path) {
	try {
		return readFileSync(path);
	} catch {
		return Buffer.alloc(0);
	}
}
