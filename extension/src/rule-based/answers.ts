// Deterministic answer resolution. No provider or agent dependency.
(() => {
  async function resolveAnswer(field, state, suggest) {
    if (field.consent) return null;
    if (field.kind === "text" && field.el.matches('input[type=date], input.ashby-application-form-input-date')) {
      const prefs = state.ctx.profile.preferences;
      let value = prefs?.available_from;
      if (!value && prefs?.notice_period_days === 0) {
        const today = new Date();
        value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      }
      return value ? { value, source: "profile", needsReview: false } : null;
    }
    const local = globalThis.JobHuntProfile.profileAnswer(field.label, state.ctx.profile, state.ctx.app);
    if (local) return { value: local.value, source: "profile", needsReview: local.needsReview };
    if (!field.label) return null;
    // Long questions ("Current CTC? Mention fixed and variable components separately.") match the
    // answer bank poorly as a whole, so retry the lookup with just the first sentence.
    const head = globalThis.JobHuntFill.firstSentence(field.label);
    const attempts = head !== field.label ? [field.label, head] : [field.label];
    for (const question of attempts) {
      try {
        const s: any = await suggest(question, state.appId);
        if (s.answer) return { value: s.answer, source: s.source, needsReview: s.needs_review };
      } catch (err: any) {
        console.warn("[JobHunt] suggest failed:", err?.message);
        return null;
      }
    }
    return null;
  }

  (globalThis as any).JobHuntRuleEngine = { resolveAnswer };
})();
