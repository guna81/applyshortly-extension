#!/usr/bin/env node
// Prints extension/src/agent-based/langgraph.js bundled with LangGraph JS and its dependencies as ONE ES module (no bare imports,
// no eval, no Node-only code). Called by scripts/build_extension.py; needs `npm ci`.
import { build } from "esbuild";
import { existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const entry = existsSync(new URL("extension/src/agent-based/langgraph.ts", root))
  ? new URL("extension/src/agent-based/langgraph.ts", root).pathname
  : new URL("extension/src/agent-based/langgraph.js", root).pathname;
const result = await build({
  entryPoints: [entry],
  bundle: true, format: "esm", platform: "browser", target: "chrome120", minify: true, legalComments: "none", write: false, logLevel: "error",
});
process.stdout.write(result.outputFiles[0].contents);
