import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ClientMessageDecoder, ServerMessageDecoder } from "../src/index.ts";
import { clientGoldenFixtures, serverGoldenFixtures } from "./rust-golden-fixtures.ts";

const directory = resolve(import.meta.dirname, "../../../crates/lystar-protocol/tests/fixtures");
for (const [name, expected] of Object.entries(clientGoldenFixtures)) {
	assert.deepEqual(
		new ClientMessageDecoder().push(readFileSync(resolve(directory, `rust-${name}.frame`)))[0],
		expected,
		`Rust client fixture ${name} changed the message`,
	);
}
for (const [name, expected] of Object.entries(serverGoldenFixtures)) {
	assert.deepEqual(
		new ServerMessageDecoder().push(readFileSync(resolve(directory, `rust-${name}.frame`)))[0],
		expected,
		`Rust server fixture ${name} changed the message`,
	);
}
const generated = readdirSync(directory).filter((name) => name.endsWith(".frame"));
assert.equal(generated.length, Object.keys(clientGoldenFixtures).length * 2 + Object.keys(serverGoldenFixtures).length * 2);
