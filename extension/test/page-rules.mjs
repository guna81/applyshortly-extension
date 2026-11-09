// The agent page script's own text rules (shared with the platform's server driver), for fake
// drivers to answer `holdsTyped` / `showsChoice` with the real implementation, not a copy.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://careers.example.com/apply", runScripts: "outside-only" });
dom.window.CSS = { escape: (x) => String(x) };
dom.window.eval(readFileSync(new URL("../src/fill.js", import.meta.url), "utf8"));
dom.window.eval(readFileSync(new URL("../src/agent/page.js", import.meta.url), "utf8"));

export const PAGE = dom.window.JobHuntAgentPage;
export const isPageRule = (name) => name === "holdsTyped" || name === "showsChoice";
