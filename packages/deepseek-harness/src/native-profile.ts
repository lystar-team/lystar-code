import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import type * as AppBoot from "@deepseek-ai/dsh-app-boot";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import type { PluginManager } from "@deepseek-ai/dsh-plugin-manager";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { DSH_VERSION } from "./config.ts";
import { createPluginImporter } from "./importer.ts";
import type { HarnessOptions } from "./index.ts";
import { mountProfileResolution } from "./profile-resolution.ts";

export type NativeProfileName = "web" | "headless";
const bundles: Record<NativeProfileName, readonly string[]> = {
	web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
	headless: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
};
const execute = promisify(execFile);

export function nativeProfileDirectory(directory: string, name: NativeProfileName): string {
	return join(directory, "profiles", name);
}

function nativePackageManagerCommand(npmCommand: readonly string[]) {
	const command = npmCommand[0];
	if (!command) throw new Error("npmCommand 不能为空");
	return {
		command,
		// 原版 YAML 用 createRequire(baseUrl) 定位资源包，Profile 需要可直接解析的依赖目录。
		args: [
			...npmCommand.slice(1),
			"exec",
			"--yes",
			"--ignore-scripts",
			"--package=pnpm@11.28.5",
			"--",
			"pnpm",
			"--config.node-linker=hoisted",
			"--config.auto-install-peers=true",
		],
	};
}

