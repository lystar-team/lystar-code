import { join } from "node:path";
import * as cordis from "@deepseek-ai/cordis";
import * as groups from "@deepseek-ai/cordis-plugin-group";
import * as includes from "@deepseek-ai/cordis-plugin-include";
import * as loaders from "@deepseek-ai/cordis-plugin-loader";
import * as cosmokit from "@deepseek-ai/cosmokit";
import * as agents from "@deepseek-ai/dsh-agent";
import * as loops from "@deepseek-ai/dsh-agent-loop";
import * as attachments from "@deepseek-ai/dsh-attachment";
import * as brand from "@deepseek-ai/dsh-brand";
import * as files from "@deepseek-ai/dsh-fs";
import * as localFiles from "@deepseek-ai/dsh-fs-local";
import * as homePaths from "@deepseek-ai/dsh-home-paths";
import * as launchEnvironment from "@deepseek-ai/dsh-launch-environment";
import * as llm from "@deepseek-ai/dsh-llm";
import * as scope from "@deepseek-ai/dsh-scope";
import * as sessions from "@deepseek-ai/dsh-session";
import * as projections from "@deepseek-ai/dsh-session-projection";
import * as skills from "@deepseek-ai/dsh-skill";
import * as prompts from "@deepseek-ai/dsh-system-prompt";
import * as tools from "@deepseek-ai/dsh-tools";
import * as workingDirectory from "@deepseek-ai/dsh-working-directory";
import * as schemastery from "@deepseek-ai/schemastery";
import { createModuleLoader } from "./module-loader.ts";

/** Every entry tree delegates imports to this host's module graph. */
export function createPluginImporter(home: string): {
	Loader: typeof loaders.Loader;
	modules: Record<string, unknown>;
	import: (name: string, baseUrl: string) => Promise<unknown>;
} {
	let context: cordis.Context | undefined;
	let moduleLoader: ReturnType<typeof createModuleLoader>;
	class EmbeddedLoader extends loaders.Loader {
		override internal = moduleLoader.internal;

		constructor(ctx: cordis.Context, config?: loaders.Loader.Config) {
			super(ctx, config);
			context = ctx;
		}
	}
	const ownedHome = homePaths.resolveDshHome(home);
	const virtualModules: Record<string, unknown> = {
		"@deepseek-ai/cordis": cordis,
		"@deepseek-ai/cordis-plugin-group": groups,
		"@deepseek-ai/cordis-plugin-include": includes,
		"@deepseek-ai/cordis-plugin-loader": { ...loaders, Loader: EmbeddedLoader, default: EmbeddedLoader },
		"@deepseek-ai/cosmokit": cosmokit,
		"@deepseek-ai/dsh-agent": agents,
		"@deepseek-ai/dsh-agent-loop": loops,
		"@deepseek-ai/dsh-attachment": attachments,
		"@deepseek-ai/dsh-brand": brand,
		"@deepseek-ai/dsh-fs": files,
		"@deepseek-ai/dsh-fs-local": localFiles,
		"@deepseek-ai/dsh-home-paths": {
			...homePaths,
			resolveDshHome: (configured?: string, env?: Record<string, string | undefined>) =>
				homePaths.resolveDshHome(configured ?? ownedHome, env),
			dshHomePath: (...segments: string[]) => join(ownedHome, ...segments),
			dshCachePath: (optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]) =>
				typeof optionsOrSegment === "string"
					? homePaths.dshCachePath({ dshHome: ownedHome }, optionsOrSegment, ...segments)
					: homePaths.dshCachePath(
							{ ...optionsOrSegment, dshHome: optionsOrSegment.dshHome ?? ownedHome },
							...segments,
						),
		},
		"@deepseek-ai/dsh-launch-environment": launchEnvironment,
		"@deepseek-ai/dsh-llm": llm,
		"@deepseek-ai/dsh-scope": scope,
		"@deepseek-ai/dsh-session": sessions,
		"@deepseek-ai/dsh-session-projection": projections,
		"@deepseek-ai/dsh-skill": skills,
		"@deepseek-ai/dsh-system-prompt": prompts,
		"@deepseek-ai/dsh-tools": tools,
		"@deepseek-ai/dsh-working-directory": workingDirectory,
		"@deepseek-ai/schemastery": schemastery,
	};
	moduleLoader = createModuleLoader(virtualModules, () => context?.get("pluginPackages")?.resolution);
	return {
		Loader: EmbeddedLoader,
		modules: virtualModules,
		import: async (name, baseUrl) => moduleLoader.load(name, baseUrl),
	};
}
