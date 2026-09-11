import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProductBrandingPath, loadProductBranding, saveProductBranding } from "../src/product-branding.ts";

describe("product branding", () => {
	it("品牌设置保存到 lystar.json，并保留其他 LYStar 配置", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-product-branding-"));
		const logo = `data:image/png;base64,${Buffer.from("test-logo").toString("base64")}`;
		try {
			await writeFile(
				getProductBrandingPath(agentDir),
				JSON.stringify({ altScreen: "always", mouse: true }, null, "\t"),
			);
			expect(await loadProductBranding(agentDir)).toEqual({ name: "LYStar Code" });

			expect(await saveProductBranding(agentDir, { name: "我的工作台", logo })).toEqual({
				name: "我的工作台",
				logo,
			});
			expect(JSON.parse(await readFile(getProductBrandingPath(agentDir), "utf8"))).toEqual({
				altScreen: "always",
				mouse: true,
				branding: { name: "我的工作台", logo },
			});

			expect(await saveProductBranding(agentDir, { name: "新的工作台", logo: null })).toEqual({
				name: "新的工作台",
			});
			expect(await loadProductBranding(agentDir)).toEqual({ name: "新的工作台" });
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("无效品牌配置回退到内置品牌", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "lystar-product-branding-invalid-"));
		try {
			await writeFile(
				getProductBrandingPath(agentDir),
				JSON.stringify({ branding: { name: "", logo: "data:image/svg+xml;base64,invalid" } }),
			);
			expect(await loadProductBranding(agentDir)).toEqual({ name: "LYStar Code" });
			await expect(saveProductBranding(agentDir, { name: "" })).rejects.toThrow("系统名称不能为空");
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});
});
