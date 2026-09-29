import type { Tool } from "../types.ts";

type JsonSchema = Record<string, unknown>;

type SchemaPropertyMap = Record<string, unknown>;

function isSchemaObject(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSchema<T>(value: T): T {
	return structuredClone(value);
}

function schemaEquals(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function constValue(schema: unknown): { present: true; value: unknown } | { present: false } {
	if (!isSchemaObject(schema) || !("const" in schema)) return { present: false };
	return { present: true, value: schema.const };
}

function mergePropertySchemas(schemas: unknown[]): unknown {
	const uniqueSchemas = schemas.filter(
		(schema, index) => schemas.findIndex((candidate) => schemaEquals(candidate, schema)) === index,
	);
	if (uniqueSchemas.length === 1) return cloneSchema(uniqueSchemas[0]);

	const constants = uniqueSchemas.map(constValue);
	if (constants.every((result) => result.present)) {
		const first = cloneSchema(uniqueSchemas[0]) as JsonSchema;
		delete first.const;
		first.enum = constants.map((result) => result.value);
		return first;
	}

	return { anyOf: uniqueSchemas.map(cloneSchema) };
}

function commonRequiredProperties(branches: JsonSchema[]): string[] {
	const requiredSets = branches.map((branch) => {
		const required = branch.required;
		return new Set(
			Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : [],
		);
	});
	const first = requiredSets[0] ?? new Set<string>();
	return [...first].filter((name) => requiredSets.every((required) => required.has(name)));
}

/**
 * DeepSeek 要求函数 parameters 的根节点是 object。将对象分支的根级 anyOf
 * 展平为一个对象，保留分支属性和共同必填项；运行时仍由原始工具参数处理。
 */
export function adaptDeepSeekToolParameters(parameters: Tool["parameters"]): Tool["parameters"] {
	const schema = cloneSchema(parameters) as unknown;
	if (!isSchemaObject(schema) || !Array.isArray(schema.anyOf)) return parameters;

	const branches = schema.anyOf.filter(isSchemaObject);
	if (branches.length !== schema.anyOf.length || branches.some((branch) => branch.type !== "object")) {
		return parameters;
	}

	const propertySchemas = new Map<string, unknown[]>();
	for (const branch of branches) {
		const properties = isSchemaObject(branch.properties) ? (branch.properties as SchemaPropertyMap) : {};
		for (const [name, property] of Object.entries(properties)) {
			const variants = propertySchemas.get(name) ?? [];
			variants.push(property);
			propertySchemas.set(name, variants);
		}
	}

	const properties: SchemaPropertyMap = {};
	for (const [name, schemas] of propertySchemas) {
		properties[name] = mergePropertySchemas(schemas);
	}

	const adapted: JsonSchema = { ...branches[0], type: "object", properties };
	const required = commonRequiredProperties(branches);
	if (required.length > 0) {
		adapted.required = required;
	} else {
		delete adapted.required;
	}
	delete adapted.anyOf;
	return adapted as Tool["parameters"];
}
