import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";

/** 适配器返回自己管理的运行条目；条目标识和状态由该来源解释。 */
export interface PluginAdapterEntry {
	id: string;
	name: string;
	state: string;
}

export interface PluginAdapterController {
	commands: readonly string[];
	list(context: ExtensionContext): Promise<readonly PluginAdapterEntry[]>;
	/** 中枢在会话空闲时调用；适配器负责操作参数及自身格式。 */
	execute(args: string, context: ExtensionCommandContext): Promise<void>;
}

/** 每个 Harness 自行注册工具、资源与会话生命周期，并实现管理入口。 */
export interface PluginAdapter {
	id: string;
	name: string;
	register(pi: ExtensionAPI): PluginAdapterController;
}
