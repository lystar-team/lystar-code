import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { adaptDeepSeekToolParameters } from "../src/api/deepseek-tool-schema.ts";

function schema(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

describe("DeepSeek tool schema adapter", () => {
	it("flattens a root object union into an object schema", () => {
		const parameters = Type.Union([
			Type.Object({
				action: Type.Literal("create"),
				profileId: Type.Optional(Type.String()),
			}),
			Type.Object({
				action: Type.Literal("send"),
				sessionId: Type.String(),
			}),
		]);

		const adapted = schema(adaptDeepSeekToolParameters(parameters));
		const properties = schema(adapted.properties);

		expect(adapted.type).toBe("object");
		expect(adapted.anyOf).toBeUndefined();
		expect(adapted.required).toEqual(["action"]);
		expect(properties.action).toMatchObject({ type: "string", enum: ["create", "send"] });
		expect(properties.profileId).toMatchObject({ type: "string" });
		expect(properties.sessionId).toMatchObject({ type: "string" });
	});

	it("keeps a non-union object schema unchanged", () => {
		const parameters = Type.Object({ value: Type.String() });
		expect(adaptDeepSeekToolParameters(parameters)).toEqual(parameters);
	});
});
