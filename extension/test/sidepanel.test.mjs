import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

async function setup({ reply } = {}) {
  const dom = new JSDOM(readFileSync(new URL("../src/sidepanel.html", import.meta.url), "utf8"), { runScripts: "outside-only" });
  const { window } = dom;
  const calls = [];
  const store = { session: {}, local: {} };
  const area = (data) => ({
    get: async (key) => ({ [key]: data[key] }),
    set: async (value) => Object.assign(data, value),
  });
  window.chrome = {
    runtime: {
      openOptionsPage() {},
      sendMessage: async (message) => {
        calls.push(message);
        switch (message.type) {
          case "status": return { ok: true, data: { configured: true, connected: true, name: "Asha", credits: 12, billingEnabled: true } };
          case "chat": return { ok: true, data: reply ?? { reply: "You have 2 new matches.", choices: ["Show the best one", "Not now"], actions: [{ type: "queue_job", label: "Queue Backend Engineer at Acme", job_id: 7 }] } };
          case "chatAction": return { ok: true, data: { ok: true, message: "Queued." } };
          case "tabData": return { ok: true, data: message.tab === "today" ? [{ job_id: 7, title: "Backend Engineer", company_name: "Acme", location: "Pune", work_mode: "remote", match_score: 91, fit_summary: "Strong fit", apply_url: null }] : [] };
          default: return { ok: true, data: null };
        }
      },
    },
    storage: { session: area(store.session), local: area(store.local) },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  window.eval(readFileSync(new URL("../src/chat-model.js", import.meta.url), "utf8"));
  // The page script is a module with top-level await.
  window.eval(`(async () => {${readFileSync(new URL("../src/sidepanel.js", import.meta.url), "utf8")}})()`);
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
  await flush();
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const buttons = (selector = "#view button") => [...window.document.querySelectorAll(selector)];
  const click = async (label) => {
    const target = buttons("#tabs button, #view button").find((b) => b.textContent === label);
    assert.ok(target, `no button "${label}"`);
    target.click();
    await flush();
  };
  return { window, document: window.document, calls, store, flush, click, buttons, plain };
}

test("starter chips start a conversation and the reply brings choices and actions", async () => {
  const h = await setup();
  assert.match(h.document.querySelector("#connText").textContent, /Asha/);
  assert.deepEqual(h.plain(h.buttons().map((b) => b.textContent)), ["What's new today?", "What's in my apply queue?", "Where do my applications stand?"]);

  await h.click("What's new today?");
  const sent = h.calls.find((c) => c.type === "chat");
  assert.deepEqual(h.plain(sent.messages), [{ role: "user", text: "What's new today?" }]);
  assert.equal(sent.page, null); // page sharing is off by default
  assert.match(h.document.querySelector("#view").textContent, /You have 2 new matches/);
  const labels = h.buttons().map((b) => b.textContent);
  assert.ok(labels.includes("Show the best one"));
  assert.ok(labels.includes("Queue Backend Engineer at Acme"));

  // An action runs only when clicked, then disappears.
  assert.equal(h.calls.some((c) => c.type === "chatAction"), false);
  await h.click("Queue Backend Engineer at Acme");
  assert.deepEqual(h.plain(h.calls.find((c) => c.type === "chatAction").action), { type: "queue_job", label: "Queue Backend Engineer at Acme", job_id: 7 });
  assert.equal(h.buttons().some((b) => b.textContent.startsWith("Queue Backend")), false);
  assert.match(h.document.querySelector("#view").textContent, /Queued\./);
  assert.equal(h.store.session.assistantChat.length, 3);
});

test("typing a message sends the whole conversation", async () => {
  const h = await setup({ reply: { reply: "Hello!", choices: [], actions: [] } });
  h.document.querySelector("#input").value = "hello there";
  h.document.querySelector("#composer").requestSubmit();
  await h.flush();
  h.document.querySelector("#input").value = "and again";
  h.document.querySelector("#composer").requestSubmit();
  await h.flush();
  const chats = h.calls.filter((c) => c.type === "chat");
  assert.equal(chats.length, 2);
  assert.deepEqual(h.plain(chats[1].messages.map((m) => m.text)), ["hello there", "Hello!", "and again"]);
});

test("the Today tab lists matches with queue and dismiss buttons", async () => {
  const h = await setup();
  await h.click("Today");
  const view = h.document.querySelector("#view").textContent;
  assert.match(view, /Backend Engineer/);
  assert.match(view, /91% match/);
  await h.click("Queue");
  assert.equal(h.calls.find((c) => c.type === "chatAction").action.type, "queue_job");
  assert.match(h.document.querySelector("#view").textContent, /Queued\./);
});
