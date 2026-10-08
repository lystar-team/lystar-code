import { APP_TITLE, CONFIG_DIR_NAME } from "../config.ts";
import { emitProjectTrustEvent } from "./extensions/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
	forcePrompt?: boolean;
	reason?: string;
}

function formatProjectTrustPrompt(cwd: string, reason?: string): string {
	return `是否信任项目目录？\n${cwd}${reason ? `\n\n${reason}` : ""}\n\n信任后，${APP_TITLE} 可以加载项目级 ${CONFIG_DIR_NAME} 设置和资源、安装缺失的项目 Package，并执行项目 Extension。`;
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
	reason?: string,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd, reason),
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === selected);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined && !options.forcePrompt) {
		return options.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		return true;
	}

	if (!options.forcePrompt && options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: options.cwd },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension“${error.extensionPath}”处理项目可信状态失败：${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(options.cwd, trusted);
			}
			return trusted;
		}
	}

	const decision = options.forcePrompt ? null : options.trustStore.get(options.cwd);
	if (decision !== null) return decision;

	if (!options.forcePrompt) {
		switch (options.defaultProjectTrust ?? "ask") {
			case "always":
				return true;
			case "never":
				return false;
			case "ask":
				break;
		}
	}

	if (!options.projectTrustContext.hasUI) return false;

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext, options.reason);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return false;
}
