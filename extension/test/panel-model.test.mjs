// Tests for src/shared/ui/panel-model.js: the panel's checklist, counts, and error wording.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(readFileSync(new URL("../src/shared/ui/panel-model.js", import.meta.url), "utf8"), ctx);
const P = ctx.JobHuntPanel;
const plain = (x) => JSON.parse(JSON.stringify(x));

const row = (kind, status, extra = {}) => ({ field: { kind, label: kind }, status, ...extra });

test("summarize lists the steps the form needs, in order", () => {
  const s = P.summarize([
    row("text", "filled", { source: "profile" }),
    row("text", "filled", { source: "generated", needsReview: true }),
    row("text", "unresolved"),
    row("picker", "unresolved"),
  ]);
  assert.deepEqual(plain(s.steps.map((x) => [x.id, x.remaining])), [["answer", 1], ["upload", 1], ["check", 1], ["submit", 1]]);
  assert.equal(s.steps[0].label, "Answer 1 question");
  assert.equal(s.headline, "3 things left for you");
  assert.equal(s.todo, 3);
  assert.equal(s.answered, 2);
  assert.equal(s.total, 4);
});

test("steps tick off as the user answers and reviews", () => {
  const s = P.summarize([
    row("text", "done", { source: "you" }),
    row("picker", "done", { manual: true }),
    row("text", "filled", { needsReview: true, reviewed: true }),
  ]);
  assert.deepEqual(plain(s.steps.map((x) => x.remaining)), [0, 0, 0, 1]);
  assert.equal(s.steps[1].label, "CV attached");
  assert.equal(s.headline, "All set: review and submit");
  assert.equal(s.progress, 1);
});

test("a form with only checks left says so", () => {
  const s = P.summarize([row("text", "filled", { needsReview: true })]);
  assert.equal(s.headline, "Almost there: check 1 answer");
  assert.deepEqual(plain(s.steps.map((x) => x.id)), ["check", "submit"]);
});

test("submitted and empty states", () => {
  assert.equal(P.summarize([], { submitted: true }).headline, "Submitted. Nice work!");
  assert.equal(P.summarize([], { submitted: true }).steps.at(-1).remaining, 0);
  assert.equal(P.summarize([]).headline, "No fields found on this page yet");
});

test("friendlyError picks the fixing action", () => {
  assert.equal(P.friendlyError("Invalid token", 401).action, "settings");
  assert.equal(P.friendlyError("Add your platform API key in the extension's options.", 401).action, "settings");
  const net = P.friendlyError("Failed to fetch", undefined, "http://localhost:3000");
  assert.equal(net.action, "retry");
  assert.match(net.title, /localhost:3000/);
  assert.equal(P.friendlyError("Extension context invalidated.").action, "reload");
  assert.equal(P.friendlyError("boom", 500).detail, "boom");
  // A missing profile is a setup step, not a deleted application.
  const setup = P.friendlyError("Profile not created yet", 404, undefined, "profile_missing");
  assert.equal(setup.action, "profile");
  assert.equal(setup.title, "Finish setting up your profile");
  assert.match(P.friendlyError("Not found", 404).title, /no longer exists/);
});

test("sourceLabel", () => {
  assert.equal(P.sourceLabel("answer_bank"), "From answer bank");
  assert.equal(P.sourceLabel("generated"), "AI draft");
  assert.equal(P.sourceLabel("weird"), "weird");
});

test("assistantFields sends answerable questions with page values and maps keys back", () => {
  const results = [
    { field: { kind: "text", label: "Notice period", required: true }, status: "unresolved" },
    { field: { kind: "checkbox", label: "I agree" }, status: "unresolved" },
    { field: { kind: "radio", label: "Relocate?", options: [{ text: "Yes" }, { text: "No" }] }, status: "filled", value: "No" },
    { field: { kind: "picker", label: "CV" }, status: "unresolved" },
  ];
  const { fields, current, rows } = P.assistantFields(results);
  assert.deepEqual(plain(fields), [
    { key: "f0", label: "Notice period", kind: "text", options: [], required: true },
    { key: "f2", label: "Relocate?", kind: "radio", options: ["Yes", "No"], required: false },
  ]);
  assert.deepEqual(plain(current), { f0: "", f2: "No" });
  assert.equal(rows.f2, results[2]);
});

