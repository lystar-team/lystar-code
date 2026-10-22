import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type * as AppBoot from "@deepseek-ai/dsh-app-boot";

/** The embedded loader consumes this table without replacing Node's process-wide resolvers. */
export async function mountProfileResolution(
	context: Context,
	boot: typeof AppBoot,
	initial: AppBoot.ProfileRuntimeResolution,
): Promise<void> {
	class ScopedPluginPackages extends boot.PluginPackages {
		private table: AppBoot.RuntimeResolution;
		private entries: Map<string, AppBoot.RuntimeResolutionEntry>;

		constructor(ctx: Context) {
			super(ctx);
			this.table = initial;
			this.entries = new Map(initial.entries.map((entry) => [entry.name, entry]));
		}

		override get resolution(): AppBoot.RuntimeResolution {
			return this.table;
		}

		override replace(successor: AppBoot.RuntimeResolution): void {
			this.table = successor;
			this.entries = new Map(successor.entries.map((entry) => [entry.name, entry]));
		}

		override async refresh(): Promise<void> {
			if (!(this.table instanceof boot.ProfileRuntimeResolution))
				throw new Error("DSH profile resolution cannot be recomputed");
			this.replace(await this.table.computeLatestResolution());
		}

		override packageOf(specifier: string, parentURL: string): AppBoot.PluginPackage | undefined {
			const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
			const entry = this.entries.get(name);
			if (!entry) return super.packageOf(specifier, parentURL);
			const manifestPath = join(entry.packageDir, "package.json");
			if (!existsSync(manifestPath)) return undefined;
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
			return {
				name: typeof manifest.name === "string" ? manifest.name : entry.name,
				version: typeof manifest.version === "string" ? manifest.version : undefined,
				dir: entry.packageDir,
				manifestPath,
				manifest,
			};
		}

		override metaOf(specifier: string, parentURL: string) {
			const entry = this.packageOf(specifier, parentURL);
			return super.metaOf(specifier, entry ? pathToFileURL(entry.manifestPath).href : parentURL);
		}
	}

	await context.plugin(ScopedPluginPackages).await();
}
