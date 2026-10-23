import type { Api, Model, Tool } from "../types.ts";

type ModelIdentity = Pick<Model<Api>, "id" | "name" | "provider" | "baseUrl">;

/** 同时识别官方路由、第三方模型 ID 和自定义模型名称。 */
export function isDeepSeekModel(model: ModelIdentity): boolean {
	return (
		model.provider === "deepseek" ||
		model.baseUrl.toLowerCase().includes("deepseek.com") ||
		/deepseek/i.test(`${model.id} ${model.name}`)
	);
}

/** 只稳定请求中的声明；保留描述、数组顺序和执行端的原始 Schema。 */
export function stabilizeDeepSeekTools(model: ModelIdentity, tools: Tool[]): Tool[] {
	if (!isDeepSeekModel(model)) return tools;
	return tools
		.toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.map((tool) => ({
			...tool,
			parameters: JSON.parse(
				JSON.stringify(tool.parameters, (_key, value: unknown) => {
					if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
					return Object.fromEntries(
						Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
					);
				}),
			) as Tool["parameters"],
		}));
}
