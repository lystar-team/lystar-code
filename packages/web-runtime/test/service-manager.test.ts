import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRuntimeServiceSpec,
	installWebService,
	type WebServiceSpec,
	webServiceUnitName,
	webServiceWindowsName,
} from "../src/index.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalServiceChild = process.env.LYSTAR_WEB_SERVICE_CHILD;
const originalUserEnvSource = process.env.LYSTAR_USER_ENV_SOURCE;

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = "/tmp/lystar-service-manager-test";
	delete process.env.LYSTAR_WEB_SERVICE_CHILD;
	delete process.env.LYSTAR_USER_ENV_SOURCE;
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalServiceChild === undefined) delete process.env.LYSTAR_WEB_SERVICE_CHILD;
	else process.env.LYSTAR_WEB_SERVICE_CHILD = originalServiceChild;
	if (originalUserEnvSource === undefined) delete process.env.LYSTAR_USER_ENV_SOURCE;
	else process.env.LYSTAR_USER_ENV_SOURCE = originalUserEnvSource;
});

describe("Web service specifications", () => {
	it("keeps the default service names stable", () => {
		expect(webServiceUnitName("frontend", "development")).toBe("lystar-web-frontend-development");
		expect(webServiceUnitName("gateway")).toBe("lystar-web-gateway");
		expect(webServiceUnitName("runtime")).toBe("lystar-web-runtime");
		expect(webServiceWindowsName("frontend", "development")).toBe("LYStar Web Frontend development");
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
			PATH: process.env.PATH,
			LYSTAR_USER_ENV_SOURCE: "process",
			PI_CODING_AGENT_DIR: "/tmp/lystar-explicit-agent",
			PI_WEB_RUNTIME_ENDPOINT: "tcp://127.0.0.1:1422",
			LYSTAR_WEB_SERVICE_VERSION: "0.85.1-lystar.1",
		});
	});

	it.skipIf(process.platform !== "linux")("writes an absolute systemd WorkingDirectory with literal spaces", () => {
		const home = mkdtempSync(join(tmpdir(), "lystar-service-manager-home-"));
		const bin = join(home, "bin");
		mkdirSync(bin);
		const systemctl = join(bin, "systemctl");
		writeFileSync(systemctl, '#!/bin/sh\ncase " $* " in *" show "*) printf \'4321\\n\' ;; *) exit 0 ;; esac\n');
		chmodSync(systemctl, 0o755);
		const originalHome = process.env.HOME;
		const originalPath = process.env.PATH;
		process.env.HOME = home;
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		const cwd = join(home, "agent with space %n");
		const spec: WebServiceSpec = {
			kind: "runtime",
			agentDir: join(home, "agent"),
			invocation: { program: "/usr/bin/node", args: ["web-runtime", "serve"], cwd },
		};
		try {
			const status = installWebService(spec);
			const unit = readFileSync(join(home, ".config", "systemd", "user", "lystar-web-runtime.service"), "utf8");
			expect(unit).toContain(`WorkingDirectory=${cwd.replaceAll("%", "%%")}`);
			expect(unit).not.toContain("\\x20");
			expect(unit).not.toContain(`WorkingDirectory="${cwd}"`);
			expect(status.manager).toBe("systemd-user");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			rmSync(home, { recursive: true, force: true });
		}
	});
});
