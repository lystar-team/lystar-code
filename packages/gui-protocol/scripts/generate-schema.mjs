import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	B3CommandResultSchemas,
	ClientMessageSchema,
	JsonValueSchema,
	ServerMessageSchema,
	SessionProgressSchema,
} from "../src/schemas.ts";

const schemaPath = resolve(import.meta.dirname, "../generated/gui-protocol.schema.json");
const generatedRustPath = resolve(import.meta.dirname, "../../../crates/lystar-protocol/src/generated.rs");

const jsonValueDefinition = JsonValueSchema.$defs.JsonValue;
const toolEndStatus = {
	anyOf: [
		{ type: "string", const: "success" },
		{ type: "string", const: "error" },
	],
};
const normalizedSessionProgress = normalizeJsonValueReferences(SessionProgressSchema);
const sessionProgress = replaceSchema(
	normalizedSessionProgress,
	toolEndStatus,
	{ $ref: "#/$defs/ToolEndStatus" },
);
const schema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$title: "LYStar GUI Protocol v1",
	$defs: {
		JsonValue: normalizeJsonValueReferences(jsonValueDefinition),
		ClientMessage: normalizeJsonValueReferences(ClientMessageSchema),
		ServerSessionProgress: sessionProgress,
		ToolEndStatus: toolEndStatus,
		ServerMessage: replaceSchema(
			normalizeJsonValueReferences(ServerMessageSchema),
			normalizedSessionProgress,
			{ $ref: "#/$defs/ServerSessionProgress" },
		),
		...Object.fromEntries(
			Object.entries(B3CommandResultSchemas).map(([command, result]) => [
				`B3${command.replace(/(^|_)([a-z])/g, (_, __, character) => character.toUpperCase())}Result`,
				normalizeJsonValueReferences(result),
			]),
		),
	},
};
const json = `${JSON.stringify(schema, null, 2)}\n`;
const hash = createHash("sha256").update(json).digest("hex");
const rust = `// 此文件由 packages/gui-protocol/scripts/generate-schema.mjs 生成，禁止手改。\n\n` +
	`pub const GUI_PROTOCOL_SCHEMA_SHA256: &str =\n    "${hash}";\n\n` +
	`typify::import_types!(schema = "../../packages/gui-protocol/generated/gui-protocol.schema.json");\n`;

for (const [path, content] of [
	[schemaPath, json],
	[generatedRustPath, rust],
]) {
	mkdirSync(dirname(path), { recursive: true });
	if (readFileSyncSafe(path) !== content) writeFileSync(path, content);
}

function normalizeJsonValueReferences(value) {
	if (Array.isArray(value)) return value.map(normalizeJsonValueReferences);
	if (value === null || typeof value !== "object") return value;
	const object = Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "$defs")
			.map(([key, child]) => [key, normalizeJsonValueReferences(child)]),
	);
	if (typeof object.const === "number") {
		object.type = Number.isInteger(object.const) ? "integer" : "number";
	}
	return object.$ref === "JsonValue" ? { $ref: "#/$defs/JsonValue" } : object;
}

function replaceSchema(value, target, replacement) {
	if (JSON.stringify(value) === JSON.stringify(target)) return replacement;
	if (Array.isArray(value)) return value.map((item) => replaceSchema(item, target, replacement));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceSchema(child, target, replacement)]));
}

function readFileSyncSafe(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}
