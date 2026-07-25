import { readFileSync, writeFileSync } from "node:fs";

const [path, version, repository = ""] = process.argv.slice(2);
if (!path || !version) {
	console.error("Usage: node scripts/prepare-release-package.mjs <package.json> <version> [owner/repo]");
	process.exit(2);
}

const packageJson = JSON.parse(readFileSync(path, "utf8"));
packageJson.piConfig = {
	...(packageJson.piConfig ?? {}),
	productVersion: version,
};
if (repository) packageJson.piConfig.releaseRepository = repository;
else delete packageJson.piConfig.releaseRepository;
writeFileSync(path, `${JSON.stringify(packageJson, null, "\t")}\n`);
