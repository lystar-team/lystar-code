import { join } from "node:path";
import { JsonFileRegistry } from "./json-file-registry.ts";

interface ModelProviderVisibilityFile {
	version: 1;
	initialized: boolean;
	overrides: Record<string, boolean>;
}

export class ModelProviderVisibilityRegistry {
	private readonly storage: JsonFileRegistry<ModelProviderVisibilityFile>;

	constructor(agentDir: string) {
		this.storage = new JsonFileRegistry<ModelProviderVisibilityFile>(
			join(agentDir, "web", "model-provider-visibility.json"),
			() => ({ version: 1, initialized: false, overrides: {} }),
			(raw) => ({
				version: 1,
				initialized: raw.initialized === true,
				overrides:
					raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)
						? Object.fromEntries(
								Object.entries(raw.overrides).filter(
									(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
								),
							)
						: {},
			}),
			"模型 Provider 显示设置损坏",
		);
	}

	async load(): Promise<void> {
		await this.storage.load();
	}

	read(): Record<string, boolean> {
		return { ...this.storage.read().overrides };
	}

	async set(provider: string, visible: boolean): Promise<boolean> {
		return this.storage.update((state) => {
			if (state.initialized && state.overrides[provider] === visible) return false;
			state.initialized = true;
			state.overrides = { ...state.overrides, [provider]: visible };
			return true;
		});
	}

	async importOnce(overrides: Record<string, boolean>): Promise<boolean> {
		return this.storage.update((state) => {
			// 首份旧设置只导入一次，后续浏览器不能用本地旧副本覆盖共享设置。
			if (state.initialized || Object.keys(overrides).length === 0) return false;
			state.initialized = true;
			state.overrides = { ...overrides };
			return true;
		});
	}

	async remove(provider: string): Promise<boolean> {
		return this.storage.update((state) => {
			if (!Object.hasOwn(state.overrides, provider)) return false;
			delete state.overrides[provider];
			return true;
		});
	}
}