test("the chat carries on through the form only where filling in place can't finish it", () => {
  assert.equal(P.navigationNeeded({ total: 5, hasSubmit: true }), null); // a one-page form
  assert.equal(P.navigationNeeded({ total: 5, hasSubmit: true, hasNext: true }), null); // Submit on screen: last step
  assert.equal(P.navigationNeeded({ total: 5 }), null); // no Submit found, but nothing says there's more
  assert.equal(P.navigationNeeded({ total: 0 }), "none");
  assert.equal(P.navigationNeeded({ total: 4, hasNext: true }), "steps");
  assert.equal(P.navigationNeeded({ total: 0, bigFrame: true }), "frame");
  assert.equal(P.navigationNeeded({ total: 8, hasSubmit: true, bigFrame: true }), null); // its own form and a video

  assert.match(P.handoffText("steps"), /more than one step.*ask here when I need you.*debugging.*one apply run/);
  assert.match(P.handoffText("none", { autoSubmit: true }), /can't see a form.*every required answer is complete.*cancellable countdown/);

  for (const ask of ["go to the next page", "Next step", "do the rest", "fill the rest of the form", "continue the form", "click next"]) {
    assert.equal(P.isNavigateRequest(ask), true, ask);
  }
  for (const answer of ["continue", "Next month", "I can join next week", "the rest is fine"]) assert.equal(P.isNavigateRequest(answer), false, answer);
});

test("the Agent based form shows only the buttons the agent chose, with no code-written note", () => {
  const ask = plain(P.agentAsk({ kind: "question", text: "Summary?", actions: ["draft", "skip"] }, "ai_led"));
  assert.deepEqual(ask, { text: "", question: { label: "Summary?" }, choices: [P.DRAFT_REPLY, P.SKIP_REPLY], draftable: true });
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text: "Notice period?", choices: ["30 days"] }, "ai_led").choices), ["30 days"]);
});

test("the agent's questions become chat lines with quick replies", () => {
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text: "Notice period?", choices: ["30 days", "60 days"] })),
    { text: "", question: { label: "Notice period?" }, choices: ["30 days", "60 days", P.ON_PAGE_REPLY], draftable: false });
  const open = P.agentAsk({ kind: "question", text: "Why do you want to work at Actowiz?" });
  assert.equal(open.question.note, undefined);
  assert.deepEqual(plain(open.choices), [P.ON_PAGE_REPLY]);
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text: "Years of experience?" }).choices), [P.ON_PAGE_REPLY]);
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text: "Can you open the application form, or give me the direct link?" }).choices), [P.ON_PAGE_REPLY]);
  assert.deepEqual(plain(P.agentAsk({ kind: "blocker", text: "Solve the CAPTCHA on the page." })),
    { text: "Solve the CAPTCHA on the page. Tap Continue when it's done.", choices: [P.CONTINUE_REPLY] });
  // An optional field is offered with "leave it blank", never "I'll fill it on the page".
  const optional = P.agentAsk({ kind: "question", text: "Source", optional: true, choices: ["Naukri", "LinkedIn"] });
  assert.deepEqual(plain(optional.choices), ["Naukri", "LinkedIn", P.SKIP_REPLY]);
  assert.match(optional.question.note, /Optional/);
  assert.equal(P.agentAsk(null), null);
  // A conversational pause (empty click question) shows only the agent's reply, never a bare "Tap Continue" bubble.
  assert.equal(P.agentAsk({ kind: "click", text: "", optional: false }, "ai_led"), null);
  assert.equal(P.agentAsk({ kind: "click", text: "   ", optional: false }, "ai_led"), null);
});

