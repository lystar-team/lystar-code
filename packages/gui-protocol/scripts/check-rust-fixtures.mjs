import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ClientMessageDecoder, ServerMessageDecoder } from "../src/index.ts";

const directory = resolve(import.meta.dirname, "../../../crates/lystar-protocol/tests/fixtures");
const client = new ClientMessageDecoder().push(readFileSync(resolve(directory, "rust-client-hello.frame")));
const server = new ServerMessageDecoder().push(readFileSync(resolve(directory, "rust-server-hello.frame")));
assert.equal(client[0]?.type, "hello");
assert.equal(server[0]?.type, "hello");
assert.equal(server[0]?.type === "hello" ? server[0].protocolVersion : undefined, 1);
