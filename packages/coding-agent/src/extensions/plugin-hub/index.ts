import type { ExtensionFactory } from "../../core/extensions/types.ts";
import type { PluginAdapter } from "./types.ts";

export type { PluginAdapter, PluginAdapterController, PluginAdapterEntry } from "./types.ts";

/** 中枢只注册来源、汇总状态和分发操作，运行机制由适配器维护。 */
export function createPluginHubExtension(adapters: readonly PluginAdapter[]): ExtensionFactory {
	return (pi) => {
		const sources = new Map<string, PluginAdapter>();
		for (const adapter of adapters) {
			if (!adapter.id || /\s/.test(adapter.id) || adapter.id === "list")
				throw new Error(`无效插件来源标识：${adapter.id}`);
			if (sources.has(adapter.id)) throw new Error(`插件来源重复：${adapter.id}`);
			sources.set(adapter.id, adapter);
		}
		const controllers = new Map(
			[...sources].map(([id, adapter]) => [id, { name: adapter.name, controller: adapter.register(pi) }]),
		);
		pi.registerCommand("plugins", {
			description: "插件中枢：查看来源，或执行 /plugins <来源> <操作> [参数]",
			handler: async (args, context) => {
				await context.waitForIdle();
				const match = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(args);
				const source = match?.[1];
				const adapterArgs = match?.[2] || "list";
				if (!source || source === "list") {
					const rows = await Promise.all(
						[...controllers].map(async ([id, { name, controller }]) => {
							try {
								const entries = await controller.list(context);
								const states = new Map<string, number>();
								for (const entry of entries) states.set(entry.state, (states.get(entry.state) ?? 0) + 1);
								return `| ${id} | ${name} | ${entries.length} | ${[...states].map(([state, count]) => `${state}: ${count}`).join("，")} |`;
							} catch (error) {
								return `| ${id} | ${name} | — | 查询失败：${error instanceof Error ? error.message : String(error)} |`;
							}
						}),
					);
					pi.sendMessage({
						customType: "plugin-hub-overview",
						content: rows.length
							? [
									"| 来源 | 名称 | 运行条目 | 状态 |",
									"| --- | --- | ---: | --- |",
									...rows,
									"",
									"使用 `/plugins <来源> <操作> [参数]` 管理该来源的插件。",
								].join("\n")
							: "尚未注册插件来源。",
						display: true,
					});
					return;
				}
				const registration = controllers.get(source);
				if (!registration) {
					context.ui.notify(`未知插件来源：${source}。可用来源：${[...sources.keys()].join("、")}`, "error");
					return;
				}
				const { controller } = registration;
				const command = adapterArgs.split(/\s/, 1)[0];
				if (!controller.commands.includes(command)) {
					context.ui.notify(`来源 ${source} 支持的操作：${controller.commands.join("、")}`, "error");
					return;
				}
				await controller.execute(adapterArgs, context);
			},
		});
	};
}
