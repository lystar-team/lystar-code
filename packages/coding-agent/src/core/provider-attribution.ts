import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { APP_NAME, APP_TITLE, RELEASE_REPOSITORY } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

type ProviderAttributionModel = Pick<Model<Api>, "provider" | "baseUrl">;

function isOpenRouterModel(model: ProviderAttributionModel): boolean {
	return model.provider === "openrouter" || model.baseUrl.includes(OPENROUTER_HOST);
}

function isNvidiaNimModel(model: ProviderAttributionModel): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: ProviderAttributionModel): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

export function getProviderAttributionHeaders(model: ProviderAttributionModel): Record<string, string> | undefined {
	if (isOpenRouterModel(model)) {
		return {
			...(RELEASE_REPOSITORY ? { "HTTP-Referer": `https://github.com/${RELEASE_REPOSITORY}` } : {}),
			"X-OpenRouter-Title": APP_TITLE,
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": APP_TITLE,
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": `${APP_NAME}-coding-agent`,
		};
	}

	return undefined;
}

function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": APP_NAME };
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	_settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...getSessionHeaders(model, sessionId),
		...getProviderAttributionHeaders(model),
	};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
