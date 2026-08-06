import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatTokens } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const getEntries = vi.fn(() => entries);
	const getLeafId = vi.fn(() => "leaf-1");
	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries,
			getLeafId,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(
	providerCount: number,
	extensionStatuses: ReadonlyMap<string, string> = new Map(),
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatTokens", () => {
	it("uses compact uppercase token units", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(9500)).toBe("9.5K");
		expect(formatTokens(516_000)).toBe("516K");
		expect(formatTokens(4_900_000)).toBe("4.9M");
		expect(formatTokens(1_200_000_000)).toBe("1.2B");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for large cumulative totals", () => {
		const width = 93;
		const session = createSession({
			sessionName: "不应出现在底部",
			usage: {
				input: 4_900_000,
				output: 516_000,
				cacheRead: 242_000_000,
				cacheWrite: 80_000,
				cost: { total: 12.345 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps footer lines within width regardless of model metadata", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows only extension status before the session has usage", () => {
		const session = createSession({
			sessionName: "只在顶部显示",
			reasoning: true,
			thinkingLevel: "high",
		});
		const footer = new FooterComponent(session, createFooterData(1, new Map([["openviking", "OV ✓"]])));

		const lines = footer.render(120).map(stripAnsi);

		expect(lines).toEqual(["OV ✓"]);
		expect(lines.join("\n")).not.toMatch(/\/tmp\/project|只在顶部显示|上下文|思考强度/);
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[0]);
		expect(statsLine).toContain("费用 $1.250");
	});

	it("reuses cumulative usage while the session leaf is unchanged", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const getEntries = vi.mocked(session.sessionManager.getEntries);
		const getLeafId = vi.mocked(session.sessionManager.getLeafId);

		footer.render(80);
		footer.render(40);
		expect(getEntries).toHaveBeenCalledOnce();

		getLeafId.mockReturnValue("leaf-2");
		footer.render(80);
		expect(getEntries).toHaveBeenCalledTimes(2);
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toContain("本次命中 25.0%");
	});

	it("shows cumulative usage including compaction without repeating the session name", () => {
		const session = createSession({
			sessionName: "上游升级",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0 },
			},
			compactionUsage: {
				input: 200,
				output: 20,
				cacheRead: 80,
				cacheWrite: 30,
				cost: { total: 0 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const lines = footer.render(120).map(stripAnsi);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("累计 输入 510 · 输出 30 · 缓存读取 130 · 缓存写入 80 · 本次命中 25.0%");
		expect(lines.join("\n")).not.toContain("上游升级");
		expect(lines.join("\n")).not.toMatch(/CH|R130|W80|↑|↓/);
	});

	it.each([120, 80, 58, 40])("uses semantic fallbacks at width %i", (width) => {
		const session = createSession({
			sessionName: "顶部会话名",
			usage: {
				input: 4_900_000,
				output: 516_000,
				cacheRead: 242_000_000,
				cacheWrite: 80_000,
				cost: { total: 0 },
			},
		});
		const lines = new FooterComponent(session, createFooterData(1)).render(width).map(stripAnsi);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("输入 247M");
		expect(lines[0]).toContain("输出 516K");
		if (width >= 58) expect(lines[0]).toContain("命中 98.0%");
		expect(lines.join("\n")).not.toMatch(/CH|R242|W80|↑|↓|上下文|顶部会话名|\/tmp\/project/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("can move usage into the fixed shortcut bar while keeping extension status", () => {
		const session = createSession({
			sessionName: "顶部会话名",
			usage: {
				input: 12_000,
				output: 3_000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1, new Map([["openviking", "OV ✓"]])), {
			showUsage: false,
		});

		expect(stripAnsi(footer.renderUsage(40) ?? "")).toContain("输入 12K · 输出 3K");
		expect(footer.render(40).map(stripAnsi)).toEqual(["OV ✓"]);
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[0])).toContain("费用 $1.234（订阅）");
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("$0.000 (sub)");
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[1]);

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});
});
