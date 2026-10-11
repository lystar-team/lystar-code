import { type AnyModel, type Api, isModelType, type Model, type Provider } from "@earendil-works/pi-ai";
import { ModelsDevCatalog } from "@earendil-works/pi-ai/utils/models-dev";
import type { AuthStorageBackend } from "./auth-storage.ts";
import type { ModelsJsonProvider } from "./model-config.ts";
import { applyModelOverride, type ProviderConfigInput } from "./provider-composer.ts";

/** 使用现有原子写入和文件锁保存目录，不写用户的模型配置。 */
export class ModelMetadataStore {
	private readonly storage: AuthStorageBackend;

	constructor(storage: AuthStorageBackend) {
		this.storage = storage;
	}

	read(signal?: AbortSignal): Promise<ModelsDevCatalog | undefined> {
		return this.storage.withLockAsync(
			async (content) => {
				if (!content) return { result: undefined };
				const value = JSON.parse(content) as { catalog?: unknown; checkedAt?: unknown };
				if (value.catalog === undefined) return { result: undefined };
				if (typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) {
					throw new Error("models.dev 缓存缺少有效的更新时间");
				}
				return { result: new ModelsDevCatalog(value.catalog, value.checkedAt) };
			},
			{ signal },
		);
	}

	write(catalog: ModelsDevCatalog, signal?: AbortSignal): Promise<void> {
		return this.storage.withLockAsync(
			async () => ({
				result: undefined,
				next: JSON.stringify({ catalog: catalog.toJSON(), checkedAt: catalog.checkedAt }),
			}),
			{ signal },
		);
	}
}

/** 能力补齐不改变供应商的认证、协议、请求地址和模型过滤逻辑。 */
export function withModelMetadata(
	provider: Provider,
	readCatalog: () => ModelsDevCatalog | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Provider {
	const definitions = new Map(config?.models?.map((model) => [model.id, model]));
	const synced = new Set(config?.syncedModels ?? []);
	const extensionModelIds = new Set(extension?.models?.map((model) => model.id));
	let previousModels: readonly AnyModel[] | undefined;
	let previousCatalog: ModelsDevCatalog | undefined;
	let enriched: readonly AnyModel[] = [];
	const getAllModels = (): readonly AnyModel[] => {
		const models = provider.getAllModels?.() ?? provider.getModels();
		const catalog = readCatalog();
		if (!catalog) return models;
		if (models === previousModels && catalog === previousCatalog) return enriched;
		previousModels = models;
		previousCatalog = catalog;
		enriched = models.map((model): AnyModel => {
			if (!isModelType(model, "chat")) return model;
			// 扩展提供完整模型定义；保留其静态或刷新后的能力，而不是重放旧定义。
			if (extensionModelIds.has(model.id) || extension?.refreshModels) return model;
			const metadata = catalog.find(model.id, config?.catalogProvider ?? provider.id);
			if (!metadata) return model;
			let updated: Model<Api> = {
				...model,
				...metadata,
				cost: metadata.cost ? { ...model.cost, ...metadata.cost } : model.cost,
				thinkingLevelMap: metadata.thinkingLevelMap
					? { ...model.thinkingLevelMap, ...metadata.thinkingLevelMap }
					: model.thinkingLevelMap,
			};
			const definition = definitions.get(model.id);
			if (definition && !synced.has(model.id)) updated = applyModelOverride(updated, definition);
			const override = config?.modelOverrides?.[model.id];
			return override ? applyModelOverride(updated, override) : updated;
		});
		return enriched;
	};
	return {
		...provider,
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
	};
}
