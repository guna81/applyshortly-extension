import assert from "node:assert/strict";
import { test } from "node:test";
import { customPlanner } from "../src/custom-agent.js";
import { assertRefused } from "./refusal.mjs";

const field = { ref: "0.1", name: "Describe a project", role: "textarea", value: "", required: true };
const body = (element = field, extra = {}) => ({ observation: { observation_id: "obs", url: "https://jobs.example/apply", elements: [element], screenshot: "private-image" }, results: [], ...extra });
const planner = (response, calls = [], allowDrafts = true) => customPlanner({}, { full_name: "Candidate" }, {}, async (_config, messages) => { calls.push(messages); return JSON.stringify(response); }, undefined, allowDrafts);

test("custom planner sends context to the provider and issues a fresh guarded command", async () => {
  const calls = [];
  // "Let AI answer" off: a long answer is offered as a question first, and written only when the user taps Draft it for me.
  const step = planner({ status: "continue", message: "Filling project", action: { type: "type", ref: "0.1", text: "* **Outcome:** Built a system." } }, calls, false);
  assert.equal((await step(body())).status, "ask_user");
  const result = await step(body(field, { user_reply: "Draft it for me" }));
  assert.equal(result.guarded_commands, true);
  assert.equal(result.agent_engine, "ai_led");
  assert.equal(result.actions[0].observation_id, "obs");
  assert.equal(result.actions[0].text, "• Outcome: Built a system.");
  assert.ok(result.actions[0].command_id);
  assert.doesNotMatch(JSON.stringify(calls), /private-image/);
  assert.match(JSON.stringify(calls), /Candidate/);
});

test("custom planner rejects unsafe, stale, or unsolicited changes", async () => {
  for (const [action, observed, extra] of [
    [{ type: "click", ref: "0.1" }, { ...field, role: "button", name: "Submit application", submit_like: true }, {}],
    [{ type: "type", ref: "unknown", text: "x" }, field, {}],
    [{ type: "type", ref: "0.1", text: "x" }, { ...field, value: "Existing" }, {}],
    [{ type: "type", ref: "0.1", text: "x" }, { ...field, value: "Existing" }, { user_message: "continue" }],
    [{ type: "type", ref: "0.1", text: "x" }, field, { inspect_only: true }],
    [{ type: "check", ref: "0.1" }, { ...field, role: "checkbox", name: "I agree" }, {}],
  ]) {
    const step = planner({ status: "continue", message: "Changing", action });
    await assertRefused(step, body(observed, extra), /./);
  }
});

test("custom planner asks about optional unanswered fields before finishing", async () => {
  const step = planner({ status: "ready_for_review", message: "Ready" });
  const optional = { ...field, required: false };
  const first = await step(body(optional));
  assert.equal(first.status, "ask_user");
  assert.equal(first.question.optional, true);
  const review = await step(body(optional, { skip_question: true }));
  assert.equal(review.actions[0].type, "review");
  const ready = await step(body(optional, { results: [{ command_id: review.actions[0].command_id, ok: true, result: { type: "review", missing_required: [], needs_confirmation: [], errors: [] } }] }));
  assert.equal(ready.status, "ready_for_review");
});

test("custom planner asks instead of claiming completion with a required answer missing", async () => {
  const step = planner({ status: "ready_for_review", message: "Ready" });
  const result = await step(body());
  assert.equal(result.status, "ask_user");
  assert.equal(result.question.ref, "0.1");
});

test("verified custom AI answers are marked for review", async () => {
  let calls = 0;
  const step = customPlanner({}, {}, {}, async () => JSON.stringify(++calls <= 2
    ? { status: "continue", message: "Filling project", action: { type: "type", ref: "0.1", text: "Built a system." } }
    : { status: "ready_for_review", message: "Review" }));
  await step(body());
  const written = await step(body(field, { user_reply: "Draft it for me" }));
  const result = await step(body({ ...field, value: "Built a system." }, { results: [{ command_id: written.actions[0].command_id, ok: true, result: { verified: true } }] }));
  assert.equal(result.filled[0].needs_review, true);
  assert.equal(result.filled[0].source, "llm");
});

