import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * 使用大写 K/M/B 紧凑显示 Token 数量。
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();

	const unit = count < 1_000_000 ? "K" : count < 1_000_000_000 ? "M" : "B";
	const value = count / (unit === "K" ? 1000 : unit === "M" ? 1_000_000 : 1_000_000_000);
	const precision = value < 10 ? 2 : value < 100 ? 1 : 0;
	return `${Number(value.toFixed(precision))}${unit}`;
}

function firstLineThatFits(lines: string[], width: number): string {
	return lines.find((line) => visibleWidth(line) <= width) ?? truncateToWidth(lines.at(-1) ?? "", width, "");
}

/**
 * Footer 只显示单行会话用量；上下文、工作目录与会话名称由顶部 WorkspaceHeader 负责。
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// 累加完整 Session 的用量，压缩前记录也不能丢失。
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		const cumulativeInput = usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite;
		const inputText = cumulativeInput > 0 ? `输入 ${formatTokens(cumulativeInput)}` : undefined;
		const outputText = usageTotals.output > 0 ? `输出 ${formatTokens(usageTotals.output)}` : undefined;
		const cacheReadText = usageTotals.cacheRead > 0 ? `缓存读取 ${formatTokens(usageTotals.cacheRead)}` : undefined;
		const cacheWriteText =
			usageTotals.cacheWrite > 0 ? `缓存写入 ${formatTokens(usageTotals.cacheWrite)}` : undefined;
		const latestHitText =
			(usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined
				? `本次命中 ${latestCacheHitRate.toFixed(1)}%`
				: undefined;

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingOAuth(state.model.provider)
			: false;
		const costText =
			usageTotals.cost || usingSubscription
				? `费用 $${usageTotals.cost.toFixed(3)}${usingSubscription ? "（订阅）" : ""}`
				: undefined;
		const xpText = areExperimentalFeaturesEnabled() ? theme.bold(theme.fg("warning", "xp")) : undefined;
		const fullParts = [inputText, outputText, cacheReadText, cacheWriteText, latestHitText, costText, xpText].filter(
			(value): value is string => value !== undefined,
		);
		const mediumParts = [inputText, outputText, cacheReadText, latestHitText].filter(
			(value): value is string => value !== undefined,
		);
		const compactParts = [inputText, outputText, latestHitText].filter(
			(value): value is string => value !== undefined,
		);
		const minimalParts = [inputText, outputText].filter((value): value is string => value !== undefined);
		const lines: string[] = [];
		if (fullParts.length > 0) {
			const summaries = [
				`累计 ${fullParts.join(" · ")}`,
				mediumParts.join(" · "),
				compactParts.join(" · "),
				minimalParts.join(" · "),
			].filter(Boolean);
			lines.push(theme.fg("dim", firstLineThatFits(summaries, width)));
		}

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
