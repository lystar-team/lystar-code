import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepSeekHarnessBundlePlugin } from "../packages/deepseek-harness/bundle-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [target, outfile] = process.argv.slice(2);
if (!target || !outfile) throw new Error("Usage: bun scripts/build-coding-agent-binary.mjs <target|current> <outfile>");

const outputFile = resolve(outfile);
// Worker 入口沿用运行时使用的包内相对路径，与调用构建脚本的目录无关。
process.chdir(join(root, "packages/coding-agent"));

const result = await Bun.build({
	entrypoints: [
		"../../scripts/lystar-bun-cli.mjs",
		"./src/utils/image-resize-worker.ts",
		"./src/extensions/codemode/worker.ts",
		"./src/bun/workspace-database-worker.mjs",
	],
	tsconfig: join(root, "tsconfig.base.json"),
	compile: { ...(target === "current" ? {} : { target }), outfile: outputFile, autoloadBunfig: false, autoloadDotenv: false },
	plugins: [deepSeekHarnessBundlePlugin()],
});
if (!result.success) throw new AggregateError(result.logs, "LYStar binary build failed");
