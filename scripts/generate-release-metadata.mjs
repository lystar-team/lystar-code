import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [outputArg, version, repository = ""] = process.argv.slice(2);
if (!outputArg || !version) {
	console.error("Usage: node scripts/generate-release-metadata.mjs <output-dir> <version> [owner/repo]");
	process.exit(2);
}

const outputDir = resolve(outputArg);
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
const assets = {};
const sums = [];
for (const platform of platforms) {
	const extension = platform.startsWith("windows-") ? "zip" : "tar.gz";
	const file = `lystar-agent-v${version}-${platform}.${extension}`;
	const path = join(outputDir, file);
	if (!existsSync(path)) continue;
	const bytes = readFileSync(path);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	assets[platform] = { file, sha256, size: statSync(path).size };
	sums.push(`${sha256}  ${file}`);
}

const manifest = {
	version,
	piVersion: version.split("-lystar.")[0],
	channel: "stable",
	publishedAt: new Date().toISOString(),
	...(repository ? { repository } : {}),
	assets,
};
writeFileSync(join(outputDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(outputDir, "SHA256SUMS"), `${sums.join("\n")}\n`);

for (const name of ["install.sh", "install.ps1"]) {
	const source = readFileSync(resolve("scripts", name), "utf8");
	const materialized = source.replaceAll(
		"__LYSTAR_RELEASE_REPOSITORY__",
		repository || "__LYSTAR_RELEASE_REPOSITORY__",
	);
	writeFileSync(join(outputDir, basename(name)), materialized, { mode: name.endsWith(".sh") ? 0o755 : 0o644 });
}
