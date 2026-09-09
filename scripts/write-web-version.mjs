#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const outputArg = process.argv[2] ?? "packages/web/dist";
const outputDir = resolve(outputArg);
const root = fileURLToPath(new URL("..", import.meta.url));
const codingAgentPackage = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
const webPackage = JSON.parse(readFileSync(join(root, "packages/web/package.json"), "utf8"));
const productVersion = codingAgentPackage.piConfig?.productVersion ?? codingAgentPackage.version;
if (!productVersion) throw new Error("packages/coding-agent/package.json 缺少 productVersion");
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
writeFileSync(
	join(outputDir, "version.json"),
	`${JSON.stringify({ productVersion, webPackageVersion: webPackage.version }, null, "\t")}\n`,
);
