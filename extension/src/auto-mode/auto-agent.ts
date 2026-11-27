// Hybrid "Auto mode" form agent: runs deterministic rules first on each form step (0 LLM calls),
// then hands off to the Agent engine for review and completion when credits / Custom AI are available,
// or finishes / falls back to full rules when credits are unavailable.
import { CREDIT_FALLBACK_NOTICE, hasApplicationFields, isInsufficientCreditsError } from "../page-control/loop.js";

export interface AutoAgentOptions {
  canUseAgent?: () => Promise<boolean> | boolean;
}

const pageKeyOf = (obs: any): string => JSON.stringify([String(obs?.url ?? ""), String(obs?.document_id ?? "")]);

const isCleanComplete = (h: any): boolean => Boolean(
  h && h.hasFields && h.missingRequiredCount === 0 && h.emptyOptionalCount === 0 && !h.hasErrors && !h.hasNavButton && (h.failedFields?.length ?? 0) === 0,
);

const mergeFilledLists = (baseMap: Record<string, any>, incoming: any[]): any[] => {
  const out = new Map<string, any>();
  for (const entry of Object.values(baseMap)) {
    if (entry?.label) out.set(`${entry.label}|${entry.kind ?? ""}`, entry);
  }
  for (const entry of (Array.isArray(incoming) ? incoming : [])) {
    if (entry?.label) out.set(`${entry.label}|${entry.kind ?? ""}`, entry);
  }
  return [...out.values()];
};

export function autoAgent(
  createRulePhase: () => (body: any) => Promise<any>,
  createAgentPhase: () => (body: any) => Promise<any>,
  createRuleFallback: () => (body: any) => Promise<any>,
  options: AutoAgentOptions = {},
): (body: any) => Promise<any> {
  let phase: "rule" | "agent" | "rule_only" = "rule";
  let currentPageKey: string | null = null;
  let hadFieldsOnStep = false;
  let ruleStep: ((body: any) => Promise<any>) | null = null;
  let agentStep: ((body: any) => Promise<any>) | null = null;
  let fallbackStep: ((body: any) => Promise<any>) | null = null;
  let pendingAgentResults: any[] = [];
  let mergedRuleFilled: Record<string, any> = {};

  const checkCanUseAgent = async (): Promise<boolean> => {
    if (!options.canUseAgent) return true;
    try { return Boolean(await options.canUseAgent()); }
    catch { return true; }
  };

  const withFilled = (res: any, preMessages?: string[]) => ({
    ...res,
    filled: mergeFilledLists(mergedRuleFilled, res?.filled),
    ...(preMessages?.length ? { pre_messages: preMessages } : {}),
  });

  const runRuleOnly = async (body: any, notice = "", preMessages?: string[]): Promise<any> => {
    phase = "rule_only";
    fallbackStep ??= createRuleFallback();
    const res = await fallbackStep({ ...body, results: [] });
    const message = notice
      ? (res.message ? `${notice} ${res.message}` : notice)
      : res.message;
    return withFilled({ ...res, message }, preMessages);
  };

  return async function step(body: any): Promise<any> {
    const obs = body?.observation ?? { url: "", elements: [] };
    const nextPageKey = pageKeyOf(obs);

    // On a new page/step after the Agent navigated, or when an SPA gate (e.g. privacy modal)
    // transitions from 0 application fields to a real form on the same URL, loop back to RULE_FILL for free.
    const nowHasFields = hasApplicationFields(obs);
    const stepRevealedForm = !hadFieldsOnStep && nowHasFields;
    if (phase === "agent" && currentPageKey !== null && (nextPageKey !== currentPageKey || stepRevealedForm) && !body?.user_message) {
      pendingAgentResults = Array.isArray(body?.results) ? body.results : [];
      phase = "rule";
      ruleStep = createRulePhase();
      currentPageKey = nextPageKey;
      hadFieldsOnStep = nowHasFields;
      body = { ...body, results: [] };
    } else if (currentPageKey === null) {
      currentPageKey = nextPageKey;
      hadFieldsOnStep = nowHasFields;
    }

    // Conversational chat message mid-rule-phase: route straight to Agent if available.
    if (phase === "rule" && body?.user_message && (await checkCanUseAgent())) {
      phase = "agent";
      agentStep ??= createAgentPhase();
      try {
        const res = await agentStep({ ...body, results: pendingAgentResults.splice(0) });
        return withFilled(res);
      } catch (error) {
        if (!isInsufficientCreditsError(error)) throw error;
        return runRuleOnly(body, CREDIT_FALLBACK_NOTICE);
      }
    }

    if (phase === "rule_only") {
      fallbackStep ??= createRuleFallback();
      const res = await fallbackStep(body);
      return withFilled(res);
    }

    if (phase === "agent") {
      agentStep ??= createAgentPhase();
      try {
        const res = await agentStep(body);
        return withFilled(res);
      } catch (error) {
        if (!isInsufficientCreditsError(error)) throw error;
        return runRuleOnly(body, CREDIT_FALLBACK_NOTICE);
      }
    }

    // Phase 1: deterministic Rule pass (0 LLM calls).
    ruleStep ??= createRulePhase();
    const ruleRes = await ruleStep(body);
    if (ruleRes?.status !== "handoff") {
      return { ...ruleRes, filled: mergeFilledLists(mergedRuleFilled, ruleRes?.filled) };
    }

    const h = ruleRes.handoff ?? {};
    if (h.filled && typeof h.filled === "object") {
      mergedRuleFilled = { ...mergedRuleFilled, ...h.filled };
    }
    const cleanComplete = isCleanComplete(h);
    const hasAgent = await checkCanUseAgent();

    const ruleSummary = String(ruleRes.message ?? "").trim();
    const preMessages = ruleSummary ? [ruleSummary] : undefined;

    if (!hasAgent) {
      if (cleanComplete) {
        return withFilled({
          ...ruleRes,
          status: "ready_for_review",
          actions: [],
          message: ruleSummary
            ? `${ruleSummary} Please review and submit your application.`
            : "Please review and submit your application.",
        });
      }
      return runRuleOnly(body, "", preMessages);
    }

    // Phase 2: Agent review & completion pass (always at least 1 review turn when credits / Custom AI are available).
    phase = "agent";
    hadFieldsOnStep = Boolean(h.hasFields ?? nowHasFields);
    agentStep ??= createAgentPhase();
    const handoffContext = {
      filled: h.filled ?? {},
      wrote: Array.isArray(h.wrote) ? h.wrote : [],
      writeValues: h.writeValues ?? {},
      failedFields: Array.isArray(h.failedFields) ? h.failedFields : [],
      summary: ruleSummary,
    };
    const agentBody = {
      ...body,
      results: pendingAgentResults.splice(0),
      handoff_context: handoffContext,
    };
    try {
      const agentRes = await agentStep(agentBody);
      return withFilled(agentRes, preMessages);
    } catch (error) {
      if (!isInsufficientCreditsError(error)) throw error;
      if (cleanComplete) {
        return withFilled({
          ...ruleRes,
          status: "ready_for_review",
          actions: [],
          message: ruleSummary
            ? `${ruleSummary} Please review and submit your application.`
            : "Please review and submit your application.",
        });
      }
      return runRuleOnly(body, CREDIT_FALLBACK_NOTICE, preMessages);
    }
  };
}
