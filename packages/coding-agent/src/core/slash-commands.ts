import { APP_NAME } from "../config.ts";
import { t } from "../locales/zh-CN.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: t("command.settings") },
	{ name: "model", description: t("command.model"), argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: t("command.scopedModels") },
	{ name: "export", description: t("command.export") },
	{ name: "import", description: t("command.import") },
	{ name: "share", description: t("command.share") },
	{ name: "copy", description: t("command.copy") },
	{ name: "name", description: t("command.name") },
	{ name: "session", description: t("command.session") },
	{ name: "changes", description: t("command.changes") },
	{ name: "changelog", description: t("command.changelog") },
	{ name: "hotkeys", description: t("command.hotkeys") },
	{ name: "fork", description: t("command.fork") },
	{ name: "clone", description: t("command.clone") },
	{ name: "tree", description: t("command.tree") },
	{ name: "trust", description: t("command.trust") },
	{ name: "login", description: t("command.login"), argumentHint: "<provider>" },
	{ name: "logout", description: t("command.logout") },
	{ name: "new", description: t("command.new") },
	{ name: "compact", description: t("command.compact") },
	{ name: "resume", description: t("command.resume") },
	{ name: "reload", description: t("command.reload") },
	{ name: "quit", description: t("command.quit", { app: APP_NAME }) },
];
