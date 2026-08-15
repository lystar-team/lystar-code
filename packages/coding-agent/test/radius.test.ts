import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthContext, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { RADIUS_PROVIDER_ID } from "../src/core/radius.ts";
import { allowNetwork } from "./test-network-env.ts";

function radiusOAuthCredential(gatewayBaseUrl: string) {
	return {
		type: "oauth" as const,
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60 * 60 * 1000,
		gatewayConfig: radiusConfig(gatewayBaseUrl),
	};
}

function radiusConfig(baseUrl: string) {
	return {
		baseUrl,
		models: [
			{
				id: "auto",
				name: "Radius Auto",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	};
}

const emptyAuthContext: AuthContext = {
	env: async () => undefined,
	fileExists: async () => false,
};

let tempDir: string;

beforeEach(() => {
	allowNetwork();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		throw new Error(`Unexpected fetch: ${String(url)}`);
	});
	tempDir = join(tmpdir(), `pi-test-radius-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
});

describe("Radius provider", () => {
	it("restores the legacy credential catalog without network access", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				[RADIUS_PROVIDER_ID]: radiusOAuthCredential("https://radius.example.com/v1"),
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			authContext: emptyAuthContext,
		});

		const model = runtime.getModel(RADIUS_PROVIDER_ID, "auto");
		expect(model).toMatchObject({ api: "pi-messages", baseUrl: "https://radius.example.com/v1" });
		expect(runtime.getProvider(RADIUS_PROVIDER_ID)?.name).toBe("Radius");
		expect(runtime.hasConfiguredAuth(RADIUS_PROVIDER_ID)).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("fetches and stores the catalog for configured Radius auth", async () => {
		const expectedUrl = "https://radius.pi.dev/v1/config";
		vi.mocked(fetch).mockImplementation(async (url) => {
			if (String(url) !== expectedUrl) throw new Error(`Unexpected fetch: ${String(url)}`);
			return new Response(JSON.stringify(radiusConfig("https://radius.example.com/v1")), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const modelsStore = new InMemoryModelsStore();
		const credentials = AuthStorage.inMemory({
			[RADIUS_PROVIDER_ID]: {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60 * 60 * 1000,
			},
		});
		const runtime = await ModelRuntime.create({
			credentials,
			modelsStore,
			modelsPath: null,
			allowModelNetwork: true,
			authContext: emptyAuthContext,
		});

		expect(runtime.getModel(RADIUS_PROVIDER_ID, "auto")).toBeDefined();
		expect((await modelsStore.read(RADIUS_PROVIDER_ID))?.models).toHaveLength(1);
		const radiusRequest = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === expectedUrl);
		expect(radiusRequest?.[1]?.headers).toMatchObject({ authorization: "Bearer access-token" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not refresh catalogs over the network by default", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				[RADIUS_PROVIDER_ID]: radiusOAuthCredential("https://radius.example.com/v1"),
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			authContext: emptyAuthContext,
		});

		expect(runtime.getModel(RADIUS_PROVIDER_ID, "auto")).toBeDefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not fetch or expose Radius models without configured auth", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
			authContext: emptyAuthContext,
		});

		expect(runtime.getModels(RADIUS_PROVIDER_ID)).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("ignores ambient provider credentials when auth context is empty", async () => {
		vi.stubEnv("OPENAI_API_KEY", "test-ambient-key");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
			authContext: emptyAuthContext,
		});

		expect(runtime.hasConfiguredAuth("openai")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "openai")).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("supports custom Radius gateways from models.json", async () => {
		const expectedUrl = "http://localhost:8788/v1/config";
		vi.mocked(fetch).mockImplementation(async (url) => {
			if (String(url) !== expectedUrl) throw new Error(`Unexpected fetch: ${String(url)}`);
			return new Response(JSON.stringify(radiusConfig("http://localhost:8788/v1")), { status: 200 });
		});
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "radius-dev": { name: "Radius (dev)", baseUrl: "http://localhost:8788", oauth: "radius" } },
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"radius-dev": {
					type: "oauth",
					access: "access-token",
					refresh: "refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
				},
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: true,
			authContext: emptyAuthContext,
		});

		expect(runtime.getModel("radius-dev", "auto")).toMatchObject({
			api: "pi-messages",
			baseUrl: "http://localhost:8788/v1",
		});
		expect(runtime.getProvider("radius-dev")?.name).toBe("Radius (dev)");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("requires baseUrl for custom Radius gateways", async () => {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { "radius-dev": { oauth: "radius" } } }));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
			authContext: emptyAuthContext,
		});

		expect(runtime.getError()).toContain('"baseUrl" is required when "oauth" is set');
		expect(fetch).not.toHaveBeenCalled();
	});
});
