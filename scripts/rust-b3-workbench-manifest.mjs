import { readFileSync } from "node:fs";

const manifestUrl = new URL("../benchmarks/rust-b3-workbench-scenarios.json", import.meta.url);

export const rustB3WorkbenchManifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
