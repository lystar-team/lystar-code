import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SUITES = new Set(["core", "web"]);

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		const value = argv[index + 1];
		if (argument === "--suite") options.suite = value;
		else if (argument === "--plan-json-env") options.planJsonEnv = value;
		else throw new Error(`Unknown argument: ${argument}`);
		index++;
	}
	return options;
}

export function runAffectedTests({ suite, plan }) {
	if (!SUITES.has(suite)) throw new Error(`Unsupported affected test suite: ${suite}`);
	const packages = plan?.tests?.[suite];
	if (!Array.isArray(packages)) throw new Error(`Plan does not contain tests for suite: ${suite}`);
	if (packages.length === 0) {
		console.log(`No affected ${suite} workspaces; tests skipped.`);
		return;
	}

	for (const packageName of packages) {
		console.log(`Testing ${packageName}...`);
		const result = spawnSync("npm", ["--workspace", packageName, "test"], {
			encoding: "utf8",
			stdio: "inherit",
		});
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
}

export function runCli(argv = process.argv.slice(2)) {
	const options = parseArguments(argv);
	if (!options.suite) throw new Error("--suite is required");
	if (!options.planJsonEnv) throw new Error("--plan-json-env is required");
	const value = process.env[options.planJsonEnv];
	if (!value) throw new Error(`Missing plan JSON environment variable: ${options.planJsonEnv}`);
	runAffectedTests({ suite: options.suite, plan: JSON.parse(value) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
