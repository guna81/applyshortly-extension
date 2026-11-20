// Added 2026-11-18. The Agent based form assistant agent is generic: it works from roles, labels and states on any form. Its own files may never name a
// company, an applicant-tracking system, a job board or a form-specific label. (The rule based form assistant engine legitimately has ATS adapters; it is not checked here.)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// Every file of the Agent based form assistant agent (a new file there is checked too).
const FILES = readdirSync(new URL("../src/agent-based/", import.meta.url)).filter((f) => f.endsWith(".js"));
const NAMES = /greenhouse|ashby|workable|lever\b|workday|smartrecruiters|icims|taleo|bamboo|recruitee|jobvite|teamtailor|personio|breezy|rippling|linkedin|naukri|indeed|glassdoor|monster|ziprecruiter|wellhub|clickhouse|gitlab|credo ?ai|level ?ai|acme\b/i;
const LABELS = /how did you hear|preferred first name|pronouns?:|linkedin url|current employer|desired salary|notice period/i;

for (const file of FILES) {
  test(`${file} names no company, ATS, job board or form-specific label`, () => {
    const code = readFileSync(new URL(`../src/agent-based/${file}`, import.meta.url), "utf8");
    const hit = NAMES.exec(code) ?? LABELS.exec(code);
    assert.equal(hit, null, `${file} mentions "${hit?.[0]}": the Agent based form assistant agent must stay generic`);
  });
}
