import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	assertB3CommandResult,
	B3CommandResultSchemas,
	ClientMessageDecoder,
	ServerMessageDecoder,
} from "../src/index.ts";
import { goldenFixtures } from "./rust-golden-fixtures.ts";

const directory = resolve(import.meta.dirname, "../../../crates/lystar-protocol/tests/fixtures");
for (const fixture of goldenFixtures) {
	const frame = readFileSync(resolve(directory, `rust-${fixture.name}.frame`));
	if (fixture.direction === "client") {
		const [actual] = new ClientMessageDecoder().push(frame);
		assert.deepEqual(actual, fixture.message, `Rust client fixture ${fixture.name} changed the message`);
		if (fixture.b3Command) {
			assert.equal(actual.request.command, fixture.b3Command, `Rust client fixture ${fixture.name} changed the B3 command`);
		}
		continue;
	}
	const [actual] = new ServerMessageDecoder().push(frame);
	assert.deepEqual(actual, fixture.message, `Rust server fixture ${fixture.name} changed the message`);
	if (fixture.b3Command) {
		assert.ok(fixture.b3Command in B3CommandResultSchemas, `Unknown B3 command ${fixture.b3Command}`);
		assertB3CommandResult(fixture.b3Command, actual.result);
	}
}
const generated = readdirSync(directory).filter((name) => name.endsWith(".frame"));
assert.equal(generated.length, goldenFixtures.length * 2, "fixture directory has stale or missing frames");
