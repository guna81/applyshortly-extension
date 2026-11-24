#!/usr/bin/env node
// Compiles the shared form agent core into a standalone Node 22 ESM bundle
// plus the isolated-world page scripts (profile-answer.js, dom.js, page.js)
// for consumption by apply-assistant/browser-runner.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const outDir = outArg || join(root, "dist/server-agent");
mkdirSync(outDir, { recursive: true });

// 1. Bundle server-entry.ts + @langchain/langgraph into one Node 22 ESM module.
await build({
  entryPoints: [join(root, "extension/src/server-entry.ts")],
  outfile: join(outDir, "agent-core.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "error",
});

// 2. Compile the isolated-world page scripts injected into target tabs by TabDriver.
const pageScripts = [
  ["extension/src/page-control/phone.ts", "phone.js"],
  ["extension/src/page-control/dom.ts", "dom.js"],
  ["extension/src/page-control/page.ts", "page.js"],
];

for (const [src, dest] of pageScripts) {
  await build({
    entryPoints: [join(root, src)],
    outfile: join(outDir, dest),
    bundle: false,
    format: "iife",
    target: "es2022",
    logLevel: "error",
  });
}

console.log(`Built server agent bundle in ${outDir}`);
