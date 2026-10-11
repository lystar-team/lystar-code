import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "../types.ts";
import { raceWithAbortSignal } from "./abort.ts";

export type ModelsDevReasoningOption =
	| { type: "toggle" }
	| {
			type: "effort";
			values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null>;
	  }
	| { type: "budget_tokens"; min?: number; max?: number };

export interface ModelsDevModelMetadata {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Partial<Model<Api>["cost"]>;
	thinkingLevelMap?: ThinkingLevelMap;
}

const THINKING_LEVELS: readonly Exclude<ThinkingLevel, "ultra">[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const CACHE_TTL_MS = 60 * 60 * 1000;

/** models.dev 的 effort 值与界面级别一一对应，不把 default/null 当作可选级别。 */
export function getEffortThinkingLevelMap(options: readonly ModelsDevReasoningOption[]): ThinkingLevelMap | undefined {
	const effortValues = options.flatMap((option) => (option.type === "effort" ? option.values : []));
	if (effortValues.length === 0) return undefined;
	const supported = new Set(effortValues);
	if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return undefined;
	const map: ThinkingLevelMap = { off: supported.has("none") ? "none" : null };
	for (const level of THINKING_LEVELS) map[level] = supported.has(level) ? level : null;
	return map;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function rate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reasoningOptions(value: unknown): ModelsDevReasoningOption[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): ModelsDevReasoningOption[] => {
		const option = record(item);
		if (option?.type === "toggle") return [{ type: "toggle" }];
		if (option?.type === "budget_tokens") return [{ type: "budget_tokens" }];
		if (option?.type !== "effort" || !Array.isArray(option.values)) return [];
		const values = option.values.filter(
			(level): level is Extract<ModelsDevReasoningOption, { type: "effort" }>["values"][number] =>
				level === null ||
				level === "none" ||
				level === "default" ||
				(typeof level === "string" && THINKING_LEVELS.some((candidate) => candidate === level)),
		);
		return [{ type: "effort", values }];
	});
}

