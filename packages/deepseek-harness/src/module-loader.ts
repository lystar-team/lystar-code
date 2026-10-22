import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModuleJob, ModuleLoaderV2, ModuleRequest, ResolveResult } from "@deepseek-ai/cordis-plugin-loader";
import type { RuntimeResolution } from "@deepseek-ai/dsh-app-boot";
import { createJiti, type NodeModule as JitiModule } from "jiti/static";

/** One module graph per embedded host, exposed through Cordis' loader contract. */
export function createModuleLoader(
	virtualModules: Record<string, unknown>,
	packages?: () => RuntimeResolution | undefined,
): {
	load(name: string, baseUrl: string): unknown;
	internal: ModuleLoaderV2;
} {
	const importers = new Map<string, ReturnType<typeof createJiti>>();
	const cache: Record<string, JitiModule> = Object.create(null);
	const jobs = new Map<string, Record<string, ModuleJob>>();
	const get = jobs.get.bind(jobs);
	const put = jobs.set.bind(jobs);
	const has = jobs.has.bind(jobs);
	const loadCache: ModuleLoaderV2["loadCache"] = Object.assign(jobs, {
		get(url: string, type = "javascript"): ModuleJob | undefined {
			return get(url)?.[type];
		},
		set(url: string, type = "javascript", job?: ModuleJob) {
			if (job) put(url, { ...get(url), [type]: job });
			return loadCache;
		},
		has(url: string, type?: string): boolean {
			return type === undefined ? has(url) : get(url)?.[type] !== undefined;
		},
	});

	function importer(baseUrl: string) {
		let instance = importers.get(baseUrl);
		if (!instance) {
			instance = createJiti(baseUrl, { interopDefault: true, moduleCache: false, tryNative: false, virtualModules });
			importers.set(baseUrl, instance);
		}
		return instance;
	}

	function resolve(name: string, baseUrl: string): ResolveResult {
		if (Object.hasOwn(virtualModules, name)) return { url: `lystar-dsh:${name}`, format: "module" };
		if (isBuiltin(name)) return { url: name.startsWith("node:") ? name : `node:${name}`, format: "builtin" };
		const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
		const entry = packages?.()?.entries.findLast((entry) => entry.name === packageName);
		const anchor = entry ? pathToFileURL(join(entry.packageDir, "package.json")).href : baseUrl;
		const url = importer(anchor).esmResolve(name);
		return { url, format: url.endsWith(".json") ? "json" : "module" };
	}

	function remember(url: string, namespace: unknown, record?: JitiModule): ModuleJob {
		const found = loadCache.get(url);
		if (found) return found;
		const module = { url, getNamespace: () => namespace };
		const job: ModuleJob = {
			url,
			loader: internal,
			module,
			importAttributes: {},
			get linked() {
				return Promise.resolve(
					(record?.children ?? []).flatMap((child) => {
						const linked = loadCache.get(pathToFileURL(child.filename).href);
						return linked ? [linked] : [];
					}),
				);
			},
			async instantiate() {},
			async run() {
				return { module };
			},
		};
		loadCache.set(url, "javascript", job);
		return job;
	}

	function load(name: string, baseUrl: string): unknown {
		if (Object.hasOwn(virtualModules, name)) return virtualModules[name];
		const target = resolve(name, baseUrl);
		if (target.format === "builtin" || target.format === "json") return importer(baseUrl)(name);
		for (const filename of Object.keys(cache)) {
			if (!loadCache.has(pathToFileURL(filename).href)) delete cache[filename];
		}
		const filename = fileURLToPath(target.url);
		if (!cache[filename])
			importer(baseUrl).evalModule(readFileSync(filename, "utf8"), {
				filename,
				cache,
				async: false,
				forceTranspile: true,
			});
		for (const [path, record] of Object.entries(cache)) remember(pathToFileURL(path).href, record.exports, record);
		return cache[filename].exports;
	}

	const internal: ModuleLoaderV2 = {
		version: "v2",
		loadCache,
		async import(name, baseUrl) {
			return load(name, baseUrl);
		},
		register(): never {
			throw new Error("内嵌 DSH 使用独立模块加载器，不支持注册 Node 全局模块钩子");
		},
		async getOrCreateModuleJob(baseUrl: string, request: ModuleRequest) {
			const namespace = load(request.specifier, baseUrl);
			const target = resolve(request.specifier, baseUrl);
			return remember(target.url, namespace);
		},
		resolveSync(baseUrl, request) {
			return resolve(request.specifier, baseUrl);
		},
		async load(url) {
			return {
				format: url.startsWith("node:") ? "builtin" : url.endsWith(".json") ? "json" : "module",
				...(url.startsWith("file:") ? { source: readFileSync(fileURLToPath(url), "utf8") } : {}),
			};
		},
	};
	return { load, internal };
}
