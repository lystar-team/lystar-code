import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCliPath = join(packageDir, "dist", "cli.js");
const srcCliPath = join(packageDir, "src", "cli.ts");
const defaultNodeProfileDir = join(repoRoot, "profiles-node");
const defaultBunProfileDir = join(repoRoot, "profiles-bun");
const agentDirEnvName = "PI_CODING_AGENT_DIR";
const startupBenchmarkEnvName = "PI_STARTUP_BENCHMARK";

function printHelp() {
	console.log(`Usage:
  node scripts/profile-coding-agent-node.mjs [options]

Profiles coding-agent startup with the runtime selected below:
- npm run profile:tui     -> builds packages/coding-agent and profiles TUI startup with Node
- npm run profile:rpc     -> builds packages/coding-agent and profiles RPC startup with Node
- bun run profile:tui     -> profiles TUI startup from src/cli.ts directly with Bun
- bun run profile:rpc     -> profiles RPC startup from src/cli.ts directly with Bun

Options:
  --mode <name>          tui or rpc (default: tui)
  --runs <n>             Number of measured runs (default: 1)
  --warmup <n>           Number of warmup runs before measurements (default: 0)
  --profile-dir <dir>    CPU profile output directory
                         Default: profiles-node for Node, profiles-bun for Bun
  --label <name>         Profile name prefix (default: <mode>-startup)
  --runtime <name>       node, bun, or auto (default: auto)
  --agent-dir <dir>      Use a specific PI_CODING_AGENT_DIR for the benchmark run
  --session <path>       Resume the specified Session JSONL instead of using --no-session
  --json                 Write a JSON benchmark report to stdout
  --isolated-agent-dir   Use a fresh temporary agent dir instead of the normal one
  --no-offline           Do not force PI_OFFLINE=1 / PI_SKIP_VERSION_CHECK=1
  --skip-build           Reuse the current dist/cli.js without rebuilding first (Node only)
  --cpu-profile          Write CPU profiles for benchmark runs
  --help                 Show this help

Notes:
  - By default the benchmark uses your normal configured agent dir, so global models/auth/settings work.
  - TUI mode measures startup until the interactive UI reaches first usable state.
  - RPC mode measures startup until a real get_state request receives a response, then closes stdin to exit cleanly.
  - CPU profiles are kept in the selected profile directory for later analysis.
`);
}

function parseIntegerFlag(value, name) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	return parsed;
}

function parseRuntime(value) {
	if (value === "auto" || value === "node" || value === "bun") {
		return value;
	}
	throw new Error(`Invalid --runtime: ${value}`);
}

function parseMode(value) {
	if (value === "tui" || value === "rpc") {
		return value;
	}
	throw new Error(`Invalid --mode: ${value}`);
}

