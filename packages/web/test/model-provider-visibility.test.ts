import { describe, expect, it } from "vitest";
import { resolveHiddenModelProviders } from "../src/state/use-workbench.ts";

describe("模型 Provider 默认可见性", () => {
	const providers = [
		{ id: "unauthenticated-builtin", authenticated: false, builtIn: true },
		{ id: "authenticated-builtin", authenticated: true, builtIn: true },
		{ id: "credentialless-custom", authenticated: false, builtIn: false },
		{ id: "authenticated-custom", authenticated: true, builtIn: false },
	];

	it("默认隐藏没有认证状态的 Provider", () => {
		expect(resolveHiddenModelProviders(providers, {})).toEqual(["unauthenticated-builtin", "credentialless-custom"]);
	});

	it("保留用户对 Provider 可见性的覆盖", () => {
		expect(
			resolveHiddenModelProviders(providers, {
				"unauthenticated-builtin": true,
				"authenticated-builtin": false,
				"credentialless-custom": true,
			}),
		).toEqual(["authenticated-builtin"]);
	});
});
