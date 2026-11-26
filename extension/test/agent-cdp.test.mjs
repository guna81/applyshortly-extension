import assert from "node:assert/strict";
import { test } from "node:test";
import { DialogOpenError, TabDriver, jpegSize, redactUrl } from "../src/page-control/cdp.js";

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

test("applicationTabs falls back to pendingUrl and debugger.getTargets when tabs.get omits url", async () => {
  const api = {
    tabs: {
      get: async (id) => (id === 4 ? { id, pendingUrl: "https://ats.example.test/pending" } : { id }),
    },
    debugger: {
      getTargets: async () => [{ tabId: 5, type: "page", url: "https://ats.example.test/apply", title: "Apply" }],
    },
  };
  const driver = new TabDriver(1, "", api);
  driver.lastInteractionAt = Date.now();
  driver.handleCreated({ id: 4, openerTabId: 1 });
  driver.handleCreated({ id: 5 }); // rel="noopener" right after click
  const tabs = await driver.applicationTabs();
  assert.deepEqual(tabs, [
    { id: 4, url: "https://ats.example.test/pending", title: "" },
    { id: 5, url: "https://ats.example.test/apply", title: "Apply" },
  ]);
  driver.detach = async () => {};
  driver.attach = async () => {};
  let followedUrl;
  driver.onTabChanged = async (_id, nextUrl) => { followedUrl = nextUrl; };
  await driver.switchTab(5);
  assert.equal(driver.tabId, 5);
  assert.equal(followedUrl, "https://ats.example.test/apply");
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

test("a JavaScript dialog fails in-flight and new commands instead of hanging, and is never answered", async () => {
  const sent = [];
  let release;
  const api = { debugger: { sendCommand: (_target, method) => {
    sent.push(method);
    return method === "Input.dispatchMouseEvent" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({});
  } } };
  const driver = new TabDriver(1, "", api);
  const click = driver.click(5, 5); // the page's click handler calls alert() and blocks
  driver.handleEvent({ tabId: 1 }, "Page.javascriptDialogOpening", { type: "alert", message: "Session expired" });
  await assert.rejects(click, (error) => error instanceof DialogOpenError && /Session expired/.test(error.message));
  await assert.rejects(driver.send("Runtime.evaluate", {}), DialogOpenError);
  assert.equal(sent.includes("Page.handleJavaScriptDialog"), false);
  let closed = false;
  const waiting = driver.dialogClosed().then(() => { closed = true; });
  assert.equal(closed, false);
  driver.handleEvent({ tabId: 1 }, "Page.javascriptDialogClosed", { result: true });
  await waiting;
  assert.equal(closed, true);
  assert.equal(driver.dialog, null);
  release?.({});
  assert.deepEqual(await driver.send("Runtime.evaluate", {}), {});
});

test("screenshots never use clip (it re-lays out the page) and report image pixels per CSS pixel", async () => {
  // A minimal JPEG header: SOI, then SOF0 with height 640 and width 1024.
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x04, 0x00, 0x03]);
  const data = header.toString("base64");
  assert.deepEqual(jpegSize(data), { width: 1024, height: 640 });
  const calls = [];
  const driver = new TabDriver(1, "", {});
  driver.send = async (method, params) => {
    calls.push({ method, params });
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 2048, clientHeight: 1280, pageX: 0, pageY: 300 } };
    return { data };
  };
  assert.equal(driver.canDrawLabels, false); // no canvas in this runtime: the capture is sent as is
  assert.equal(await driver.screenshot(), data);
  const params = calls.find((c) => c.method === "Page.captureScreenshot").params;
  assert.equal(params.clip, undefined);
  assert.equal(driver.shotScale, 0.5);
  assert.equal(driver.labelsDrawn, false);
});