test("saved answers are looked up without generating a platform answer and offered to the model as the answer", async () => {
  const calls = [];
  const lookedUp = [];
  const step = customPlanner({}, {}, {}, async (_config, messages) => {
    calls.push(JSON.parse(messages[1].content));
    return JSON.stringify({ status: "continue", message: "Filling", actions: [{ type: "type", ref: "0.1", text: calls[0].suggested_actions[0].text }] });
  }, async (question) => { lookedUp.push(question); return { answer: "Saved answer" }; });
  const result = await step(body());
  assert.deepEqual(lookedUp, ["Describe a project"]);
  assert.deepEqual(calls[0].saved_answers, { "Describe a project": "Saved answer" });
  assert.equal(result.actions[0].text, "Saved answer");
});

test("when drafts are disabled the planner asks instead of writing a new draft", async () => {
  const step = customPlanner({}, {}, {}, async () => JSON.stringify({ status: "continue", message: "Writing", action: { type: "type", ref: "0.1", text: "A new draft" } }), undefined, false);
  const result = await step(body());
  assert.equal(result.status, "ask_user");
  assert.equal(result.actions.length, 0);
  assert.equal(result.question.ref, "0.1");
});

test("check commands support choices without overwriting or approving consent", async () => {
  for (const role of ["radio", "checkbox"]) {
    const choice = { ...field, role, name: "Remote", group: "Work location" };
    const fresh = () => planner({ status: "continue", message: "Choosing", action: { type: "check", ref: "0.1", checked: true } });
    const result = await fresh()(body(choice));
    assert.equal(result.actions[0].checked, true);
    assert.equal(result.actions[0].type, "check");
    await assertRefused(fresh(), body({ ...choice, user_edited: true }), /./);
    // A consent checkbox is refused; a consent radio asks the user and lets the rest carry on.
    if (role === "checkbox") await assertRefused(fresh(), body({ ...choice, group: "Consent to terms" }), /./);
    else {
      const asked = await fresh()(body({ ...choice, group: "Consent to terms" }));
      assert.equal(asked.status, "ask_user");
      assert.deepEqual(asked.actions, []);
    }
    await assertRefused(fresh(), body(choice, { inspect_only: true }), /./);
  }
});

test("a choice question the user answered in the chat is not asked again", async () => {
  const options = ["she/her", "he/him", "they/them"].map((name, i) => ({ ref: `0.${i + 1}`, name, role: "radio", group: "Preferred Pronouns", required: false, value: "" }));
  const observation = (extra = {}) => ({ observation: { observation_id: "obs", url: "https://jobs.example/apply", elements: options }, results: [], ...extra });
  const replies = [
    { status: "continue", message: "Choosing", action: { type: "check", ref: "0.1", checked: true } },
    { status: "continue", message: "Choosing", action: { type: "check", ref: "0.2", checked: true } },
  ];
  let n = 0;
  const step = customPlanner({}, {}, {}, async () => JSON.stringify(replies[n++]));
  const asked = await step(observation());
  assert.equal(asked.status, "ask_user");
  assert.equal(asked.question.text, "Preferred Pronouns");
  const answered = await step(observation({ user_reply: "he/him" }));
  assert.equal(answered.status, "continue");
  assert.equal(answered.actions[0].type, "check");
  assert.equal(answered.actions[0].ref, "0.2");
});

test("explicit answers survive intermediate planner steps with drafts off", async () => {
  const seen = [];
  let count = 0;
  const step = customPlanner({}, {}, {}, async (_c, messages) => {
    const context = JSON.parse(messages[1].content);
    seen.push(context);
    return JSON.stringify(++count === 1
      ? { status: "ask_user", message: "Please answer", question: { kind: "question", text: "Describe", ref: "0.1" } }
      : count === 2 ? { status: "continue", message: "Checking", action: { type: "review" } }
        : { status: "continue", message: "Writing", action: { type: "type", ref: "0.1", text: context.suggested_actions[0].text } });
  }, undefined, false);
  await step(body());
  await step(body(field, { user_reply: "My own answer" }));
  assert.equal(seen[1].suggested_actions[0].text, "My own answer"); // the user's reply is grounded for the model
  const result = await step(body()); // a later planning turn still offers it
  assert.equal(seen[2].suggested_actions[0].text, "My own answer");
  assert.equal(result.actions[0].text, "My own answer");
});