test("a free-text visa or work-authorization situation question offers a grounded draft", () => {
  const ask = P.agentAsk({ kind: "question", role: "textarea", text: "Please briefly describe your current situation regarding work authorization (for example, your current location and visa status). What should I write?" });
  assert.deepEqual(plain(ask.choices), [P.ON_PAGE_REPLY]);
  assert.equal(P.groundedDraft("Do you require visa sponsorship?"), false);
  assert.equal(P.draftable({ kind: "text", label: "Please briefly describe your visa situation" }), false);
});

test("questions about a checkbox, upload or choice never offer a draft", () => {
  const consent = "Do you want to tick \"I agree to allow XCaliber Health to store and process my personal data\"?";
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text: consent }).choices), [P.ON_PAGE_REPLY]);
  const text = "Should we mention anything else about your background for this role?";
  for (const role of ["checkbox", "radio", "file", "combobox", "select"]) {
    const ask = P.agentAsk({ kind: "question", text, role });
    assert.deepEqual(plain(ask.choices), [P.ON_PAGE_REPLY], role);
    assert.equal(ask.question.note, undefined, role);
  }
  assert.deepEqual(plain(P.agentAsk({ kind: "question", text, role: "textarea" }).choices), [P.ON_PAGE_REPLY]);
});

test("a long option list shows the likely answer first and says it can be typed", () => {
  const codes = ["+93", "+355", "+213", "+1-684", "+376", "+244", "+1-264", "+672", "+91", "+44"];
  const results = [{ field: { kind: "dropdown", label: "Mobile phone country code", required: true, options: codes.map((text) => ({ text })) }, status: "unresolved", suggestion: "+91" }];
  const prompt = P.nextPrompt(results);
  assert.equal(prompt.choices[0], "+91");
  assert.equal(prompt.choices.length, 8);
  assert.equal(prompt.question.note, "Pick one, or type yours.");
});

test("assistantGreeting asks the first open question with its options as quick replies", () => {
  const g = P.assistantGreeting([
    { field: { kind: "select", label: "Work authorisation:", required: true, options: [{ text: "Citizen" }, { text: "Visa" }] }, status: "unresolved" },
    { field: { kind: "text", label: "Why us" }, status: "unresolved" },
  ]);
  assert.equal(g.text, "2 questions need your answer before you can submit.");
  assert.deepEqual(plain(g.question), { label: "Work authorisation?", step: "Required" });
  assert.deepEqual(plain(g.choices), ["Citizen", "Visa"]);
  assert.equal(P.assistantGreeting([]), null); // no questions on the page: no chat line
  const done = [{ field: { kind: "text", label: "City" }, status: "filled" }, { field: { kind: "text", label: "Notice" }, status: "filled" }];
  assert.equal(P.assistantGreeting(done).text, "All 2 answers are filled in. Check the form, and tell me here if one should change.");
  assert.doesNotMatch(P.assistantGreeting(done).text, /notice period to 60/);
  const consent = [{ field: { kind: "checkbox", label: "I agree to the terms" }, status: "unresolved" }];
  assert.deepEqual(plain(P.assistantGreeting(consent).choices), [P.AGREE_REPLY, P.SHOW_REPLY]);
  assert.equal(P.promptTarget(consent), consent[0]);
  assert.equal(P.nextPrompt([{ field: { kind: "text" }, status: "filled" }]), null);
});

