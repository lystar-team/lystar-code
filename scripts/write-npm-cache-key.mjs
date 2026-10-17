import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
// npm 缓存保存下载内容；workspace 版本变化不改变外部依赖的下载内容。
const dependencies = Object.fromEntries(Object.entries(lock.packages)
	.filter(([path, entry]) => path.includes("node_modules/") && !entry.link)
	.sort(([left], [right]) => left.localeCompare(right)));
mkdirSync(".artifacts", { recursive: true });
writeFileSync(".artifacts/npm-cache-key.json", `${JSON.stringify(dependencies)}\n`);