test("with a canvas, the capture is shrunk to 1280px and ref labels are drawn into the image", async () => {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x04, 0x00, 0x03]); // 1024x640
  const small = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x40, 0x02, 0x00, 0x03]).toString("base64"); // 512x320
  const drawn = [];
  const saved = { OffscreenCanvas: globalThis.OffscreenCanvas, createImageBitmap: globalThis.createImageBitmap };
  globalThis.createImageBitmap = async () => ({ width: 2560, height: 1600, close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { drawn.push(["canvas", width, height]); }
    getContext() {
      return {
        drawImage: (_b, x, y, w, h) => drawn.push(["image", x, y, w, h]),
        measureText: (t) => ({ width: t.length * 7 }),
        fillRect: (x, y) => drawn.push(["label", Math.round(x), Math.round(y)]),
        fillText: (t) => drawn.push(["text", t]),
      };
    }
    async convertToBlob() { return new Blob([Buffer.from(small, "base64")]); }
  };
  try {
    const driver = new TabDriver(1, "", {});
    const sent = [];
    driver.send = async (method, params) => {
      sent.push({ method, params });
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
      return { data: header.toString("base64") };
    };
    const image = await driver.screenshot([{ ref: "0.3", bounds: [100, 200, 50, 20] }, { ref: "0.9", bounds: [0, 0, 0, 0] }]);
    assert.equal(image, small);
    assert.equal(sent.find((c) => c.method === "Page.captureScreenshot").params.clip, undefined);
    assert.deepEqual(drawn.slice(0, 2), [["canvas", 1280, 800], ["image", 0, 0, 1280, 800]]);
    assert.deepEqual(drawn.filter((d) => d[0] !== "canvas" && d[0] !== "image"), [["label", 100, 185], ["text", "0.3"]]);
    assert.equal(driver.labelsDrawn, true);
    assert.equal(driver.shotScale, 0.4); // 512 image pixels over 1280 CSS pixels
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("hover moves the pointer only; drag presses, moves in steps and releases", async () => {
  const events = [];
  const driver = new TabDriver(1, "", {});
  driver.send = async (method, params) => { events.push(params.type); return {}; };
  await driver.hover(10, 10);
  assert.deepEqual(events, ["mouseMoved"]);
  events.length = 0;
  await driver.drag({ x: 0, y: 0 }, { x: 80, y: 0 });
  assert.equal(events[1], "mousePressed");
  assert.equal(events.at(-1), "mouseReleased");
  assert.equal(events.filter((e) => e === "mouseMoved").length, 9);
});

test("console and network diagnostics keep status and path only, never queries, bodies or long tokens", () => {
  const driver = new TabDriver(1, "", {});
  driver.handleEvent({ tabId: 1 }, "Log.entryAdded", { entry: { level: "error", source: "javascript", text: `Bad token ${"a".repeat(60)} in form`, url: "https://jobs.example/app.js?session=secret#x" } });
  driver.handleEvent({ tabId: 1 }, "Log.entryAdded", { entry: { level: "info", text: "ignored" } });
  driver.handleEvent({ tabId: 1 }, "Network.requestWillBeSent", { requestId: "r1", request: { method: "POST", url: "https://jobs.example/api/apply?email=a@b.c" } });
  driver.handleEvent({ tabId: 1 }, "Network.responseReceived", { requestId: "r1", response: { status: 422, url: "https://jobs.example/api/apply?email=a@b.c" } });
  driver.handleEvent({ tabId: 1 }, "Network.responseReceived", { requestId: "r2", response: { status: 200, url: "https://jobs.example/ok" } });
  driver.handleEvent({ tabId: 1 }, "Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_FAILED", canceled: false });
  const { console: logs, network } = driver.diagnostics();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].url, "https://jobs.example/app.js");
  assert.doesNotMatch(logs[0].text, /a{32}/);
  assert.deepEqual(network.map((n) => [n.status, n.method, n.url]), [[422, "POST", "https://jobs.example/api/apply"], [0, "POST", "https://jobs.example/api/apply"]]);
  assert.equal(JSON.stringify(driver.diagnostics()).includes("secret"), false);
  assert.equal(JSON.stringify(driver.diagnostics()).includes("a@b.c"), false);
  assert.equal(redactUrl("not a url?x=1"), "not a url");
});

test("the diagnostics buffer keeps only the latest fifty entries", () => {
  const driver = new TabDriver(1, "", {});
  for (let i = 0; i < 80; i += 1) driver.handleEvent({ tabId: 1 }, "Log.entryAdded", { entry: { level: "warning", text: `w${i}` } });
  const { console: logs } = driver.diagnostics();
  assert.equal(logs.length, 50);
  assert.equal(logs[0].text, "w30");
});

test("run_js evaluates in the page through the debugger, with form submission blocked first", async () => {
  const calls = [];
  const api = { debugger: { sendCommand: async (_target, method, params) => {
    calls.push({ method, params });
    if (method === "Runtime.evaluate" && params.expression === "1 + 2") return { result: { type: "number", value: 3 } };
    if (method === "Runtime.evaluate" && params.expression === "boom()") return { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } };
    if (method === "Runtime.evaluate" && params.expression === "({a: 1})") return { result: { type: "object", value: { a: 1 } } };
    return {};
  } } };
  const driver = new TabDriver(1, "", api);
  assert.deepEqual(await driver.evaluate("1 + 2"), { value: "3" });
  const guard = calls.find((c) => c.method === "Runtime.evaluate" && /submit/.test(c.params.expression));
  assert.ok(guard, "the submit guard is installed before the script runs");
  assert.ok(calls.indexOf(guard) < calls.findIndex((c) => c.params?.expression === "1 + 2"));
  assert.equal(calls.find((c) => c.params?.expression === "1 + 2").params.awaitPromise, true);
  assert.deepEqual(await driver.evaluate("({a: 1})"), { value: '{"a":1}' });
  assert.match((await driver.evaluate("boom()")).error, /boom is not defined/);
});

test("run_js results are capped so a huge return value cannot flood the model's history", async () => {
  const api = { debugger: { sendCommand: async (_t, method, params) => (params?.expression === "big" ? { result: { type: "string", value: "y".repeat(20000) } } : {}) } };
  const out = await new TabDriver(1, "", api).evaluate("big");
  assert.ok(out.value.length <= 4100);
});