test("directAnswer takes an option or free text for the asked question, never a local reply", () => {
  const radio = { field: { kind: "radio", options: [{ text: "Yes" }, { text: "No" }] }, status: "unresolved" };
  const text = { field: { kind: "text" }, status: "optional" };
  assert.equal(P.directAnswer(radio, "yes"), "Yes");
  assert.equal(P.directAnswer(radio, "I can relocate"), null); // not an option: the assistant decides
  assert.equal(P.directAnswer(text, "Pune"), "Pune");
  assert.equal(P.directAnswer(text, "Change name to Ada and salary to 2200000"), null);
  assert.equal(P.directAnswer(text, "Use my full name, not just my surname"), null);
  assert.equal(P.directAnswer(text, P.SKIP_REPLY), null);
  assert.equal(P.directAnswer({ ...text, status: "filled" }, "Pune"), null);
  assert.equal(P.directAnswer({ field: { kind: "checkbox" }, status: "unresolved" }, "Yes"), null); // consent stays a tap
  assert.equal(P.directAnswer(null, "Pune"), null);
  const tel = { field: { kind: "text", el: { type: "tel" } }, status: "unresolved" };
  assert.equal(P.directAnswer(tel, "+91 98765 43210"), "+91 98765 43210");
  assert.equal(P.directAnswer(tel, "can you see the country and state field?"), null);
  const open = [radio];
  assert.equal(P.nextPrompt(open).target, radio);
});

test("chatHistory drops the greeting and errors", () => {
  const lines = [{ role: "assistant", text: "Hi", greeting: true }, { role: "user", text: " yes " }, { role: "assistant", text: "oops", error: true }];
  assert.deepEqual(plain(P.chatHistory(lines)), [{ role: "user", text: "yes" }]);
  // A question shown as a card still reaches the AI, so it knows what was asked.
  const asked = [{ role: "assistant", text: "", question: { label: "Notice period?" } }, { role: "user", text: "60 days" }];
  assert.deepEqual(plain(P.chatHistory(asked)), [{ role: "assistant", text: "Notice period?" }, { role: "user", text: "60 days" }]);
});

test("autoApplyBlockers: submits only a complete, not-yet-sent application", () => {
  const complete = [row("text", "filled", { source: "profile" }), row("text", "optional"), row("checkbox", "done", { manual: true })];
  assert.deepEqual(plain(P.autoApplyBlockers(complete, { status: "ready_for_review" })), []);
  assert.deepEqual(plain(P.autoApplyBlockers(complete, null)), [], "untracked pages can auto apply");
  assert.deepEqual(plain(P.autoApplyBlockers([...complete, row("checkbox", "unresolved"), row("text", "unresolved")], null)), [
    "2 required fields still need you",
  ]);
  assert.deepEqual(plain(P.autoApplyBlockers([], null)), ["No form fields found on this page"]);
  assert.deepEqual(plain(P.autoApplyBlockers(complete, { status: "submission_unconfirmed" })), [
    "A previous attempt needs verification in ApplyShortly first",
  ]);
  assert.deepEqual(plain(P.autoApplyBlockers(complete, { status: "submitted" })), ["This application is already submitted"]);
});

test("an unresolved custom dropdown with options read from the page offers them as choices", () => {
  // content.js readChoices fills field.options as [{ text }] for custom dropdowns.
  const dropdown = { kind: "dropdown", custom: true, label: "Gender", required: true, options: [{ text: "Male" }, { text: "Female" }] };
  const results = [{ field: dropdown, status: "unresolved" }];
  assert.deepEqual(plain(P.assistantGreeting(results).choices), ["Male", "Female"]);
  const { fields, current } = P.assistantFields(results);
  assert.deepEqual(plain(fields), [{ key: "f0", label: "Gender", kind: "dropdown", options: ["Male", "Female"], required: true }]);
  assert.deepEqual(plain(current), { f0: "" });

  const optional = [{ field: { ...dropdown, required: false }, status: "optional", optional: true }];
  assert.deepEqual(plain(P.nextPrompt(optional).choices), ["Male", "Female", P.SKIP_REPLY]);
  // Without readable options there's nothing to offer.
  assert.deepEqual(plain(P.assistantGreeting([{ field: { ...dropdown, options: [] }, status: "unresolved" }]).choices), []);
});