/** Bootstrap original bundles; subsequent bundle operations belong to their original manager. */
export async function installNativeProfile(
	directory: string,
	name: NativeProfileName,
	npmCommand: readonly string[] = ["npm"],
): Promise<void> {
	const profile = nativeProfileDirectory(directory, name);
	mkdirSync(profile, { recursive: true });
	const filename = join(profile, "package.json");
	if (!existsSync(filename)) writeFileSync(filename, '{"private":true,"type":"module","dependencies":{}}\n');
	const manager = nativePackageManagerCommand(npmCommand);
	await execute(
		manager.command,
		[
			...manager.args,
			"--dir",
			profile,
			"add",
			"--save-exact",
			"--ignore-scripts",
			...[...bundles[name], "@deepseek-ai/dsh-app-boot"].map((bundle) => `${bundle}@${DSH_VERSION}`),
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	);
	const bootstrap = (await createPluginImporter(directory).import(
		"@deepseek-ai/dsh-app-boot",
		pathToFileURL(filename).href,
	)) as typeof AppBoot;
	bootstrap.initProfile(profile, bundles[name]);
	const manifest = JSON.parse(readFileSync(filename, "utf8")) as {
		name?: string;
		version?: string;
		dsh?: { profile?: { bundles?: string[] } };
	};
	manifest.name ??= `lystar-dsh-${name}`;
	manifest.version = DSH_VERSION;
	manifest.dsh ??= {};
	manifest.dsh.profile ??= {};
	manifest.dsh.profile.bundles = [...new Set([...bundles[name], ...(manifest.dsh.profile.bundles ?? [])])];
	writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** 沿用原版界面的更新顺序：卸载旧 Bundle，再安装目标版本，并保留启停选择。 */
export async function updateNativeBundle(manager: PluginManager, spec: string) {
	const current = (await manager.listBundles()).find(
		(bundle) =>
			bundle.installed && (bundle.name === spec || spec.startsWith(`${bundle.name}@`) || bundle.source === spec),
	);
	if (!current) throw new Error(`DSH Bundle 尚未安装：${spec}`);
	const target = spec === current.name ? (current.installTarget?.spec ?? spec) : spec;
	const removed = await manager.removeBundle(current.name);
	if (removed.application === "failed" || removed.application === "cancelled") return removed;
	return manager.installBundle(target, { saveExact: true, enabled: current.enabled });
}

export interface MountedNativeProfile {
	commitReady(): void;
	manager(): PluginManager;
	defaultPreset(): string | undefined;
	setupAgent(context: Context, preset?: string): Promise<void>;
	sessionInfo(id: SessionId): Promise<{ exists: boolean; preset?: string }>;
	webUrl(): string | undefined;
}

/** Use original profile resolution and composition while LYStar owns process lifetime. */
export async function mountNativeProfile(
	context: Context,
	importer: ReturnType<typeof createPluginImporter>,
	options: HarnessOptions,
	name: NativeProfileName,
): Promise<MountedNativeProfile> {
	const directory = nativeProfileDirectory(options.directory, name);
	const bootstrapAnchor = join(directory, "package.json");
	if (!existsSync(bootstrapAnchor)) throw new Error(`请先运行 /dsh profile ${name}`);
	const installAnchor = join(options.directory, "runtime", "package.json");
	mkdirSync(dirname(installAnchor), { recursive: true });
	writeFileSync(
		installAnchor,
		`${JSON.stringify({ name: "lystar-dsh-runtime", version: DSH_VERSION, private: true, type: "module", dependencies: {} }, null, 2)}\n`,
	);
	const boot = (await importer.import(
		"@deepseek-ai/dsh-app-boot",
		pathToFileURL(bootstrapAnchor).href,
	)) as typeof AppBoot;
	importer.modules["@deepseek-ai/dsh-app-boot"] = boot;
	const profile = boot.loadProfileDirectory("LYStar DSH", directory, installAnchor);
	if (profile.skippedBundles.length)
		throw new Error(`DSH profile bundles could not load: ${JSON.stringify(profile.skippedBundles)}`);
	const resolution = await boot.createRuntimeResolution({ installAnchor, profile, home: options.directory });
	const readyListeners = new Set<() => void>();
	let ready = false;
	let exitCode: number | undefined;
	const npmCommand = options.npmCommand ?? ["npm"];
	const environment = Object.fromEntries(
		Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
	);
	const profileContext: AppBoot.ProfileContext = {
		name,
		dir: directory,
		patchPath: profile.patchPath,
		installAnchor,
		cwd: options.cwd,
		home: options.directory,
		startedBundles: profile.layers.map((layer) => layer.packageName),
		// 主循环由 LYStar 调用；原版 headless 的一次性命令入口会要求 argv 任务并退出进程。
		overlays:
			name === "web"
				? [{ id: "web-runtime", config: { printUrl: false, openBrowser: false } }]
				: [
						{ id: "headless-startup", disabled: true },
						{ id: "headless-runner", disabled: true },
					],
		telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
		packageManager: { ...nativePackageManagerCommand(npmCommand), env: environment },
	};
	context.provide("dshHomePath", (...parts: string[]) => join(options.directory, ...parts));
	context.provide("profileContext", profileContext);
	context.provide("launchEnvironment", createLaunchEnvironmentSnapshot([{ source: "process", values: environment }]));
	context.provide("cmdlineArgs", {
		get: () => (name === "web" ? ["--host", "127.0.0.1", "--port", "0", "--no-open"] : []),
	});
	context.provide("appReady", {
		onReady(listener: () => void) {
			if (ready) {
				listener();
				return () => {};
			}
			readyListeners.add(listener);
			return () => {
				readyListeners.delete(listener);
			};
		},
	});
	context.provide("appExit", (code: number) => {
		exitCode = code;
		void context.fiber.dispose().catch((error: unknown) => options.warn?.(String(error)));
	});
	await mountProfileResolution(context, boot, resolution);
	const configPath = join(directory, "cordis.yml");
	writeFileSync(configPath, "[]\n");
	const patches = boot.readProfilePatches("LYStar DSH", profileContext, profile);
	await boot.mountRootInclude(context, configPath, patches, undefined, "LYStar DSH");
	await context.loader.await();
	await boot.auditStartupEntries(context, "LYStar DSH", options.warn);
	if (exitCode !== undefined) throw new Error(`DSH profile exited during startup (${exitCode})`);
	const workspaces = context.get("workspaceController") as
		| { create(request: { path: string }): Promise<unknown> }
		| undefined;
	await workspaces?.create({ path: options.cwd });
	return {
		commitReady() {
			if (ready) return;
			ready = true;
			for (const listener of [...readyListeners]) listener();
			readyListeners.clear();
		},
		defaultPreset() {
			return (context.get("agentPresets") as { defaultId: string } | undefined)?.defaultId;
		},
		async setupAgent(agentContext, preset) {
			const presets = context.get("agentPresets") as
				| { mount(context: Context, preset?: string): Promise<unknown> }
				| undefined;
			await presets?.mount(agentContext, preset);
		},
		async sessionInfo(id) {
			const query = context.get("sessionQuery") as
				| { observeSession(id: SessionId): Promise<Disposable & { header: { agentPreset?: string } }> }
				| undefined;
			if (!query) throw new Error("DSH session query service is unavailable");
			try {
				const observation = await query.observeSession(id);
				try {
					return { exists: true, preset: observation.header.agentPreset };
				} finally {
					observation[Symbol.dispose]();
				}
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "SESSION_QUERY_SESSION_NOT_FOUND"
				)
					return { exists: false };
				throw error;
			}
		},
		manager() {
			const manager = context.get("pluginManager");
			if (!manager) throw new Error("DSH plugin manager is unavailable");
			return manager;
		},
		webUrl() {
			const app = context.get("webApp") as { getAdvertisedUrl(): string } | undefined;
			const connection = context.get("connection") as { authenticatedUrl(url: string): string } | undefined;
			return app && connection ? connection.authenticatedUrl(app.getAdvertisedUrl()) : undefined;
		},
	};
}
