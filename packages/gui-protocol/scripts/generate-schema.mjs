import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	WorkspaceCommandResultSchemas,
	ClientMessageSchema,
	JsonValueSchema,
	ServerMessageSchema,
	SessionProgressSchema,
} from "../src/schemas.ts";

const schemaPath = resolve(import.meta.dirname, "../generated/gui-protocol.schema.json");

const jsonValueDefinition = JsonValueSchema.$defs.JsonValue;
const toolEndStatus = {
	anyOf: [
		{ type: "string", const: "success" },
		{ type: "string", const: "error" },
	],
};
const compactionProgressStatus = {
	anyOf: ["running", "completed", "cancelled", "failed", "waiting_retry"].map((value) => ({
		type: "string",
		const: value,
	})),
};
const retryProgressStatus = {
	anyOf: ["waiting", "running", "completed", "failed"].map((value) => ({ type: "string", const: value })),
};
const statusProgressText = { type: "string", minLength: 1, maxLength: 1024 };
const normalizedSessionProgress = normalizeJsonValueReferences(SessionProgressSchema);
// typify 会按字段名推导匿名类型；显式命名不同语义的 status，避免新增 schema 时发生类型碰撞。
const sessionProgress = [
	[toolEndStatus, { $ref: "#/$defs/ToolEndStatus" }],
	[compactionProgressStatus, { $ref: "#/$defs/ServerCompactionProgressStatus" }],
	[retryProgressStatus, { $ref: "#/$defs/ServerRetryProgressStatus" }],
	[statusProgressText, { $ref: "#/$defs/ServerStatusProgressText" }],
].reduce((value, [target, replacement]) => replaceSchema(value, target, replacement), normalizedSessionProgress);
const schema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$title: "LYStar GUI Protocol v1",
	$defs: {
		JsonValue: normalizeJsonValueReferences(jsonValueDefinition),
		ClientMessage: normalizeJsonValueReferences(ClientMessageSchema),
		ServerCompactionProgressStatus: compactionProgressStatus,
		ServerRetryProgressStatus: retryProgressStatus,
		ServerStatusProgressText: statusProgressText,
		ServerSessionProgress: sessionProgress,
		ToolEndStatus: toolEndStatus,
		ServerMessage: replaceSchema(
			normalizeJsonValueReferences(ServerMessageSchema),
			normalizedSessionProgress,
			{ $ref: "#/$defs/ServerSessionProgress" },
		),
		...Object.fromEntries(
			Object.entries(WorkspaceCommandResultSchemas).map(([command, result]) => [
				`Workspace${command.replace(/(^|_)([a-z])/g, (_, __, character) => character.toUpperCase())}Result`,
				normalizeJsonValueReferences(result),
			]),
		),
	},
};
const json = `${JSON.stringify(schema, null, 2)}\n`;
mkdirSync(dirname(schemaPath), { recursive: true });
if (readFileSyncSafe(schemaPath) !== json) writeFileSync(schemaPath, json);

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