function parseArgs(argv) {
	const options = {
		mode: "tui",
		runs: 1,
		warmup: 0,
		profileDir: undefined,
		label: undefined,
		offline: true,
		build: true,
		runtime: "auto",
		agentDir: undefined,
		session: undefined,
		json: false,
		isolatedAgentDir: false,
		cpuProfile: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];

		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		if (arg === "--no-offline") {
			options.offline = false;
			continue;
		}

		if (arg === "--isolated-agent-dir") {
			options.isolatedAgentDir = true;
			continue;
		}

		if (arg === "--skip-build") {
			options.build = false;
			continue;
		}

		if (arg === "--cpu-profile") {
			options.cpuProfile = true;
			continue;
		}

		if (arg === "--json") {
			options.json = true;
			continue;
		}

		if (
			(arg === "--mode" ||
				arg === "--runs" ||
				arg === "--warmup" ||
				arg === "--profile-dir" ||
				arg === "--label" ||
				arg === "--runtime" ||
				arg === "--agent-dir" ||
				arg === "--session") &&
			index + 1 >= argv.length
		) {
			throw new Error(`Missing value for ${arg}`);
		}

		if (arg === "--mode") {
			options.mode = parseMode(argv[++index]);
			continue;
		}

		if (arg === "--runs") {
			options.runs = parseIntegerFlag(argv[++index], "--runs");
			continue;
		}

		if (arg === "--warmup") {
			options.warmup = parseIntegerFlag(argv[++index], "--warmup");
			continue;
		}

		if (arg === "--profile-dir") {
			options.profileDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--label") {
			options.label = argv[++index];
			continue;
		}

		if (arg === "--runtime") {
			options.runtime = parseRuntime(argv[++index]);
			continue;
		}

		if (arg === "--agent-dir") {
			options.agentDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--session") {
			options.session = resolve(argv[++index]);
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function detectRuntimeFromPackageManager() {
	const userAgent = process.env.npm_config_user_agent ?? "";
	return userAgent.startsWith("bun/") ? "bun" : "node";
}

function resolveRuntime(requestedRuntime) {
	if (requestedRuntime === "auto") {
		return detectRuntimeFromPackageManager();
	}
	return requestedRuntime;
}

function resolveProfileDir(runtime, requestedProfileDir) {
	if (requestedProfileDir) {
		return requestedProfileDir;
	}
	return runtime === "bun" ? defaultBunProfileDir : defaultNodeProfileDir;
}

function resolveLabel(mode, requestedLabel) {
	return requestedLabel ?? `${mode}-startup`;
}

function formatMs(value) {
	return `${value.toFixed(1)}ms`;
}

function toDisplayPath(path) {
	const relativePath = relative(repoRoot, path);
	if (relativePath !== "" && !relativePath.startsWith("..")) {
		return relativePath.replaceAll("\\", "/");
	}
	return path;
}

function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return {
		min: sorted[0],
		max: sorted[sorted.length - 1],
		avg: total / sorted.length,
		median,
	};
}

function parseStartupTimings(stderr) {
	const lines = stderr.split(/\r?\n/);
	const timings = new Map();
	let namespace;

	for (const line of lines) {
		const header = line.match(/^--- Startup Timings(?:: ([^-]+))? ---$/);
		if (header) {
			namespace = header[1]?.trim() || "main";
			continue;
		}
		if (!namespace) continue;
		if (/^-+$/.test(line)) {
			namespace = undefined;
			continue;
		}
		const match = line.match(/^\s+([^:]+):\s+(\d+)ms$/);
		if (!match || match[1] === "TOTAL") continue;
		const key = namespace === "main" ? match[1] : `${namespace}.${match[1]}`;
		timings.set(key, Number.parseInt(match[2], 10));
	}

	return timings;
}

function parseBenchmarkStats(stderr) {
	const match = stderr.match(
		/PI_BENCHMARK maxEventLoopBlockMs=([0-9.]+) sessionOpenEventLoopBlockMs=([0-9.]+) runtimeEventLoopBlockMs=([0-9.]+) interactiveInitEventLoopBlockMs=([0-9.]+) rssBytes=(\d+)/,
	);
	return match
		? {
				maxEventLoopBlockMs: Number.parseFloat(match[1]),
				sessionOpenEventLoopBlockMs: Number.parseFloat(match[2]),
				runtimeEventLoopBlockMs: Number.parseFloat(match[3]),
				interactiveInitEventLoopBlockMs: Number.parseFloat(match[4]),
				rssBytes: Number.parseInt(match[5], 10),
			}
		: {
				maxEventLoopBlockMs: null,
				sessionOpenEventLoopBlockMs: null,
				runtimeEventLoopBlockMs: null,
				interactiveInitEventLoopBlockMs: null,
				rssBytes: null,
			};
}

function startMemorySampler(child) {
	let peakRssBytes = 0;
	const sample = () => {
		if (process.platform !== "linux" || !child.pid) return;
		try {
			const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
			const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
			if (match) peakRssBytes = Math.max(peakRssBytes, Number.parseInt(match[1], 10) * 1024);
		} catch {}
	};
	const timer = setInterval(sample, 10);
	timer.unref();
	sample();
	return () => {
		clearInterval(timer);
		return peakRssBytes || null;
	};
}

function summarizeTimingMaps(runs) {
	const valuesByLabel = new Map();
	for (const run of runs) {
		for (const [label, value] of run.timings.entries()) {
			const values = valuesByLabel.get(label);
			if (values) {
				values.push(value);
			} else {
				valuesByLabel.set(label, [value]);
			}
		}
	}

	const summaries = new Map();
	for (const [label, values] of valuesByLabel.entries()) {
		summaries.set(label, summarize(values));
	}
	return summaries;
}

function toMetricName(label) {
	return `${label.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")}_ms`;
}

async function waitForExit(child, errorPrefix) {
	return await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`${errorPrefix} exited from signal ${signal}`));
				return;
			}
			resolve(code ?? 0);
		});
	});
}

