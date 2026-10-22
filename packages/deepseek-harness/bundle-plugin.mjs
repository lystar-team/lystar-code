import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Preserve DSH package identity and native dependencies in bundled hosts. */
export function deepSeekHarnessBundlePlugin({ resolveDir = false, nativeAddons = false } = {}) {
	return {
		name: "deepseek-harness-package-identity",
		setup(build) {
			if (nativeAddons) {
				build.onLoad({ filter: /[\\/]koffi[\\/]src[\\/]koffi[\\/]src[\\/]static\.js$/ }, (args) => {
					const source = readFileSync(args.path, "utf8");
					const binding = 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n';
					if (!source.includes(binding)) throw new Error("Koffi native module loading changed; review the binary adapter");
					return { contents: source.replace(binding, ""), loader: "js" };
				});
			}
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
