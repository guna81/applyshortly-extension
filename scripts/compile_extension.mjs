#!/usr/bin/env node
import { build } from "esbuild";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const srcDir = join(root, "extension/src");

function findTsFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        results.push(...findTsFiles(full));
      } else if (full.endsWith(".ts")) {
        results.push(full);
      }
    }
  } catch {
    return [];
  }
  return results;
}

const tsFiles = findTsFiles(srcDir);
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const outDir = args.find((a) => !a.startsWith("--")) || join(root, "dist/extension/src");

if (tsFiles.length === 0) {
  if (jsonMode) process.stdout.write("{}");
  process.exit(0);
}

const result = await build({
  entryPoints: tsFiles,
  write: !jsonMode,
  outdir: outDir,
  outbase: srcDir,
  format: "esm",
  target: "es2022",
  logLevel: "error",
});

if (jsonMode) {
  const map = {};
  for (const file of result.outputFiles) {
    const rel = join("src", relative(outDir, file.path)).replace(/\\/g, "/");
    map[rel] = Buffer.from(file.contents).toString("base64");
  }
  process.stdout.write(JSON.stringify(map));
}