test("optional personal facts are not offered as an AI draft", () => {
  const optional = (label, el = {}) => [{ field: { kind: "text", label, el }, status: "optional", optional: true }];
  for (const [label, el] of [["Middle Name", {}], ["Date of birth", {}], ["PAN number", {}], ["Phone", { type: "tel" }], ["Contact", { type: "email" }], ["Portfolio", { type: "url" }]]) {
    const prompt = P.nextPrompt(optional(label, el));
    assert.deepEqual(plain(prompt.choices), [P.SKIP_REPLY], label);
    assert.match(prompt.text, /is optional: tell me what to put, or leave it blank\.$/, label);
    assert.equal(P.draftable(optional(label, el)[0].field), false, label);
  }
});

test("rule optional questions never offer a draft", () => {
  for (const label of ["Why do you want to join us?", "Tell us about a project you're proud of", "Why are you a good candidate?", "Personal statement", "Describe your capacity to lead"]) {
    const field = { kind: "text", label, el: { type: "textarea" } };
    assert.equal(P.draftable(field), true, label);
    assert.deepEqual(plain(P.nextPrompt([{ field, status: "optional", optional: true }]).choices), [P.SKIP_REPLY], label);
  }
  assert.equal(P.draftable({ kind: "select", label: "Why do you want to join us?" }), false);
  assert.equal(P.draftable(null), false);
});

test("a rule required question asks the user without offering a draft", () => {
  const field = { kind: "text", label: "Why do you think you are suitable for this position? Brief in less than 100 words", required: true, el: { tagName: "TEXTAREA" } };
  const prompt = P.nextPrompt([{ field, status: "unresolved" }]);
  assert.deepEqual(plain(prompt.choices), []);
  assert.equal(prompt.question.note, undefined);
  // Personal facts and choice questions get no draft button.
  assert.deepEqual(plain(P.nextPrompt([{ field: { kind: "text", label: "Years of work experience (in years)", required: true }, status: "unresolved" }]).choices), []);
  assert.equal(P.nextPrompt([{ field: { kind: "text", label: "Notice period", required: true }, status: "unresolved" }]).question.note, undefined);
  for (const label of ["How many years have you worked with Python?", "How soon can you join, if selected? Answer in number of weeks."]) {
    assert.equal(P.draftable({ kind: "text", label }), false, label);
  }
});

test("a typed draft request is never written into the form as the answer", () => {
  for (const m of ["draft it for me", "Draft it for me", "please draft one", "write it for me", "Draft", "can you draft an answer?"]) {
    assert.equal(P.isDraftRequest(m), true, m);
    assert.equal(P.directAnswer({ field: { kind: "text" }, status: "unresolved" }, m), null, m);
  }
  for (const m of ["I draft legal documents for a living", "Drafting tools and CAD", "write code daily"]) assert.equal(P.isDraftRequest(m), false, m);
});

test('a sign-in page is recognised by its password box or its path', () => {
  assert.equal(P.loginWall('/careers/apply', true), true);
  assert.equal(P.loginWall('/en-US/login', false), true);
  assert.equal(P.loginWall('/auth/callback', false), true);
  assert.equal(P.loginWall('/careers/apply', false), false);
  assert.equal(P.loginWall('/blogin-tips', false), false);
});