test("invalid populated fields prevent planner readiness", async () => {
  const step = planner({ status: "ready_for_review", message: "Ready" });
  for (const required of [true, false]) {
    const result = await step(body({ ...field, value: "bad", invalid: true, required }));
    assert.equal(result.status, "ask_user");
    assert.equal(result.question.optional, false);
  }
});

test("consent choices require the user's answer before the provider can select them", async () => {
  const step = planner({ status: "continue", message: "Selecting", action: { type: "select", ref: "0.1", text: "Yes" } });
  const consent = { ...field, role: "select", name: "Authorized to call", required: true };
  const first = await step(body(consent));
  assert.equal(first.status, "ask_user");
  assert.equal(first.actions.length, 0);
  const second = await step(body(consent, { user_reply: "Yes" }));
  assert.equal(second.actions[0].type, "select");
});

const applyLink = { ref: "0.2", name: "Apply Now", role: "link", href: "https://ats.example/apply/1" };
const jobPage = (elements, extra = {}) => ({ observation: { observation_id: "obs", url: "https://jobs.example/role", elements }, results: [], ...extra });

test("custom planner follows an apply link to another site when the page has no form, at most twice", async () => {
  const step = planner({ status: "continue", message: "Opening the application", action: { type: "click", ref: "0.2" } });
  for (let i = 0; i < 2; i++) assert.equal((await step(jobPage([applyLink]))).actions[0].type, "click");
  const third = await step(jobPage([applyLink]));
  assert.equal(third.status, "ask_user");
  assert.deepEqual(third.actions, []);
});

test("custom planner will not leave the site through a link once the page has a form", async () => {
  const step = planner({ status: "continue", message: "Opening", action: { type: "click", ref: "0.2" } });
  await assertRefused(step, jobPage([field, { ...field, ref: "0.3", name: "Email" }, { ...field, ref: "0.4", name: "Phone" }, applyLink]), /./);
});

test("custom planner switches only to a tab the page opened", async () => {
  const step = planner({ status: "continue", message: "Opening the form", action: { type: "switch_tab", tab_id: 7 } });
  const ok = await step({ observation: { observation_id: "obs", url: "https://jobs.example/role", elements: [], tabs: [{ id: 7, url: "https://ats.example/apply/1", title: "Apply" }] }, results: [] });
  assert.equal(ok.actions[0].tab_id, 7);
  await assertRefused(step, jobPage([applyLink]), /./);
});

test("custom planner declines a cookie banner but never accepts it, without using a navigation", async () => {
  const reject = { ref: "0.5", name: "Reject Non-Essential", role: "button" };
  const accept = { ref: "0.6", name: "Accept All", role: "button" };
  const click = (ref) => planner({ status: "continue", message: "Cookies", action: { type: "click", ref } });
  for (let i = 0; i < 3; i++) assert.equal((await click("0.5")(jobPage([reject, accept]))).actions[0].type, "click");
  await assertRefused(click("0.6"), jobPage([reject, accept]), /./);
});

test("custom planner clicks an \"Opt out\" cookie/recording banner button even when the form is already on the page, but not \"Opt in\"", async () => {
  const field = (n) => ({ ref: `0.${n}`, role: "textbox", name: `Field ${n}`, input_type: "text" });
  const optOut = { ref: "0.9", name: "Opt out", role: "button" };
  const optIn = { ref: "0.8", name: "Opt in", role: "button" };
  const page = { observation: { observation_id: "obs", url: "https://jobs.example/apply", elements: [field(1), field(2), field(3), optOut, optIn], tabs: [] }, results: [] };
  const click = (ref) => planner({ status: "continue", message: "Cookies", action: { type: "click", ref } });
  assert.equal((await click("0.9")(page)).actions[0].type, "click");
  await assertRefused(click("0.8"), page, /direct approval/);
});

