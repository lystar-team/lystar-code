import { main } from "../../../coding-agent/src/main.ts";
import { runEmbeddedRustTui } from "../../src/rust-tui-frontend.ts";

await main(process.argv.slice(2), { rustTuiFrontend: runEmbeddedRustTui });
