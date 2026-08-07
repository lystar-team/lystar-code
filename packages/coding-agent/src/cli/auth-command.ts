import type { AuthResult } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key" | "bearer_token";

export interface AuthCommand {
	kind: AuthCommandKind;
	args: string[];
	json: boolean;
	credentials: boolean;
	noRefresh: boolean;
	minExpiryMs?: number;
}

export class AuthCommandError extends Error {}

const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check --provider <provider> [--json] [--credentials] [--no-refresh]`,
	api_key: `${APP_NAME} auth print-api-key --provider <provider> [--model <model>]`,
	bearer_token: `${APP_NAME} auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]`,
};

export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check" ? "auth check" : kind === "api_key" ? "auth print-api-key" : "auth print-bearer-token";
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

export function isAuthCommandHelp(args: string[]): boolean {
	return (
		args[0] === "auth" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printAuthCommandHelp(): void {
	console.log(`用法：
  ${APP_NAME} auth print-api-key [--provider <provider>] [--model <model>]
  ${APP_NAME} auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]
  ${APP_NAME} auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

认证命令至少需要 --provider 或 --model。auth check 默认刷新已过期的 OAuth 凭据；--no-refresh 禁止刷新。--credentials 直接输出凭据，配合 --json 时写入 JSON。`);
}

export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind =
		args[1] === "check"
			? "check"
			: args[1] === "print-api-key"
				? "api_key"
				: args[1] === "print-bearer-token"
					? "bearer_token"
					: undefined;
	if (!kind) {
		throw new AuthCommandError(
			`未知 auth 命令“${args[1] ?? ""}”。请使用“${APP_NAME} auth print-api-key”、“${APP_NAME} auth print-bearer-token”或“${APP_NAME} auth check”。`,
		);
	}

	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--min-expiry") {
			if (kind !== "bearer_token")
				throw new AuthCommandError("--min-expiry 仅支持 print-bearer-token");
			const value = args[++index];
			const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
			if (!match) throw new AuthCommandError("--min-expiry 必须使用 30m 或 1h 这类时长格式");
			const amount = Number(match[1]);
			const unit = match[2];
			minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
			continue;
		}
		if (arg === "--json" || arg === "--credentials" || arg === "--no-refresh") {
			if (kind !== "check") throw new AuthCommandError(`${arg} 仅支持 auth check`);
			if (arg === "--json") json = true;
			else if (arg === "--credentials") credentials = true;
			else noRefresh = true;
			continue;
		}
		commandArgs.push(arg);
	}

	return minExpiryMs === undefined
		? { kind, args: commandArgs, json, credentials, noRefresh }
		: { kind, args: commandArgs, json, credentials, noRefresh, minExpiryMs };
}

export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`auth 命令“${getAuthCommandName(kind)}”不支持参数 --${option}。`);
	}
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError("auth 命令只接受 --provider 和 --model");
	}
	if (kind === "check") {
		if (!provider && !model) {
			throw new AuthCommandError("检查认证需要 --provider <provider> 或 --model <model>");
		}
		return { provider, model };
	}
	if (!provider && !model) {
		throw new AuthCommandError("输出凭据需要 --provider <provider> 或 --model <model>");
	}
	return { provider, model };
}

export function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
