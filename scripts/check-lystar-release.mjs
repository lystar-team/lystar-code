import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { findPackageDirectories } from "./package-workspaces.mjs";

const product = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf8"));
const version = product.piConfig.productVersion;
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const packages = findPackageDirectories()
	.filter((directory) => directory !== "packages/coding-agent/install-lock")
	.map((directory) => ({ directory, manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) }));
const versions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]));
const errors = [];

if (!/^\d+\.\d+\.\d+-lystar\.\d+$/.test(version)) errors.push(`无效发行版本：${version}`);
if (product.piConfig.releaseRepository !== "lystar-team/lystar-code") errors.push("发行仓库配置不正确");
for (const { directory, manifest } of packages) {
	if (!manifest.private && manifest.version !== version) errors.push(`${directory} 版本与 ${version} 不一致`);
	for (const field of dependencyFields) {
		for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
			if (versions.has(name) && specifier !== versions.get(name)) {
				errors.push(`${directory} 的 ${field}.${name} 未同步为 ${versions.get(name)}`);
			}
		}
	}
}
for (const [directory, entry] of Object.entries(lock.packages)) {
	if (directory.includes("node_modules")) continue;
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	if (entry.version !== manifest.version) errors.push(`${directory || "."} 的锁文件版本未同步`);
	for (const field of dependencyFields) {
		if (!isDeepStrictEqual(entry[field] ?? {}, manifest[field] ?? {})) {
			errors.push(`${directory || "."} 的锁文件 ${field} 未同步`);
		}
	}
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(`发行版本 ${version}、workspace 内部依赖和根锁文件一致。`);
