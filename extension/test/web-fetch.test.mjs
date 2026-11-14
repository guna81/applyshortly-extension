import assert from "node:assert/strict";
import { test } from "node:test";
import { addTypedLinks, fetchPage, internalHost, isTypedLink, readableUrl, toText } from "../src/web-fetch.js";

const reply = (body, { url = "https://example.test/", status = 200, type = "text/html" } = {}) => ({ ok: status < 400, status, url, headers: { get: () => type }, text: async () => body });

test("only https links the user typed are remembered, matched without fragment or trailing slash", () => {
  const known = addTypedLinks([], "see https://github.com/guna81/applyshortly-extension. and http://plain.test/a");
  assert.deepEqual(known, ["https://github.com/guna81/applyshortly-extension"]);
  assert.ok(isTypedLink(known, "https://GitHub.com/guna81/applyshortly-extension/#readme"));
  assert.ok(!isTypedLink(known, "https://github.com/guna81/other"));
  assert.deepEqual(addTypedLinks(known, null), known);
  assert.equal(addTypedLinks([], Array.from({ length: 30 }, (_, i) => `https://a.test/${i}`).join(" ")).length, 10);
});

test("private, loopback and numeric hosts are internal; public names are not", () => {
  for (const host of ["localhost", "api", "box.local", "127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.9", "172.16.0.1", "[::1]", "2130706433", "0x7f000001"]) assert.ok(internalHost(host), host);
  for (const host of ["github.com", "example.test", "8.8.8.8", "172.32.0.1"]) assert.ok(!internalHost(host), host);
});

test("a GitHub repository link reads its README; other links are read as they are", () => {
  assert.equal(readableUrl("https://github.com/guna81/applyshortly-extension"), "https://raw.githubusercontent.com/guna81/applyshortly-extension/HEAD/README.md");
  assert.equal(readableUrl("https://github.com/orgs/acme"), "https://github.com/orgs/acme");
  assert.equal(readableUrl("https://example.test/about"), "https://example.test/about");
});

test("page text drops scripts and markup", () => {
  assert.equal(toText("<html><script>evil()</script><h1>Title</h1><p>One &amp; two</p></html>"), "Title\nOne & two");
});

test("fetchPage returns the text, sends no cookies and never throws", async () => {
  const seen = [];
  const ok = await fetchPage("https://github.com/guna81/applyshortly-extension", { fetchImpl: async (url, init) => { seen.push([url, init]); return reply("# ApplyShortly\nFills job forms.", { url, type: "text/plain" }); } });
  assert.match(ok, /^WEB PAGE https:\/\/raw\.githubusercontent\.com\//);
  assert.match(ok, /Fills job forms\./);
  assert.equal(seen[0][1].credentials, "omit");
  assert.match(await fetchPage("https://x.test/", { fetchImpl: async () => { throw new TypeError("blocked"); } }), /^Not read: the site could not be reached/);
  assert.match(await fetchPage("https://x.test/", { fetchImpl: async () => reply("gone", { status: 404 }) }), /HTTP 404/);
  assert.match(await fetchPage("https://x.test/a.pdf", { fetchImpl: async () => reply("%PDF", { type: "application/pdf" }) }), /not a text page/);
});

test("fetchPage refuses internal addresses and a redirect into one without using the answer", async () => {
  const never = async () => { throw new Error("must not fetch"); };
  for (const link of ["https://localhost/x", "https://169.254.169.254/latest", "http://example.test/", "https://api/admin", "not a url"]) assert.match(await fetchPage(link, { fetchImpl: never }), /^Not read/);
  const redirected = await fetchPage("https://example.test/p", { fetchImpl: async () => reply("secret", { url: "https://127.0.0.1/admin" }) });
  assert.match(redirected, /private address/);
  assert.doesNotMatch(redirected, /secret/);
});
