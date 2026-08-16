import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	parseClientMessage,
	parseServerMessage,
	type ClientMessage,
	type ServerMessage,
} from "../src/index.ts";

export type GoldenDirection = "client" | "server";
export type GoldenPresence = { path: string[]; state: "missing" | "null" | "value" };
export type ClientGoldenFixture = {
	name: string;
	direction: "client";
	message: ClientMessage;
	b3Command?: string;
	presence?: GoldenPresence;
};
export type ServerGoldenFixture = {
	name: string;
	direction: "server";
	message: ServerMessage;
	b3Command?: string;
	presence?: GoldenPresence;
};
export type GoldenFixture = ClientGoldenFixture | ServerGoldenFixture;

const fixturePath = resolve(import.meta.dirname, "fixtures/semantic.json");
const parsed: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { fixtures?: unknown }).fixtures)) {
	throw new Error(`Invalid semantic fixture manifest: ${fixturePath}`);
}

const names = new Set<string>();
export const goldenFixtures: GoldenFixture[] = (parsed as { fixtures: unknown[] }).fixtures.map((value, index) => {
	if (!value || typeof value !== "object") throw new Error(`Fixture ${index} must be an object`);
	const fixture = value as Record<string, unknown>;
	if (typeof fixture.name !== "string" || fixture.name.length === 0 || names.has(fixture.name)) {
		throw new Error(`Fixture ${index} has an invalid or duplicate name`);
	}
	names.add(fixture.name);
	if (fixture.direction !== "client" && fixture.direction !== "server") {
		throw new Error(`Fixture ${fixture.name} has an invalid direction`);
	}
	const presence = parsePresence(fixture.presence, fixture.name);
	if (fixture.b3Command !== undefined && typeof fixture.b3Command !== "string") {
		throw new Error(`Fixture ${fixture.name} has an invalid B3 command`);
	}
	if (fixture.direction === "client") {
		return {
			name: fixture.name,
			direction: "client",
			message: parseClientMessage(fixture.message),
			...(typeof fixture.b3Command === "string" ? { b3Command: fixture.b3Command } : {}),
			...(presence ? { presence } : {}),
		};
	}
	return {
		name: fixture.name,
		direction: "server",
		message: parseServerMessage(fixture.message),
		...(typeof fixture.b3Command === "string" ? { b3Command: fixture.b3Command } : {}),
		...(presence ? { presence } : {}),
	};
});

function parsePresence(value: unknown, name: string): GoldenPresence | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw new Error(`Fixture ${name} has an invalid presence assertion`);
	const presence = value as Record<string, unknown>;
	if (
		!Array.isArray(presence.path) ||
		presence.path.some((part) => typeof part !== "string") ||
		(presence.state !== "missing" && presence.state !== "null" && presence.state !== "value")
	) {
		throw new Error(`Fixture ${name} has an invalid presence assertion`);
	}
	return { path: presence.path, state: presence.state };
}
