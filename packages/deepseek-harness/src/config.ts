import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { applyEntryPatches, entryListSchema, type PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import type { DshPackageManifest } from "@deepseek-ai/dsh-package-manifest";
import { load } from "js-yaml";
import { satisfies, validRange } from "semver";
import type { NativeProfileName } from "./native-profile.ts";

export const DSH_VERSION = "0.2.1-rc.2";
const execute = promisify(execFile);

export interface PluginSelection {
	name: string;
	config?: unknown;
	disabled?: boolean;
}

export interface HarnessConfig {
	plugins: PluginSelection[];
	profile?: NativeProfileName;
}

export function readHarnessConfig(directory: string): HarnessConfig {
	const filename = join(directory, "plugins.json");
	if (!existsSync(filename)) return { plugins: [] };
	const value: unknown = JSON.parse(readFileSync(filename, "utf8"));
	if (!value || typeof value !== "object" || !("plugins" in value) || !Array.isArray(value.plugins)) {
		throw new Error(`${filename} 的 plugins 必须是数组`);
	}
	const plugins: PluginSelection[] = value.plugins.map((plugin: unknown) => {
		if (!plugin || typeof plugin !== "object" || !("name" in plugin) || typeof plugin.name !== "string") {
			throw new Error(`${filename} 包含缺少 name 的插件`);
		}
		if ("disabled" in plugin && typeof plugin.disabled !== "boolean")
			throw new Error(`${plugin.name} 的 disabled 必须是布尔值`);
		return plugin as PluginSelection;
	});
	const profile = "profile" in value ? value.profile : undefined;
	if (profile !== undefined && profile !== "web" && profile !== "headless")
		throw new Error(`${filename} 的 profile 必须是 web 或 headless`);
	return { plugins, ...(profile === undefined ? {} : { profile }) };
}

export function writeHarnessConfig(directory: string, config: HarnessConfig): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "plugins.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export function resolvePluginPackage(directory: string, name: string): { root: string; manifest: DshPackageManifest } {
	const require = createRequire(join(directory, "package.json"));
	let root: string;
	if (isAbsolute(name) || name.startsWith(".") || name.startsWith("file:")) {
		const target = name.startsWith("file:") ? fileURLToPath(name) : resolve(directory, name);
		root = existsSync(join(target, "package.json")) ? target : dirname(target);
	} else {
		try {
			root = dirname(require.resolve(`${name}/package.json`));
		} catch {
			root = dirname(require.resolve(name));
			while (!existsSync(join(root, "package.json"))) {
				const parent = dirname(root);
				if (parent === root) throw new Error(`无法读取 ${name} 的 package.json`);
				root = parent;
			}
		}
	}
	return { root, manifest: JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as DshPackageManifest };
}

function assertCompatible(manifest: DshPackageManifest): void {
	const range = manifest.engines?.dsh;
	if (range !== undefined && (!validRange(range) || !satisfies(DSH_VERSION, range, { includePrerelease: true }))) {
		throw new Error(`${manifest.name} 要求 DSH ${range}，内嵌版本为 ${DSH_VERSION}`);
	}
}

/** Read original DSH bundle patches with its own YAML dialect and patch implementation. */
export function composePluginEntries(
	directory: string,
	config: HarnessConfig,
	warn: (message: string) => void,
	anchors: Map<string, string> = new Map(),
): EntryOptions[] {
	const patches: PatchOptions[] = [];
	const direct: EntryOptions[] = [];
	for (const selection of config.plugins) {
		if (selection.disabled) continue;
		const { root, manifest } = resolvePluginPackage(directory, selection.name);
		assertCompatible(manifest);
		const patch = manifest.dsh?.bundle?.patch;
		if (patch === undefined) {
			direct.push({ id: selection.name, name: selection.name, config: selection.config });
			continue;
		}
		const files = typeof patch === "string" ? [patch] : patch;
		if (!Array.isArray(files) || files.some((file) => typeof file !== "string"))
			throw new Error(`${selection.name} 的 dsh.bundle.patch 无效`);
		for (const filename of files) {
			const source = resolve(root, filename);
			const parsed: unknown = load(readFileSync(source, "utf8"), { schema: entryListSchema });
			if (!Array.isArray(parsed)) throw new Error(`${source} 必须是 DSH patch 数组`);
			const rows = parsed as PatchOptions[];
			let anonymous = 0;
			function remember(entries: EntryOptions[]): void {
				for (const entry of entries) {
					entry.id ??= `${selection.name}:${filename}:${anonymous++}`;
					anchors.set(entry.id, pathToFileURL(source).href);
					if (entry.group && Array.isArray(entry.config)) remember(entry.config as EntryOptions[]);
				}
			}
			for (const row of rows) if (row.insert) remember(row.insert);
			patches.push(...rows);
		}
	}
	const overlay = join(directory, "cordis.patch.yml");
	if (existsSync(overlay)) {
		const parsed: unknown = load(readFileSync(overlay, "utf8"), { schema: entryListSchema });
		if (!Array.isArray(parsed)) throw new Error(`${overlay} 必须是 DSH patch 数组`);
		patches.push(...(parsed as PatchOptions[]));
	}
	return applyEntryPatches(direct, patches, warn);
}

export async function installHarnessPlugin(
	directory: string,
	spec: string,
	npmCommand: readonly string[] = ["npm"],
): Promise<string> {
	mkdirSync(directory, { recursive: true });
	const packageFile = join(directory, "package.json");
	if (!existsSync(packageFile)) writeFileSync(packageFile, '{"private":true,"dependencies":{}}\n');
	if (!spec.trim() || spec.startsWith("-")) throw new Error("请提供插件包名、版本或本地包路径");
	const before = JSON.parse(readFileSync(packageFile, "utf8")) as { dependencies?: Record<string, string> };
	const command = npmCommand[0];
	if (!command) throw new Error("npmCommand 不能为空");
	await execute(
		command,
		[
			...npmCommand.slice(1),
			"install",
			"--prefix",
			directory,
			"--save-exact",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			spec,
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	);
	const after = JSON.parse(readFileSync(packageFile, "utf8")) as { dependencies?: Record<string, string> };
	const changed = Object.keys(after.dependencies ?? {}).filter(
		(name) => before.dependencies?.[name] !== after.dependencies?.[name],
	);
	const name =
		changed.length === 1
			? changed[0]
			: Object.keys(after.dependencies ?? {}).find((name) => spec === name || spec.startsWith(`${name}@`));
	if (!name) throw new Error("插件已安装，但无法确定入口；请使用 /dsh enable <包名>");
	const config = readHarnessConfig(directory);
	if (!config.plugins.some((plugin) => plugin.name === name)) config.plugins.push({ name });
	writeHarnessConfig(directory, config);
	return name;
}
