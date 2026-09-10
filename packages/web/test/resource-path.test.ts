import { describe, expect, it } from "vitest";
import {
	decodeResourceLink,
	isAbsoluteResourcePath,
	isExternalResourceLink,
	isLocalResourcePath,
} from "../src/lib/resource-path.ts";

describe("resource path routing", () => {
	it("routes absolute filesystem paths directly to external resources", () => {
		expect(isAbsoluteResourcePath("/home/yean/project/file.ts")).toBe(true);
		expect(isAbsoluteResourcePath("file:///tmp/image.png")).toBe(true);
		expect(isAbsoluteResourcePath("C:\\workspace\\file.ts")).toBe(true);
	});

	it("decodes Markdown URL paths before file lookup", () => {
		expect(decodeResourceLink("docs/%E4%BA%A7%E5%93%81%E8%AF%B4%E6%98%8E.md")).toBe("docs/产品说明.md");
		expect(decodeResourceLink("file:///tmp/%E4%B8%AD%E6%96%87.png")).toBe("file:///tmp/中文.png");
		expect(decodeResourceLink("docs/%2520.md")).toBe("docs/%20.md");
		expect(decodeResourceLink("docs/%E0%A4%A")).toBe("docs/%E0%A4%A");
	});

	it("keeps project-relative files inside the file preview flow", () => {
		expect(isLocalResourcePath("src/views/SessionView.vue")).toBe(true);
		expect(isLocalResourcePath("../shared/file.ts")).toBe(true);
		expect(isLocalResourcePath("README.md")).toBe(true);
	});

	it("does not intercept browser links as local files", () => {
		expect(isExternalResourceLink("https://example.com/file.ts")).toBe(true);
		expect(isLocalResourcePath("https://example.com/file.ts")).toBe(false);
		expect(isLocalResourcePath("mailto:user@example.com")).toBe(false);
		expect(isLocalResourcePath("#section")).toBe(false);
	});
});
