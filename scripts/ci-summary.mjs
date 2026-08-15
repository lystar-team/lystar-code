import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function number(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function readTestResult(path) {
	if (path.endsWith(".tap")) {
		const report = readFileSync(path, "utf8");
		const count = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(report)?.[1] ?? 0);
		return { passed: count("pass"), skipped: count("skipped") + count("todo"), slowestFiles: [], missing: false };
	}
	try {
		const report = JSON.parse(readFileSync(path, "utf8"));
		return {
			passed: number(report.numPassedTests),
			skipped: number(report.numPendingTests) + number(report.numTodoTests),
			slowestFiles: (report.testResults ?? [])
				.map((file) => ({
					file: file.name,
					duration: (file.assertionResults ?? []).reduce((total, test) => total + number(test.duration), 0),
				}))
				.sort((left, right) => right.duration - left.duration),
			missing: false,
		};
	} catch {
		return { passed: 0, skipped: 0, slowestFiles: [], missing: true };
	}
}

export function summarize({ suite, resultPaths = [], required = false, timings = {}, plan, jobs = [] }) {
	const results = resultPaths.map(readTestResult);
	const missingReports = resultPaths.filter((_, index) => results[index].missing);
	const passed = results.reduce((total, result) => total + result.passed, 0);
	const skipped = results.reduce((total, result) => total + result.skipped, 0);
	const slowestFiles = results.flatMap((result) => result.slowestFiles).sort((left, right) => right.duration - left.duration).slice(0, 20);
	if (required && skipped > 0) throw new Error(`${suite} required deterministic suite skipped ${skipped} tests`);

	const selectedGates = Object.entries(plan?.wouldRun ?? {}).filter(([, selected]) => selected).map(([gate]) => gate);
	for (const job of jobs) {
		if (job.result !== "success" && job.gates.some((gate) => selectedGates.includes(gate))) {
			throw new Error(`required job ${job.name} is ${job.result}`);
		}
	}

	const lines = [
		`## CI ${suite}`,
		`- ci_wall_seconds: ${number(timings.wall)}`,
		`- ci_setup_seconds_total: ${number(timings.setup)}`,
		`- ci_build_seconds_total: ${number(timings.build)}`,
		`- ci_test_seconds_total: ${number(timings.test)}`,
		`- ci_cache_restore_seconds: ${timings.cache === undefined ? "unavailable" : number(timings.cache)}`,
		`- test_passed_total{suite=${suite}}: ${passed}`,
		`- test_skipped_total{suite=${suite}}: ${skipped}`,
	];
	for (const [cache, hit] of Object.entries(timings.cacheHits ?? {})) {
		lines.push(`- ci_cache_hit{cache=${cache}}: ${hit}`);
	}
	for (const file of slowestFiles) lines.push(`- test_slowest_file_ms{suite=${suite},file=${file.file}}: ${file.duration}`);
	for (const path of missingReports) lines.push(`- test_report_missing{suite=${suite}}: ${path}`);
	if (plan) {
		lines.push(`- planner_mode: ${plan.mode}`);
		for (const gate of Object.keys(plan.wouldRun)) {
			const reasons = plan.reasons[gate] ?? [];
			lines.push(`- planner_would_run{gate=${gate}}: ${plan.wouldRun[gate]}${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
	const options = { resultPaths: [], timings: { cacheHits: {} }, jobs: [] };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--suite") options.suite = value;
		else if (argument === "--result") options.resultPaths.push(value);
		else if (argument === "--required") {
			options.required = true;
			continue;
		} else if (argument === "--plan-json") options.plan = JSON.parse(value);
		else if (argument === "--timing") {
			const [name, timing] = value.split("=", 2);
			options.timings[name] = timing;
		} else if (argument === "--cache-hit") {
			const [cache, hit] = value.split("=", 2);
			options.timings.cacheHits[cache] = hit;
		} else if (argument === "--job") {
			const [name, result, gates] = value.split("=", 3);
			options.jobs.push({ name, result, gates: gates.split(",") });
		} else throw new Error(`Unknown argument: ${argument}`);
		index++;
	}
	if (!options.suite) throw new Error("--suite is required");
	return options;
}

export function runCli(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	const output = summarize(options);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
	process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
