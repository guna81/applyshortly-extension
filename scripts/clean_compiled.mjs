#!/usr/bin/env node
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const srcDir = join(root, "extension/src");

function cleanJs(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        cleanJs(full);
      } else if (full.endsWith(".js") && entry !== "agent-rules.js") {
        unlinkSync(full);
      }
    } catch {}
  }
}

cleanJs(srcDir);