test("custom planner follows a plain \"Submit Resume\" link on a job page, but still refuses a submit button", async () => {
  const obs = (el) => ({ observation: { observation_id: "obs", url: "https://jobs.example/role", elements: [el], tabs: [] }, results: [] });
  const link = { ref: "0.1", role: "link", name: "Submit Resume", href: "https://jobs.example/submit-resume" };
  const result = await planner({ status: "continue", message: "Open", action: { type: "click", ref: "0.1" } })(obs(link));
  assert.equal(result.actions[0].type, "click");
  await assertRefused(planner({ status: "continue", message: "Go", action: { type: "click", ref: "0.1" } }), obs({ ...link, role: "button", href: null }), /direct approval/);
});

test("custom planner uploads the résumé to a lone generically-labelled file input, not to one of several", async () => {
  const file = { ref: "0.1", role: "file", name: "Click to upload PDF or Word document (max 5MB)" };
  const obs = (...els) => ({ observation: { observation_id: "obs", url: "https://jobs.example/apply", elements: els, tabs: [] }, results: [] });
  const up = () => customPlanner({}, { resume_url: 'https://files.example.test/resume.pdf' }, {}, async () => JSON.stringify({ status: "continue", message: "Attach", action: { type: "upload", ref: "0.1" } }));
  assert.equal((await up()(obs(file))).actions[0].file, "resume");
  for (const input of [obs(file, { ...file, ref: '0.2' }), obs({ ...file, name: 'Upload cover letter' })]) {
    const result = await up()(input);
    assert.equal(result.status, 'ask_user');
    assert.deepEqual(result.actions, []);
    assert.match(result.question.text, /Attach/);
  }
});

test("custom planner tells the model whether a profile résumé file exists, without sending its address", async () => {
  let sent;
  const run = async (profile) => {
    const step = customPlanner({}, profile, {}, async (_c, messages) => { sent = JSON.parse(messages[1].content); return JSON.stringify({ status: "ask_user", message: "x", question: { kind: "question", text: "x" } }); });
    await step({ observation: { observation_id: "o", url: "https://jobs.example/apply", elements: [], tabs: [] }, results: [] });
    return sent.candidate;
  };
  const withFile = await run({ full_name: "A", resume_url: "https://secret.example/r.pdf" });
  assert.equal(withFile.has_resume_file, true);
  assert.ok(!JSON.stringify(withFile).includes("secret.example"));
  assert.equal((await run({ full_name: "A" })).has_resume_file, false);
});

test("the standing 'tick privacy and terms boxes' setting lets the agent tick only acknowledgement checkboxes", async () => {
  const tick = { status: "continue", message: "Ticking consent", action: { type: "check", ref: "0.1", checked: true } };
  const box = (name) => ({ ...field, role: "checkbox", name, required: true });
  const withPrefs = (prefs) => customPlanner({}, { full_name: "Candidate", preferences: prefs }, {}, async () => JSON.stringify(tick));
  const on = withPrefs({ auto_consent: true });
  const result = await on(body(box("I consent to storing my information in line with the Privacy Policy.")));
  assert.equal(result.actions[0].type, "check");
  await assertRefused(withPrefs({ auto_consent: true }), body(box("I certify that the above is true and correct")), /direct approval/);
  await assertRefused(withPrefs({ auto_consent: true }), body(box("I agree I am authorized to work in India")), /direct approval/);
  await assertRefused(withPrefs({ auto_consent: false }), body(box("I accept the Terms and Privacy Policy")), /direct approval/);
  await assertRefused(withPrefs(null), body(box("I accept the Terms and Privacy Policy")), /direct approval/);
});

