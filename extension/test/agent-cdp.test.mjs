import assert from "node:assert/strict";
import { test } from "node:test";
import { TabDriver } from "../src/agent/cdp.js";

test("application tabs must be opened by a recent interaction in the controlled tab", async () => {
  const api = { tabs: { get: async (id) => ({ id, url: "https://ats.example.test/apply", title: "Apply" }) } };
  const driver = new TabDriver(1, "", api);
  driver.handleCreated({ id: 2, openerTabId: 1 });
  assert.deepEqual(await driver.applicationTabs(), []);
  driver.lastInteractionAt = Date.now();
  driver.handleCreated({ id: 3, openerTabId: 99 });
  driver.handleCreated({ id: 4, openerTabId: 1 });
  assert.deepEqual((await driver.applicationTabs()).map((t) => t.id), [4]);
  await assert.rejects(driver.switchTab(3), /not opened/);
  driver.detach = async () => {};
  driver.attach = async () => {};
  let followed;
  driver.onTabChanged = async (id) => { followed = id; };
  await driver.switchTab(4);
  assert.equal(driver.tabId, 4);
  assert.equal(followed, 4);
});

test("tab navigation after observation invalidates a switch command", async () => {
  let url = "https://ats.example.test/apply";
  const driver = new TabDriver(1, "", { tabs: { get: async () => ({ url }) } });
  driver.lastInteractionAt = Date.now();
  driver.handleCreated({ id: 2, openerTabId: 1 });
  await driver.applicationTabs();
  url = "https://unrelated.example.test/";
  await assert.rejects(driver.switchTab(2), /changed/);
  assert.equal(driver.tabId, 1);
});

test("accessibility discovery resolves controls in the isolated world and releases handles", async () => {
  const driver = new TabDriver(1, "", {});
  driver.world = async () => 17;
  const calls = [];
  driver.send = async (method, params) => {
    calls.push({ method, params });
    if (method === "Accessibility.getFullAXTree") return { nodes: [{ role: { value: "combobox" }, name: { value: "City / Town" }, backendDOMNodeId: 5 }] };
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { ref: "city", role: "combobox", name: "City / Town" } } };
    return {};
  };
  const result = await driver.accessible({ frameId: "main" }, []);
  assert.equal(result.elements[0].name, "City / Town");
  assert.equal(result.incomplete, false);
  assert.equal(calls.find((c) => c.method === "DOM.resolveNode").params.executionContextId, 17);
  assert.ok(calls.some((c) => c.method === "Runtime.releaseObject"));
  calls.length = 0;
  await driver.accessible({ frameId: "main" }, ["city"]);
  assert.equal(calls.some((c) => c.method === "DOM.resolveNode"), false);
});