async function runBuild(quiet = false) {
	if (!quiet) {
		process.stdout.write("Building packages/tui, packages/telemetry, packages/ai, packages/agent, and packages/coding-agent...\n");
	}
	const startedAt = performance.now();
	const child = spawn(
		"npm",
		[
			"run",
			"build",
			"--workspace",
			"packages/tui",
			"--workspace",
			"packages/telemetry",
			"--workspace",
			"packages/ai",
			"--workspace",
			"packages/agent",
			"--workspace",
			"packages/coding-agent",
		],
		{
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		},
	);

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const exitCode = await waitForExit(child, "Build");
	if (exitCode !== 0) {
		if (stdout.trim()) {
			process.stderr.write(`${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
		}
		if (stderr.trim()) {
			process.stderr.write(`${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
		}
		throw new Error(`Build failed with exit code ${exitCode}`);
	}

	if (!quiet) {
		process.stdout.write(`Build completed in ${formatMs(performance.now() - startedAt)}\n`);
	}
}

function getRuntimeCommand(runtime, mode, profileDir, profileName, cpuProfile, sessionPath) {
	const benchmarkArgs = sessionPath
		? ["--session", sessionPath, "--approve", "--no-extensions"]
		: ["--no-session", "--approve", "--no-extensions"];
	if (mode === "rpc") {
		benchmarkArgs.push("--mode", "rpc");
	}

	if (runtime === "bun") {
		const args = [];
		if (cpuProfile) {
			args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
		}
		args.push(srcCliPath, ...benchmarkArgs);
		return {
			executable: "bun",
			args,
		};
	}

	const args = [];
	if (cpuProfile) {
		args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
	}
	args.push(distCliPath, ...benchmarkArgs);
	return {
		executable: process.execPath,
		args,
	};
}

function createBenchmarkEnv(options, isolatedAgentDir) {
	const env = { ...process.env };
	if (options.agentDir) {
		env[agentDirEnvName] = options.agentDir;
	} else if (isolatedAgentDir) {
		env[agentDirEnvName] = isolatedAgentDir;
	}
	if (options.mode === "tui") {
		env[startupBenchmarkEnvName] = "1";
		env.PI_TIMING = "1";
	}
	if (options.offline) {
		env.PI_OFFLINE = "1";
		env.PI_SKIP_VERSION_CHECK = "1";
	}
	return env;
}

async function runTuiBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(runtime, "tui", profileDir, profileName, options.cpuProfile, options.session);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["inherit", "inherit", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	const stopMemorySampler = startMemorySampler(child);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const startedAt = performance.now();
	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);
	const elapsedMs = performance.now() - startedAt;
	const sampledPeakRssBytes = stopMemorySampler();

	try {
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		const benchmarkStats = parseBenchmarkStats(stderr);
		return {
			elapsedMs,
			profilePath,
			timings: parseStartupTimings(stderr),
			peakRssBytes: Math.max(sampledPeakRssBytes ?? 0, benchmarkStats.rssBytes ?? 0) || null,
			maxEventLoopBlockMs: benchmarkStats.maxEventLoopBlockMs,
			sessionOpenEventLoopBlockMs: benchmarkStats.sessionOpenEventLoopBlockMs,
			runtimeEventLoopBlockMs: benchmarkStats.runtimeEventLoopBlockMs,
			interactiveInitEventLoopBlockMs: benchmarkStats.interactiveInitEventLoopBlockMs,
		};
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

function splitJsonLines(buffer, onLine) {
	let remaining = buffer;
	while (true) {
		const newlineIndex = remaining.indexOf("\n");
		if (newlineIndex === -1) {
			return remaining;
		}
		const line = remaining.slice(0, newlineIndex);
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		remaining = remaining.slice(newlineIndex + 1);
	}
}

async function runRpcBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "pi-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(runtime, "rpc", profileDir, profileName, options.cpuProfile, options.session);
	const child = spawn(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["pipe", "pipe", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stdoutBuffer = "";
	let stderr = "";
	let readyElapsedMs;
	let responseError;
	const requestId = `startup-benchmark-${runNumber}`;
	const startedAt = performance.now();

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer = splitJsonLines(stdoutBuffer + chunk, (line) => {
			if (line.trim() === "") {
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				responseError = error instanceof Error ? error.message : String(error);
				return;
			}

			if (parsed?.type !== "response" || parsed.id !== requestId || parsed.command !== "get_state") {
				return;
			}

			if (parsed.success !== true) {
				responseError = typeof parsed.error === "string" ? parsed.error : "get_state failed";
				return;
			}

			if (readyElapsedMs === undefined) {
				readyElapsedMs = performance.now() - startedAt;
				child.stdin.end();
			}
		});
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	child.stdin.setDefaultEncoding("utf8");
	child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);

	const exitCode = await waitForExit(child, `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`);

	try {
		if (responseError) {
			throw new Error(responseError);
		}
		if (readyElapsedMs === undefined) {
			throw new Error(stderr.trim() || "RPC benchmark did not receive get_state response");
		}
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs: readyElapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

async function runBenchmarkRun(params) {
	if (params.options.mode === "rpc") {
		return await runRpcBenchmarkRun(params);
	}
	return await runTuiBenchmarkRun(params);
}

function getSessionBytes(sessionPath) {
	if (!sessionPath) {
		return null;
	}
	const stats = statSync(sessionPath);
	if (!stats.isFile()) {
		throw new Error(`Session path is not a file: ${sessionPath}`);
	}
	return stats.size;
}

function cumulativeSessionTiming(timings, target) {
	let total = 0;
	for (const label of ["T_shell", "T_tail", "T_context_ready"]) {
		const value = timings.get(`sessionOpening.${label}`);
		if (value !== undefined) total += value;
		if (label === target) return value === undefined ? null : total;
	}
	return null;
}

function createJsonRun(sessionBytes, run, result) {
	return {
		sessionBytes,
		run,
		readyMs: result.elapsedMs,
		T_shell: cumulativeSessionTiming(result.timings, "T_shell"),
		T_tail: cumulativeSessionTiming(result.timings, "T_tail"),
		T_context_ready: cumulativeSessionTiming(result.timings, "T_context_ready"),
		T_index_ready: null,
		M_peak: result.peakRssBytes,
		R_resize: null,
		maxEventLoopBlock: result.maxEventLoopBlockMs ?? null,
		sessionOpenEventLoopBlock: result.sessionOpenEventLoopBlockMs ?? null,
		runtimeEventLoopBlock: result.runtimeEventLoopBlockMs ?? null,
		interactiveInitEventLoopBlock: result.interactiveInitEventLoopBlockMs ?? null,
		startupTimings: Object.fromEntries(result.timings),
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	if (options.agentDir && options.isolatedAgentDir) {
		throw new Error("--agent-dir and --isolated-agent-dir cannot be combined");
	}

	if (options.mode === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
		throw new Error("TUI benchmark must be run from an interactive terminal.");
	}

	const runtime = resolveRuntime(options.runtime);
	const sessionBytes = getSessionBytes(options.session);
	options.label = resolveLabel(options.mode, options.label);
	const profileDir = resolveProfileDir(runtime, options.profileDir);

	if (runtime === "node" && options.build) {
		await runBuild(options.json);
	}
	if (runtime === "bun" && !options.json) {
		process.stdout.write(
			`Using Bun runtime with ${options.mode === "rpc" ? "packages/coding-agent/src/cli.ts --mode rpc" : "packages/coding-agent/src/cli.ts"}\n`,
		);
	}

	const entryPath = runtime === "bun" ? srcCliPath : distCliPath;
	if (!existsSync(entryPath)) {
		throw new Error(`CLI entrypoint not found: ${entryPath}`);
	}

	mkdirSync(profileDir, { recursive: true });

	const measuredRuns = [];
	const totalRuns = options.warmup + options.runs;
	for (let runIndex = 0; runIndex < totalRuns; runIndex++) {
		const measuredIndex = runIndex >= options.warmup ? runIndex - options.warmup + 1 : undefined;
		const result = await runBenchmarkRun({
			runtime,
			runIndex,
			measuredIndex,
			options,
			profileDir,
		});

		if (!options.json) {
			process.stdout.write(
				`[${measuredIndex === undefined ? `warmup ${runIndex + 1}` : `run ${measuredIndex}`}] elapsed=${formatMs(result.elapsedMs)}\n`,
			);
		}

		if (measuredIndex !== undefined) {
			measuredRuns.push(result);
		}
	}

	if (measuredRuns.length === 0) {
		if (options.json) {
			process.stdout.write(`${JSON.stringify({ sessionBytes, runtime, mode: options.mode, runs: [] })}\n`);
		} else {
			process.stdout.write("\nNo measured runs requested.\n");
		}
		return;
	}

	const elapsedSummary = summarize(measuredRuns.map((run) => run.elapsedMs));
	const timingSummaries = summarizeTimingMaps(measuredRuns);
	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({
				sessionBytes,
				runtime,
				mode: options.mode,
				runs: measuredRuns.map((run, index) => createJsonRun(sessionBytes, index + 1, run)),
				summary: {
					readyMs: elapsedSummary,
					startupTimings: Object.fromEntries(timingSummaries),
				},
			})}\n`,
		);
		return;
	}
	const maxElapsedRun = measuredRuns.reduce((slowest, run) => (run.elapsedMs > slowest.elapsedMs ? run : slowest));
	if (measuredRuns.length === 1) {
		process.stdout.write("\nResult\n");
		process.stdout.write(`  runtime:          ${runtime}\n`);
		process.stdout.write(`  mode:             ${options.mode}\n`);
		process.stdout.write(`  elapsed:          ${formatMs(measuredRuns[0].elapsedMs)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`  ${label}: ${formatMs(summary.median)}\n`);
		}
		if (options.cpuProfile && maxElapsedRun.profilePath) {
			process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
			process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
		}
		process.stdout.write(`METRIC startup_time_ms=${measuredRuns[0].elapsedMs.toFixed(1)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
		}
		return;
	}

	process.stdout.write("\nSummary\n");
	process.stdout.write(`  runtime:          ${runtime}\n`);
	process.stdout.write(`  mode:             ${options.mode}\n`);
	process.stdout.write(`  elapsed min:      ${formatMs(elapsedSummary.min)}\n`);
	process.stdout.write(`  elapsed median:   ${formatMs(elapsedSummary.median)}\n`);
	process.stdout.write(`  elapsed avg:      ${formatMs(elapsedSummary.avg)}\n`);
	process.stdout.write(`  elapsed max:      ${formatMs(elapsedSummary.max)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`  ${label} median: ${formatMs(summary.median)}\n`);
	}
	if (options.cpuProfile && maxElapsedRun.profilePath) {
		process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
		process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
	}
	process.stdout.write(`METRIC startup_time_ms=${elapsedSummary.median.toFixed(1)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
