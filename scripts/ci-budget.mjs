import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const BUDGETS = Object.freeze({
	"docs-required": { wallSeconds: 90, runnerSecondsTotal: 120 },
	"normal-ci": { wallSeconds: 300, runnerSecondsTotal: 480 },
	"cli-release": { wallSeconds: 480, runnerSecondsTotal: 270 },
	"gui-release": { wallSeconds: 1200, runnerSecondsTotal: 2100 },
});

function number(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value) {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function metric(source, name) {
	return number(source?.metrics?.[name] ?? source?.[name]);
}

function validateJobMetric(source) {
	if (!source || typeof source !== "object") throw new Error("job metric must be an object");
	if (source.schemaVersion !== 1) throw new Error("job metric schemaVersion must be 1");
	if (!String(source.kind ?? "").endsWith("-job")) throw new Error("job metric kind must end with -job");
	return source;
}

function validateMetric(source) {
	if (!source || typeof source !== "object") throw new Error("budget metric must be an object");
	if (source.schemaVersion !== 1) throw new Error("budget metric schemaVersion must be 1");
	if (typeof source.kind !== "string" || !source.kind) throw new Error("budget metric kind is required");
	if (!Object.hasOwn(BUDGETS, source.budgetClass)) throw new Error(`unknown budget class: ${source.budgetClass}`);
	if (!Number.isFinite(metric(source, "ci_wall_seconds") || metric(source, "release_wall_seconds"))) {
		throw new Error("budget metric wall seconds must be numeric");
	}
	return source;
}

function wallSeconds(metricValue) {
	return metric(metricValue, "ci_wall_seconds") || metric(metricValue, "release_wall_seconds");
}

export function aggregateMetrics({ kind, budgetClass, workflowStartedAt, metrics }) {
	if (!kind) throw new Error("--kind is required");
	if (!Object.hasOwn(BUDGETS, budgetClass)) throw new Error(`unknown budget class: ${budgetClass}`);
	if (!Array.isArray(metrics) || metrics.length === 0) throw new Error("at least one job metric is required");
	const jobMetrics = metrics.map(validateJobMetric);
	const startedAt = timestamp(workflowStartedAt);
	const now = Date.now();
	const isRelease = kind === "release";
	const prefix = isRelease ? "release" : "ci";
	const runnerSecondsTotal = jobMetrics.reduce((total, entry) => total + wallSeconds(entry), 0);
	const setupSecondsTotal = jobMetrics.reduce((total, entry) => total + metric(entry, `${prefix}_setup_seconds_total`), 0);
	const buildSecondsTotal = jobMetrics.reduce((total, entry) => total + metric(entry, `${prefix}_build_seconds_total`), 0);
	const testSecondsTotal = jobMetrics.reduce((total, entry) => total + metric(entry, `${prefix}_test_seconds_total`), 0);
	const cacheRestoreSeconds = jobMetrics.reduce((total, entry) => total + metric(entry, `${prefix}_cache_restore_seconds`), 0);
	const cacheHits = {};
	const suites = {};
	for (const entry of jobMetrics) {
		for (const [cache, hit] of Object.entries(entry.cacheHits ?? {})) cacheHits[cache] = hit;
		if (entry.suite) suites[entry.suite] = {
			passed: metric(entry, "test_passed_total"),
			skipped: metric(entry, "test_skipped_total"),
		};
	}
	return {
		schemaVersion: 1,
		kind,
		budgetClass,
		createdAt: new Date(now).toISOString(),
		workflowStartedAt: new Date(startedAt).toISOString(),
		metrics: {
			[`${prefix}_wall_seconds`]: Math.max(0, Math.round((now - startedAt) / 1000)),
			[`${prefix}_runner_seconds_total`]: runnerSecondsTotal,
			[`${prefix}_setup_seconds_total`]: setupSecondsTotal,
			[`${prefix}_build_seconds_total`]: buildSecondsTotal,
			[`${prefix}_test_seconds_total`]: testSecondsTotal,
			[`${prefix}_cache_restore_seconds`]: cacheRestoreSeconds,
		},
		cacheHits,
		suites,
		jobCount: jobMetrics.length,
	};
}

export function evaluateBudget({ current, previous = [] }) {
	validateMetric(current);
	const budget = BUDGETS[current.budgetClass];
	const history = previous.map((entry, index) => {
		try {
			const value = typeof entry === "string" ? readJson(entry) : entry;
			validateMetric(value);
			if (value.kind !== current.kind || value.budgetClass !== current.budgetClass) {
				return { index, status: "different-class", value };
			}
			return { index, status: "comparable", value };
		} catch (error) {
			return { index, status: "unavailable", error: error instanceof Error ? error.message : "unreadable" };
		}
	});
	const comparable = history.filter((entry) => entry.status === "comparable").map((entry) => entry.value);
	const series = [...comparable.slice(0, 2).reverse(), current];
	const overWall = series.length === 3 && series.every((entry) => wallSeconds(entry) > budget.wallSeconds);
	const overRunner = series.length === 3 && series.every((entry) => (metric(entry, "ci_runner_seconds_total") || metric(entry, "release_runner_seconds_total")) > budget.runnerSecondsTotal);
	const triggered = overWall || overRunner;
	const unavailable = history.filter((entry) => entry.status === "unavailable");
	const differentClass = history.filter((entry) => entry.status === "different-class");
	const diagnostics = [];
	if (triggered) {
		diagnostics.push(`连续 3 次 ${current.kind}/${current.budgetClass} 超预算：${overWall ? "wall" : ""}${overWall && overRunner ? " + " : ""}${overRunner ? "runner" : ""}`);
	} else if (series.length < 3) {
		diagnostics.push(`预算诊断未触发：同类历史仅 ${series.length - 1} 条，连续 3 条才报告。`);
	} else {
		diagnostics.push("预算诊断未触发：连续记录未同时超过同一预算。");
	}
	if (differentClass.length > 0) diagnostics.push(`历史断链：${differentClass.length} 条 kind 或 budget class 不同。`);
	if (unavailable.length > 0) diagnostics.push(`历史不可用：${unavailable.length} 条，按 fail-open 处理。`);
	return {
		schemaVersion: 1,
		kind: current.kind,
		budgetClass: current.budgetClass,
		budget,
		current: {
			wallSeconds: wallSeconds(current),
			runnerSecondsTotal: metric(current, "ci_runner_seconds_total") || metric(current, "release_runner_seconds_total"),
		},
		comparableCount: comparable.length,
		history,
		triggered,
		overWall,
		overRunner,
		diagnostics,
	};
}

export function formatBudgetDiagnostic(result) {
	const lines = [
		"## Performance budget",
		`- budget_kind: ${result.kind}`,
		`- budget_class: ${result.budgetClass}`,
		`- budget_wall_seconds: ${result.budget.wallSeconds}`,
		`- budget_runner_seconds_target: ${result.budget.runnerSecondsTotal}`,
		`- current_wall_seconds: ${result.current.wallSeconds}`,
		`- current_runner_seconds_total: ${result.current.runnerSecondsTotal}`,
		`- budget_history_comparable: ${result.comparableCount}`,
		`- budget_diagnostic: ${result.triggered ? "three-consecutive-over-budget" : "none"}`,
	];
	for (const diagnostic of result.diagnostics) lines.push(`- ${diagnostic}`);
	return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
	const options = { inputs: [], previous: [] };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--aggregate") options.aggregate = true;
		else if (argument === "--input") options.inputs.push(value);
		else if (argument === "--current") options.current = value;
		else if (argument === "--previous") options.previous.push(value);
		else if (argument === "--kind") options.kind = value;
		else if (argument === "--budget-class") options.budgetClass = value;
		else if (argument === "--workflow-start") options.workflowStartedAt = value;
		else if (argument === "--output" || argument === "--json-output") options.output = value;
		else throw new Error(`Unknown argument: ${argument}`);
		if (argument !== "--aggregate") index++;
	}
	return options;
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function runCli(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	if (options.aggregate) {
		if (!options.output) throw new Error("--output is required with --aggregate");
		const metricValue = aggregateMetrics({
			kind: options.kind,
			budgetClass: options.budgetClass,
			workflowStartedAt: options.workflowStartedAt,
			metrics: options.inputs.map(readJson),
		});
		writeJson(options.output, metricValue);
		process.stdout.write(`${JSON.stringify(metricValue)}\n`);
		return;
	}
	if (!options.current) throw new Error("--current is required");
	if (options.previous.length > 2) throw new Error("at most two --previous inputs are supported");
	const result = evaluateBudget({ current: readJson(options.current), previous: options.previous });
	const output = formatBudgetDiagnostic(result);
	if (options.output) writeJson(options.output, result);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
	process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
