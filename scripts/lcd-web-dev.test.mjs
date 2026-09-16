import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldBuildDevelopmentWeb, shouldRunDevelopmentWebFrontend } from "./lcd-web-dev.mjs";

describe("lcd Web development routing", () => {
	it("builds before commands that start development backend processes", () => {
		for (const args of [
			["web"],
			["web", "--foreground"],
			["web", "gateway", "start"],
			["web", "gateway", "restart"],
			["web", "runtime", "start"],
			["web", "runtime", "restart"],
			["web", "service", "install"],
			["web", "service", "start"],
			["web", "service", "restart"],
			["web", "service", "reconcile"],
			["web-runtime", "serve"],
		]) {
			assert.equal(shouldBuildDevelopmentWeb(args), true, args.join(" "));
		}
	});

	it("does not build for read-only or stop commands", () => {
		for (const args of [
			["--help"],
			["web", "--help"],
			["web", "gateway", "status"],
			["web", "gateway", "stop"],
			["web", "runtime", "status"],
			["web", "runtime", "stop"],
			["web", "service", "status"],
			["web", "service", "stop"],
		]) {
			assert.equal(shouldBuildDevelopmentWeb(args), false, args.join(" "));
		}
	});

	it("runs Vite only for the main development Web command", () => {
		assert.equal(shouldRunDevelopmentWebFrontend(["web"]), true);
		assert.equal(shouldRunDevelopmentWebFrontend(["web", "--foreground"]), true);
		assert.equal(shouldRunDevelopmentWebFrontend(["web", "gateway", "restart"]), false);
	});
});