function metadataFromModel(value: Record<string, unknown>): ModelsDevModelMetadata {
	const limit = record(value.limit);
	const modalities = record(value.modalities);
	const input = Array.isArray(modalities?.input)
		? modalities.input.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image")
		: undefined;
	const contextWindow = positiveInteger(limit?.context);
	const maxTokens = positiveInteger(limit?.output);
	const options = reasoningOptions(value.reasoning_options);
	const thinkingLevelMap = getEffortThinkingLevelMap(options);
	if (thinkingLevelMap) {
		thinkingLevelMap.ultra = null;
		// toggle 允许关闭思考，但不代表 API 接受 effort=none；沿用接口已有关闭方式。
		if (options.some((option) => option.type === "toggle")) delete thinkingLevelMap.off;
	}
	const sourceCost = record(value.cost);
	const inputCost = rate(sourceCost?.input);
	const outputCost = rate(sourceCost?.output);
	const cacheRead = rate(sourceCost?.cache_read);
	const cacheWrite = rate(sourceCost?.cache_write);
	const cost: Partial<Model<Api>["cost"]> | undefined =
		inputCost !== undefined && outputCost !== undefined
			? {
					input: inputCost,
					output: outputCost,
					...(cacheRead === undefined ? {} : { cacheRead }),
					...(cacheWrite === undefined ? {} : { cacheWrite }),
				}
			: undefined;
	if (cost && Array.isArray(sourceCost?.tiers)) {
		const tiers = sourceCost.tiers.flatMap((rawTier): NonNullable<Model<Api>["cost"]["tiers"]> => {
			const tier = record(rawTier);
			const threshold = record(tier?.tier);
			const inputTokensAbove = threshold?.type === "context" ? positiveInteger(threshold.size) : undefined;
			const input = rate(tier?.input);
			const output = rate(tier?.output);
			const cacheRead = rate(tier?.cache_read) ?? cost.cacheRead;
			const cacheWrite = rate(tier?.cache_write) ?? cost.cacheWrite;
			if (
				inputTokensAbove === undefined ||
				input === undefined ||
				output === undefined ||
				cacheRead === undefined ||
				cacheWrite === undefined
			)
				return [];
			return [
				{
					inputTokensAbove,
					input,
					output,
					cacheRead,
					cacheWrite,
				},
			];
		});
		if (tiers.length) cost.tiers = tiers;
	}
	return {
		...(typeof value.name === "string" && value.name ? { name: value.name } : {}),
		...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
		...(input?.length ? { input } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(cost ? { cost } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

interface CatalogEntry {
	provider: string;
	id: string;
	canonicalId?: string;
	metadata: ModelsDevModelMetadata;
}

/** 只匹配精确 ID；同名多供应商存在差异时只返回一致的能力字段。 */
export class ModelsDevCatalog {
	readonly checkedAt: number;
	private readonly byProvider = new Map<string, CatalogEntry>();
	private readonly byId = new Map<string, CatalogEntry[]>();
	private readonly byCanonicalId = new Map<string, CatalogEntry[]>();
	private readonly payload: Record<string, unknown>;

	constructor(payload: unknown, checkedAt = 0) {
		const data = record(payload);
		if (!data) throw new Error("models.dev 目录不是有效的对象");
		this.payload = data;
		this.checkedAt = checkedAt;
		for (const [provider, rawProvider] of Object.entries(data)) {
			const models = record(record(rawProvider)?.models);
			if (!models) continue;
			for (const [key, rawModel] of Object.entries(models)) {
				const model = record(rawModel);
				if (!model) continue;
				const id = typeof model.id === "string" && model.id ? model.id : key;
				const entry: CatalogEntry = {
					provider,
					id,
					canonicalId: typeof model.canonical_model_id === "string" ? model.canonical_model_id : undefined,
					metadata: metadataFromModel(model),
				};
				this.byProvider.set(`${provider}/${id}`.toLowerCase(), entry);
				const normalized = id.toLowerCase();
				const matching = this.byId.get(normalized) ?? [];
				matching.push(entry);
				this.byId.set(normalized, matching);
				if (entry.canonicalId) {
					const canonical = entry.canonicalId.toLowerCase();
					const aliases = this.byCanonicalId.get(canonical) ?? [];
					aliases.push(entry);
					this.byCanonicalId.set(canonical, aliases);
				}
			}
		}
		if (this.byProvider.size === 0) throw new Error("models.dev 目录未包含模型");
	}

	get fresh(): boolean {
		return this.checkedAt > 0 && Date.now() - this.checkedAt < CACHE_TTL_MS;
	}

	find(modelId: string, provider?: string): ModelsDevModelMetadata | undefined {
		const id = modelId.toLowerCase();
		const direct = provider ? this.byProvider.get(`${provider}/${id}`.toLowerCase()) : undefined;
		if (direct) return direct.metadata;
		const qualified = this.byProvider.get(id);
		if (qualified) return qualified.metadata;
		const canonical = this.byCanonicalId.get(id);
		if (canonical?.length) {
			const owned = canonical.find((entry) => `${entry.provider}/${entry.id}`.toLowerCase() === id);
			return owned?.metadata ?? this.consensus(canonical);
		}
		const matches = this.byId.get(id);
		if (!matches?.length) return undefined;
		const owners = matches.filter((entry) => entry.canonicalId?.toLowerCase() === `${entry.provider}/${id}`);
		if (owners.length === 1) {
			const { cost: _cost, ...capabilities } = owners[0].metadata;
			return capabilities;
		}
		return this.consensus(matches);
	}

	toJSON(): Record<string, unknown> {
		return this.payload;
	}

	private consensus(entries: readonly CatalogEntry[]): ModelsDevModelMetadata {
		const result: Record<string, unknown> = {};
		for (const key of ["name", "reasoning", "input", "contextWindow", "maxTokens", "thinkingLevelMap"] as const) {
			const value = entries[0].metadata[key];
			if (
				value !== undefined &&
				entries.every((entry) => JSON.stringify(entry.metadata[key]) === JSON.stringify(value))
			) {
				result[key] = value;
			}
		}
		return result as ModelsDevModelMetadata;
	}
}

let cached: ModelsDevCatalog | undefined;
let pending: Promise<ModelsDevCatalog> | undefined;

/** 同一轮同步共享请求；取消一个调用者不取消其他调用者的目录下载。 */
export async function loadModelsDevCatalog(
	options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<ModelsDevCatalog> {
	options.signal?.throwIfAborted();
	if (!options.force && cached?.fresh) return cached;
	if (!pending) {
		pending = (async () => {
			const response = await fetch("https://models.dev/api.json", {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new Error(`models.dev 目录请求失败：HTTP ${response.status}`);
			const catalog = new ModelsDevCatalog(await response.json(), Date.now());
			cached = catalog;
			return catalog;
		})();
		void pending.then(
			() => {
				pending = undefined;
			},
			() => {
				pending = undefined;
			},
		);
	}
	return options.signal ? raceWithAbortSignal(pending, options.signal) : pending;
}
