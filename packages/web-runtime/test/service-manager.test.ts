import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeServiceSpec, webServiceUnitName, webServiceWindowsName } from "../src/index.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-service-manager-test";
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("Web service specifications", () => {
	it("keeps the default service names stable", () => {
		expect(webServiceUnitName("gateway")).toBe("lystar-web-gateway");
		expect(webServiceUnitName("runtime")).toBe("lystar-web-runtime");
		expect(webServiceWindowsName("gateway")).toBe("LYStar Web Gateway");
		expect(webServiceWindowsName("runtime", "development")).toBe("LYStar Web Runtime development");
	});

	it("adds the endpoint to an overridden Runtime invocation", () => {
		const spec = createRuntimeServiceSpec("tcp://127.0.0.1:1422", {
			profile: "development",
			agentDir: "/tmp/lystar-explicit-agent",
			invocation: {
				program: "/home/user/.local/bin/lc",
				args: ["web-runtime", "serve"],
				cwd: "/tmp/project",
			},
			environment: { LYSTAR_WEB_SERVICE_VERSION: "0.85.1-lystar.1" },
		});

		expect(spec.kind).toBe("runtime");
		expect(spec.profile).toBe("development");
		expect(spec.invocation).toEqual({
			program: "/home/user/.local/bin/lc",
			args: ["web-runtime", "serve", "--endpoint", "tcp://127.0.0.1:1422"],
			cwd: "/tmp/lystar-explicit-agent",
		});
		expect(spec.environment).toMatchObject({
			PI_CODING_AGENT_DIR: "/tmp/lystar-explicit-agent",
			PI_WEB_RUNTIME_ENDPOINT: "tcp://127.0.0.1:1422",
			LYSTAR_WEB_SERVICE_VERSION: "0.85.1-lystar.1",
		});
	});
});