test("custom planner retrieves radio facts and carries saved demographics and time zones", async () => {
  const lookups = [];
  let candidate;
  const step = customPlanner({}, { gender: "Male", date_of_birth: "2000-01-01", preferences: { time_zone_regions: ["US"] } }, {}, async (_config, messages) => {
    const data = JSON.parse(messages[1].content);
    candidate = data.candidate;
    assert.equal(data.saved_answers["Comfortable with EST time zone?"], "Yes");
    return JSON.stringify({ status: "ask_user", message: "Continue", question: { kind: "click", text: "Continue?" } });
  }, async (label) => { lookups.push(label); return { answer: "Yes", needs_review: false }; });
  await step(body({ ...field, name: "Comfortable with EST time zone?", role: "radio", value: "yes", checked: false }));
  assert.equal(lookups.length, 1);
  assert.equal(candidate.gender, "Male");
  assert.equal(candidate.date_of_birth, "2000-01-01");
  assert.deepEqual(candidate.preferences.time_zone_regions, ["US"]);
});

test("custom planner does not treat a fuzzy answer needing review as an approved fact", async () => {
  const step = customPlanner({}, {}, {}, async (_config, messages) => {
    assert.deepEqual(JSON.parse(messages[1].content).saved_answers, {});
    return JSON.stringify({ status: "ask_user", message: "Need answer", question: { kind: "question", text: "Please confirm", ref: field.ref } });
  }, async () => ({ answer: "Old story", needs_review: true }));
  await step(body());
});

test("custom planner waits for a loading page, then asks the user after six waits in a row", async () => {
  const step = planner({ status: "continue", message: "Page still loading", action: { type: "wait" } });
  const loading = { observation: { observation_id: "obs", url: "https://jobs.example/role", text: "Loading…", elements: [], tabs: [] }, results: [] };
  for (let i = 0; i < 6; i++) {
    const waiting = await step(loading);
    assert.equal(waiting.status, "continue");
    assert.equal(waiting.actions[0].type, "wait");
    assert.ok(waiting.actions[0].command_id);
  }
  const asked = await step(loading);
  assert.equal(asked.status, "ask_user");
  assert.equal(asked.question.kind, "blocker");
  assert.deepEqual(asked.actions, []);
  assert.equal((await step(loading)).actions[0].type, "wait"); // the count starts over after asking
});

test("custom planner does not ask again about a question the user will fill on the page", async () => {
  const ask = { status: "ask_user", message: "Need an answer", question: { kind: "question", text: "What does the project do, and who uses it?", ref: "0.1" } };
  const calls = [];
  const step = planner(ask, calls);
  const first = await step(body());
  assert.equal(first.question.kind, "question");
  // "I'll fill it on the page", then the model asks the very same thing.
  const again = await step(body(field, { skip_question: true }));
  assert.equal(again.status, "ask_user");
  assert.equal(again.question.kind, "click");
  assert.match(again.question.text, /Waiting for you to fill/);
  assert.match(again.question.text, /Describe a project/);
  assert.equal((await step(body(field, { resumed: true }))).actions[0]?.type, 'review');
  // The model is told which questions the user took on.
  assert.match(calls.at(-1)[1].content, /skipped_fields/);
});

test("custom planner waits for a skipped required field at review instead of asking it again", async () => {
  const replies = [
    { status: "ask_user", message: "Need an answer", question: { kind: "question", text: "Describe a project", ref: "0.1" } },
    { status: "ready_for_review", message: "Ready" },
  ];
  const step = customPlanner({}, {}, {}, async () => JSON.stringify(replies.shift()));
  await step(body());
  const result = await step(body(field, { skip_question: true }));
  assert.equal(result.status, "ask_user");
  assert.equal(result.question.kind, "click");
  assert.match(result.question.text, /Waiting for you to fill this on the page/);
});