test("autoApplyBlockers: the agent's frame-aware readiness and a pending CAPTCHA stop Auto apply", () => {
  const complete = [row("text", "filled")];
  assert.deepEqual(plain(P.autoApplyBlockers(complete, null, { total: 1, framed: 0, missing: [] }, false)), []);
  assert.deepEqual(plain(P.autoApplyBlockers([], null, { total: 2, framed: 2, missing: [] }, false)), [
    "This form is embedded in the page, so I can't check all of it from here. Review it and submit it yourself",
  ], "a form that is entirely in a frame is not 'no fields', but it is not sent from here");
  assert.deepEqual(plain(P.autoApplyBlockers(complete, null, { total: 2, framed: 1, missing: [{ name: "Email", framed: true }] }, false)), [
    "1 required field in the embedded form still needs you",
    "This form is embedded in the page, so I can't check all of it from here. Review it and submit it yourself",
  ]);
  const readiness = { total: 1, framed: 0, missing: [{ name: "Email", framed: false }] };
  const email = { label: "Email", kind: "text", required: true };
  assert.deepEqual(plain(P.autoApplyBlockers([], null, readiness)), ["1 required field still needs you"]);
  assert.deepEqual(plain(P.autoApplyBlockers([{ field: email, status: "unresolved" }], null, readiness)), ["1 required field still needs you"]);
  assert.deepEqual(plain(P.autoApplyBlockers([{ field: email, status: "done" }], null, readiness)), []);
  assert.deepEqual(plain(P.autoApplyBlockers(complete, null, null, true)), [
    "The site still needs you to complete its CAPTCHA. Do that, then submit it yourself",
  ]);
  assert.deepEqual(plain(P.autoApplyBlockers([], null, null, false)), ["No form fields found on this page"], "no readiness: unchanged");
});

test("readinessNote: names the first required fields left empty", () => {
  assert.equal(P.readinessNote(null), "");
  assert.equal(P.readinessNote({ missing: [] }), "");
  assert.equal(P.readinessNote({ missing: [{ name: "Email" }] }), "Still empty and required: “Email”.");
  assert.equal(P.readinessNote({ missing: ["A", "B", "C", "D", "E"].map((name) => ({ name })) }), "Still empty and required: “A”, “B”, “C” and 2 more.");
});

test("a typed instruction is not taken as the answer to the agent's question", () => {
  for (const m of ["fetch data from here - https://guna81.netlify.app/", "Read https://github.com/guna81/applyshortly-extension", "look at my site", "what does this mean", "Please open the link"]) assert.equal(P.isPlainAnswer(m), false, m);
  for (const m of ["https://guna81.netlify.app/", "ApplyShortly is a job-application tool", "5 years", "Yes"]) assert.equal(P.isPlainAnswer(m), true, m);
});

test("looksLikeApplicationForm detects job forms while ignoring login, payment, and generic forms", () => {
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "file", label: "Resume / CV" }],
    pathname: "/careers/engineer",
  }), true, "resume upload alone is a strong job-form signal");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Full name" }, { kind: "text", label: "LinkedIn Profile" }],
    pathname: "/jobs/123",
  }), true, "job-specific field with another input");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "First name" }, { kind: "text", label: "Email" }],
    pathname: "/careers/apply",
    title: "Apply for Software Engineer",
  }), true, "contact fields on an apply page");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Email" }, { kind: "text", label: "Full name" }],
    pathname: "/login",
    passwordShown: false,
  }), false, "login URL is excluded");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "file", label: "Resume" }, { kind: "text", label: "Email" }],
    pathname: "/apply",
    passwordShown: true,
  }), false, "visible password box is excluded");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Full name" }, { kind: "text", label: "Email" }, { kind: "text", label: "Card number" }],
    pathname: "/checkout",
    title: "Apply promo code",
  }), false, "payment/checkout forms are excluded");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "First name" }, { kind: "text", label: "Email" }],
    pathname: "/contact",
    title: "Contact us",
    hasSubmit: true,
    submitText: "Send message",
  }), false, "generic contact form is excluded");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Search" }],
    pathname: "/jobs",
    title: "Search jobs",
  }), false, "single search field is excluded");
});

