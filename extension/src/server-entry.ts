// Platform-agnostic server entry for the shared ApplyShortly form agent core.
// Consumed by apply-assistant/browser-runner (Node 22 + Playwright) via scripts/compile_server_bundle.mjs.
export { formAgent, MAX_INPUT_TOKENS } from "./agent-based/form-agent.js";
export type { FormAgentOptions } from "./agent-based/form-agent.js";
export { createGuards, newGuardState, questionKey } from "./agent-based/agent-guards.js";
export { buildSystem, snapshotText, snapElement, stubText } from "./agent-based/agent-prompt.js";
export { TOOL_CATALOG, clickAtRef, findElements, briefElement, normalizeObservation, describeAction, describeResult } from "./agent-based/tools.js";
export { ruleAgent } from "./rule-based/rule-agent.js";
export { autoAgent } from "./auto-mode/auto-agent.js";
export type { AutoAgentOptions } from "./auto-mode/auto-agent.js";
export { TabDriver, DialogOpenError, jpegSize, redactUrl } from "./page-control/cdp.js";
export type { CdpApi, CdpDebuggee, CdpTabInfo, DialogInfo } from "./page-control/cdp.js";
export { CommandRunner, scanFields, readinessOf, choiceGroup, isChoiceOption, matchChoice, optionsOf } from "./page-control/commands.js";
export { Agent, ProgressGuard, observeTab, execute, hasApplicationFields, questionChoices, comboView } from "./page-control/loop.js";
export { candidateContext } from "./shared/candidate-context.js";
export { modelBody } from "./shared/model-turn.js";
export { fetchPage } from "./shared/web-fetch.js";
