import type { Api, CredentialInfo, Model } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";

export type CredentialPrintKind = "api_key" | "bearer_token";

const DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS = 30 * 60_000;

export interface CredentialPrintCommand {
	kind: CredentialPrintKind;
	args: string[];
	minExpiryMs?: number;
}

export class CredentialPrintError extends Error {}

export function isCredentialPrintHelp(args: string[]): boolean {
	return (
		args[0] === "auth" && (args[1] === undefined || args[1] === "help" || args[1] === "--help" || args[1] === "-h")
	);
}

export function printCredentialPrintHelp(): void {
	console.log(`用法：
  ${APP_NAME} auth print-api-key --model <model> [--provider <provider>]
  ${APP_NAME} auth print-bearer-token --model <model> [--provider <provider>] [--min-expiry <duration>]

仅向 stdout 输出已配置的凭据。默认根据已配置凭据判断 Provider，也可用 --provider 明确指定。Bearer token 默认至少需要 30 分钟有效期。--min-expiry 支持 ms、s、m、h，例如 30m。`);
}

/** Parse the small, extensible `pi auth` command surface before normal startup. */
export function parseCredentialPrintCommand(args: string[]): CredentialPrintCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind = args[1] === "print-api-key" ? "api_key" : args[1] === "print-bearer-token" ? "bearer_token" : undefined;
	if (!kind) {
		throw new CredentialPrintError(
			`未知 auth 命令“${args[1] ?? ""}”。请使用“${APP_NAME} auth print-api-key”或“${APP_NAME} auth print-bearer-token”。`,
		);
	}

	const commandArgs: string[] = [];
	let minExpiryMs: number | undefined;
	for (let index = 2; index < args.length; index++) {
		if (args[index] !== "--min-expiry") {
			commandArgs.push(args[index]);
			continue;
		}
		if (kind !== "bearer_token") {
			throw new CredentialPrintError("--min-expiry 仅支持 print-bearer-token");
		}
		const value = args[++index];
		const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
		if (!match) {
			throw new CredentialPrintError("--min-expiry 必须使用 30m 或 1h 这类时长格式");
		}
		const amount = Number(match[1]);
		const unit = match[2];
		minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
	}

	return minExpiryMs === undefined ? { kind, args: commandArgs } : { kind, args: commandArgs, minExpiryMs };
}

export function validateCredentialPrintArgs(args: Args): void {
	if (!args.model?.trim()) {
		throw new CredentialPrintError("输出凭据需要 --model <model>");
	}
	if (args.apiKey !== undefined) {
		throw new CredentialPrintError("输出凭据只读取已配置的凭据，不支持 --api-key");
	}
	if (args.messages.length > 0 || args.fileArgs.length > 0 || args.unknownFlags.size > 0) {
		throw new CredentialPrintError("输出凭据只接受 --provider 和 --model 参数");
	}
}

/**
 * Resolve one request credential for a specific provider/model pair.
 *
 * This intentionally calls ModelRuntime.getAuth(), which refreshes and persists
 * OAuth credentials with less than five minutes remaining through the normal request-auth path.
 */
export async function resolveCredentialForPrint(
	args: Args,
	modelRuntime: ModelRuntime,
	kind: CredentialPrintKind,
	minExpiryMs?: number,
): Promise<string> {
	validateCredentialPrintArgs(args);

	const credentialTypes = new Map<string, CredentialInfo["type"]>(
		(await modelRuntime.listCredentials()).map((credential) => [credential.providerId, credential.type]),
	);
	const models: Model<Api>[] = [];
	if (args.provider) {
		const resolved = resolveCliModel({ cliProvider: args.provider, cliModel: args.model, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new CredentialPrintError(resolved.error ?? "无法确定请求的 Provider 或模型");
		}
		models.push(resolved.model);
	} else {
		for (const provider of modelRuntime.getProviders()) {
			if (!credentialTypes.has(provider.id)) continue;
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: args.model, modelRuntime });
			if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
				models.push(resolved.model);
			}
		}
		if (models.length === 0) {
			throw new CredentialPrintError(`找不到模型“${args.model}”。可用 --list-models 查看模型列表。`);
		}
	}

	const credentials: Array<{ providerId: string; value: string }> = [];
	for (const model of models) {
		const type = credentialTypes.get(model.provider);
		if (kind === "api_key" && type === "oauth") continue;
		if (kind === "bearer_token" && type !== "oauth") continue;

		const auth = await modelRuntime.getAuth(
			model,
			kind === "bearer_token"
				? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS }
				: undefined,
		);
		const authorization = Object.entries(auth?.auth.headers ?? {}).find(
			([name]) => name.toLowerCase() === "authorization",
		)?.[1];
		const bearerToken = typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
		const value = kind === "bearer_token" ? (auth?.auth.apiKey ?? bearerToken) : auth?.auth.apiKey;
		if (value) credentials.push({ providerId: model.provider, value });
	}

	if (credentials.length === 1) return credentials[0].value;
	if (credentials.length === 0) {
		const providerId = models[0]?.provider;
		const type = providerId ? credentialTypes.get(providerId) : undefined;
		if (args.provider && kind === "api_key" && type === "oauth") {
			throw new CredentialPrintError(`Provider“${providerId}”使用 OAuth，没有配置 API key`);
		}
		if (args.provider && kind === "bearer_token" && type !== "oauth") {
			throw new CredentialPrintError(`Provider“${providerId}”没有配置 OAuth bearer token`);
		}
		throw new CredentialPrintError(`没有可用的${kind === "api_key" ? " API key" : " OAuth bearer token"}`);
	}
	throw new CredentialPrintError(
		`模型“${args.model}”匹配多个已配置 Provider（${credentials.map(({ providerId }) => providerId).join(", ")}）。请使用 --provider 明确指定。`,
	);
}