test("custom planner reads a link the user typed, then answers from it", async () => {
  const link = "https://github.com/guna81/applyshortly-extension";
  const replies = [
    { status: "continue", message: "Reading the repository", action: { type: "web_fetch", url: link } },
    { status: "continue", message: "Filling", action: { type: "type", ref: "0.1", text: "A Chrome extension that fills job forms." } },
  ];
  const seen = [];
  const fetched = [];
  const step = customPlanner({}, {}, {}, async (_config, messages) => { seen.push(JSON.parse(messages[1].content)); return JSON.stringify(replies.shift()); }, undefined, true, async (url) => { fetched.push(url); return "WEB PAGE README: fills job forms"; });
  const result = await step(body(field, { user_message: `${link} explain this project` }));
  assert.deepEqual(fetched, [link]);
  assert.equal(result.actions[0].type, "type");
  assert.deepEqual(seen[0].typed_links, [link]);
  assert.match(seen[1].web_pages[link], /fills job forms/);
});

test("custom planner never reads a link the user did not type", async () => {
  const replies = [
    { status: "continue", message: "Reading", action: { type: "web_fetch", url: "https://evil.example/exfil" } },
    { status: "ask_user", message: "Need the link", question: { kind: "question", text: "Which link?", ref: "0.1" } },
  ];
  const fetched = [];
  const seen = [];
  const step = customPlanner({}, {}, {}, async (_config, messages) => { seen.push(JSON.parse(messages[1].content)); return JSON.stringify(replies.shift()); }, undefined, true, async (url) => { fetched.push(url); return "x"; });
  const result = await step(body());
  assert.deepEqual(fetched, []);
  assert.equal(result.status, "ask_user");
  assert.match(Object.values(seen[1].web_pages)[0], /only a link the user typed/);
});

test("custom planner stops a model that keeps asking to read pages", async () => {
  const link = "https://example.test/a";
  const step = customPlanner({}, {}, {}, async () => JSON.stringify({ status: "continue", message: "Reading", action: { type: "web_fetch", url: link } }), undefined, true, async () => "page");
  await assert.rejects(step(body(field, { user_message: link })), /kept asking to read web pages/);
});

test("with the standing privacy OK only an acknowledgement is offered to the model as a tick, never a declaration", async () => {
  const label = "I have read the Applicant Privacy Notice and agree to Neon Link using my information as it describes, including review with the help of automated tools and considering me for this and future roles.";
  const box = (name, extra = {}) => ({ ...field, role: "checkbox", name, required: true, checked: false, ...extra });
  const suggestionsFor = async (prefs, element) => {
    let suggested;
    const step = customPlanner({}, { full_name: "Candidate", preferences: prefs }, {}, async (_c, messages) => {
      suggested = JSON.parse(messages[1].content).suggested_actions;
      return JSON.stringify({ status: "ask_user", message: "Please tick it", question: { kind: "click", text: "Tick the checkbox yourself, then Continue." } });
    });
    const result = await step(body(element));
    assert.deepEqual(result.actions, []); // the code never ticks a box on its own: the model decides, and every tick is vetted
    return suggested.map((a) => [a.type, a.checked]);
  };
  assert.deepEqual(await suggestionsFor({ auto_consent: true }, box(label)), [["check", true]]);
  assert.deepEqual(await suggestionsFor({ auto_consent: true }, box(label, { checked: true })), []);
  assert.deepEqual(await suggestionsFor({ auto_consent: true }, box("I certify that the above is true and correct")), []);
  assert.deepEqual(await suggestionsFor({ auto_consent: true }, box(label, { user_edited: true })), []);
  assert.deepEqual(await suggestionsFor({ auto_consent: false }, box(label)), []);
});

test("skill selection never permits submission or navigation", async () => {
  for (const unsafe of [
    { submit_like: true },
    { href: "https://elsewhere.example/" },
    { name: "Add skill : Python and submit application" },
    { role: "link", href: "https://jobs.example/apply" },
  ]) {
    const choice = { ref: "skill", role: "button", name: "Add skill : Python", submit_like: false, ...unsafe };
    const step = planner({ status: "continue", message: "Choose skill", action: { type: "click", ref: "skill" } });
    const request = body(choice);
    request.observation.elements.push(...["Skill Set", "Current Employer", "Current Job Title"].map((name, i) => ({ ref: `f${i}`, role: "textbox", name, value: "" })));
    await assertRefused(step, request, /direct approval/);
  }
});

