import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Preserve DSH's published identity when the original module loses its package directory. */
export function deepSeekHarnessBundlePlugin({ resolveDir = false } = {}) {
	return {
		name: "deepseek-harness-package-identity",
		setup(build) {
			build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, (args) => {
				const source = readFileSync(args.path, "utf8");
				const lookup = 'createRequire(import.meta.url)("../package.json")';
				if (!source.includes(lookup)) throw new Error("DSH LLM package identity lookup changed; review the bundle adapter");
				const { version } = JSON.parse(readFileSync(join(dirname(args.path), "..", "package.json"), "utf8"));
				return {
					contents: source.replace(lookup, JSON.stringify({ version })),
					loader: "js",
					...(resolveDir ? { resolveDir: dirname(args.path) } : {}),
				};
			});
		},
	};
}