test("looksLikeApplicationForm ignores job listings, sign-ups and chat boxes", () => {
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Keywords" }, { kind: "text", label: "City, state or zip" }],
    pathname: "/jobs/forward-deployed-ai-engineer",
    title: "Forward Deployed AI Engineer - Jobs",
    hasSubmit: true,
    submitText: "Apply now",
  }), false, "a listing's search boxes next to an Apply now button");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Job title" }, { kind: "text", label: "Location" }],
    pathname: "/jobs/123",
    hasSubmit: true,
    submitText: "Apply now",
  }), false, "two boxes that hold none of the applicant's details");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Full name" }, { kind: "text", label: "Email" }],
    pathname: "/jobs",
    title: "Jobs in the UK",
    hasSubmit: true,
    submitText: "Submit and get job alerts",
  }), false, "a job-alert sign-up");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Type your answer…" }, { kind: "text", label: "Search" }],
    pathname: "/applications/runs/53",
    hasSubmit: true,
    submitText: "Submit application",
  }), false, "a chat box and a search box");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Email", search: true }, { kind: "text", label: "Name", search: true }],
    pathname: "/careers/apply",
    submitText: "Apply now",
  }), false, "boxes inside a search region");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "First name" }, { kind: "text", label: "Last name" }, { kind: "text", label: "Email" }, { kind: "text", label: "Search" }],
    pathname: "/o/engineer",
    hasSubmit: true,
    submitText: "Submit application",
  }), true, "a real application form still counts when a search box is also on the page");
});

test("looksLikeApplicationForm needs a job signal, keeps real questions and reads German forms", () => {
  const contact = [{ kind: "text", label: "First name" }, { kind: "text", label: "Last name" }, { kind: "text", label: "Email" }, { kind: "textarea", label: "Message" }];
  assert.equal(P.looksLikeApplicationForm({ fields: contact, pathname: "/contact", title: "Contact us", hasSubmit: true, submitText: "Submit" }), false, "a contact-us form");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "First name" }, { kind: "text", label: "Work email" }, { kind: "text", label: "Phone" }, { kind: "text", label: "Company" }],
    pathname: "/demo", title: "Book a demo", hasSubmit: true, submitText: "Submit",
  }), false, "a demo request form");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "First name" }, { kind: "text", label: "Last name" }, { kind: "text", label: "Email" }],
    pathname: "/careers/engineer/apply", hasSubmit: false,
  }), true, "step one of an application with only contact boxes and a Next button");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "How did you hear about us? (e.g. Google search)" }, { kind: "text", label: "Email" }],
    pathname: "/o/engineer", title: "Engineer", hasSubmit: true, submitText: "Submit application",
  }), true, "a question that mentions search is not a search box");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Keywords describing your skills" }, { kind: "textarea", label: "Write a message to the hiring team" }, { kind: "text", label: "Full name" }],
    pathname: "/careers/apply", hasSubmit: true, submitText: "Submit",
  }), true, "questions that start like noise but say more still count");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "textarea", label: "Why do you want to join?" }, { kind: "textarea", label: "Describe a project you are proud of" }],
    pathname: "/careers/x/apply", hasSubmit: true, submitText: "Submit application",
  }), true, "a last step with only custom questions");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "textarea", label: "Why do you want to join?" }, { kind: "textarea", label: "Describe a project you are proud of" }],
    pathname: "/feedback", hasSubmit: true, submitText: "Submit",
  }), false, "custom questions without any apply wording");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Full name" }, { kind: "text", label: "Email" }],
    pathname: "/jobs/123", hasSubmit: true, submitText: "Sign up & apply",
  }), true, "Sign up & apply still applies");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "select", label: "Years of experience" }, { kind: "select", label: "Location" }, { kind: "select", label: "Job type" }],
    pathname: "/jobs", hasSubmit: true, submitText: "Apply filters",
  }), false, "a job board's filter form");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "text", label: "Vorname" }, { kind: "text", label: "Nachname" }, { kind: "text", label: "E-Mail" }, { kind: "text", label: "Telefon" }],
    pathname: "/stellenangebote/entwickler", title: "Jetzt bewerben – Entwickler", hasSubmit: false,
  }), true, "a German application form without an upload");
  assert.equal(P.looksLikeApplicationForm({
    fields: [{ kind: "file", label: "Lebenslauf" }],
    pathname: "/job/1",
  }), true, "a German resume upload");
});
