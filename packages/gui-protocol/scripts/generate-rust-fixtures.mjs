import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeClientMessage, encodeServerMessage } from "../src/index.ts";
import { clientGoldenFixtures, serverGoldenFixtures } from "./rust-golden-fixtures.ts";

const directory = resolve(import.meta.dirname, "../../../crates/lystar-protocol/tests/fixtures");
mkdirSync(directory, { recursive: true });
for (const [name, message] of Object.entries(clientGoldenFixtures)) {
	writeIfChanged(resolve(directory, `ts-${name}.frame`), encodeClientMessage(message));
}
for (const [name, message] of Object.entries(serverGoldenFixtures)) {
	writeIfChanged(resolve(directory, `ts-${name}.frame`), encodeServerMessage(message));
}

function writeIfChanged(path, content) {
	const bytes = Buffer.from(content);
	if (!Buffer.from(readFileSyncSafe(path)).equals(bytes)) writeFileSync(path, bytes);
}

function readFileSyncSafe(path) {
	try {
		return readFileSync(path);
	} catch {
		return Buffer.alloc(0);
	}
}