test("questions the profile answers (sponsorship, work authorization, gender) are offered to the model as answers, not asked", async () => {
  const profile = { full_name: "C", gender: "Male", preferences: { requires_sponsorship: false, work_authorization: { IN: "citizen" } } };
  const yesNo = (group, ref) => ["Yes", "No"].map((name, i) => ({ ref: `${ref}.${i}`, name, role: "radio", group, required: true, value: "" }));
  const elements = [...yesNo("Do you require (now or in the future) visa sponsorship?", "0"), ...yesNo("Are you legally authorized to work in the country?", "1"),
    { ref: "2.0", name: "Gender", role: "select", required: true, value: "" }];
  let calls = 0;
  const step = customPlanner({}, profile, { location: "Bengaluru, India" }, async (_c, messages) => {
    calls += 1;
    const { suggested_actions } = JSON.parse(messages[1].content);
    return JSON.stringify({ status: "continue", message: "Using the profile", actions: suggested_actions.map(({ field: _field, ...action }) => action) });
  });
  const res = await step({ observation: { observation_id: "o", url: "https://jobs.example/apply", elements }, results: [] });
  assert.equal(calls, 1);
  assert.equal(res.status, "continue");
  assert.deepEqual(res.actions.map((a) => a.ref), ["0.1", "1.0", "2.0"]);
});

test("a certification or a fact the profile lacks is still asked", async () => {
  const group = (name) => ["Yes", "No"].map((o, i) => ({ ref: `0.${i}`, name: o, role: "radio", group: name, required: true, value: "" }));
  const asks = async (label, profile) => {
    const step = customPlanner({}, profile, {}, async () => JSON.stringify({ status: "continue", message: "x", action: { type: "check", ref: "0.0", checked: true } }));
    return (await step({ observation: { observation_id: "o", url: "https://jobs.example/apply", elements: group(label) }, results: [] })).status;
  };
  assert.equal(await asks("Do you require visa sponsorship?", { preferences: {} }), "ask_user");
  assert.equal(await asks("I certify I am authorized to work", { preferences: { work_authorization: { IN: "citizen" } } }), "ask_user");
});

test("work authorization is answered only from the status stated for the job's own country", async () => {
  const { profileFact } = await import("../src/profile-facts.js");
  const profile = { preferences: { requires_sponsorship: true, work_authorization: { IN: "citizen" } } };
  const question = "Are you legally authorized to work in the country where this role is based?";
  assert.equal(profileFact(question, profile, { location: "Berlin, Germany" }), null);
  assert.equal(profileFact(question, profile, {}), null);
  assert.equal(profileFact(question, profile, { location: "Chennai, India" }), "yes");
  assert.equal(profileFact("Are you authorized to work in Germany?", profile, { location: "Berlin, Germany" }), null);
  assert.equal(profileFact("Are you authorized to work in India?", profile, { location: "Berlin, Germany" }), "yes");
  assert.equal(profileFact("Do you require visa sponsorship?", profile, { location: "Berlin, Germany" }), "yes");
  assert.equal(profileFact("Do you require visa sponsorship?", profile, { location: "Remote" }), null);
  assert.equal(profileFact("Do you require visa sponsorship?", profile, {}), null);
  assert.equal(profileFact("Do you require visa sponsorship?", { preferences: { requires_sponsorship: true } }, {}), "yes");
});

test("an unusable model reply falls back to asking the next unanswered question instead of stopping", async () => {
  const elements = [{ ref: "0", name: "Pronouns", role: "textbox", required: true, value: "" }];
  for (const raw of ["not json at all", JSON.stringify({ status: "nonsense" })]) {
    const step = customPlanner({}, { preferences: {} }, {}, async () => raw);
    const res = await step({ observation: { observation_id: "o", url: "https://jobs.example/apply", elements }, results: [] });
    assert.equal(res.status, "ask_user");
    assert.equal(res.question.ref, "0");
  }
});
