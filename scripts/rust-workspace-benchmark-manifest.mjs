import { readFileSync } from "node:fs";

const manifestUrl = new URL("../benchmarks/rust-workspace-benchmark-scenarios.json", import.meta.url);

export const rustWorkspaceWorkbenchManifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
