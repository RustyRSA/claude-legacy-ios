"use strict";
// patch.js + the transpiler in a jsdom page: the entry script is intercepted,
// modules run as inline scripts with the page's nonce (fast mode), and when the
// page will not run inline scripts (as under a refusing policy) they go through
// the app's patchScript handler instead. Both give the same result.
const { JSDOM } = require(process.argv[3] + "/node_modules/jsdom");
const fs = require("fs");
const assert = require("assert");
const repo = process.argv[2];
const read = (f) => fs.readFileSync(repo + "/ClaudeLegacy/" + f, "utf8");
const BASE = "https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1";
const SOURCES = {
  "frame-shell-T1.js": 'import{a}from"./a.js";log("shell:"+a);export const s=1;',
  "a.js": 'log("a");export const a="A";',
};

function page(runScripts, settings, parsing) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { runScripts, url: "https://claude.ai/artifact/x" });
  const w = dom.window;
  // The HTML still being parsed, as when modules come from the app's store.
  if (parsing) Object.defineProperty(w.document, "readyState", { configurable: true, get: () => parsing.state });
  const order = [], statuses = [], viaApp = [];
  w.log = (x) => order.push(x);
  w.iosVersion = "16.3";
  w.__appSettings = settings;
  w.fetch = async (url) => ({ ok: true, status: 200, text: async () => SOURCES[url.split("/").pop()] });
  const store = new Map();
  w.caches = { open: async () => ({ match: async (u) => (store.has(u) ? { text: async () => store.get(u) } : undefined), put: async (u, r) => store.set(u, await r.text()), keys: async () => [], delete: async () => true }), keys: async () => [], delete: async () => true };
  w.Response = class { constructor(t) { this.t = t; } async text() { return this.t; } };
  w.webkit = { messageHandlers: {
    loadingStatus: { postMessage: (m) => statuses.push(m) },
    patchScript: { postMessage: (m) => { viaApp.push(m.file); w.eval(m.code); } },
  } };
  w.__appLaunchMarks = { sendButton: 1 }; // as app-tweaks.js sets it once the send button shows
  w.eval(read("legacy-transpiler.js") + "\n;window.LegacyTranspiler = LegacyTranspiler;");
  w.eval(read("patch.js"));
  // The page's own nonce'd script, a classic third-party script whose address
  // has "index" in it (left alone), then its entry script.
  const own = w.document.createElement("script");
  own.setAttribute("nonce", "n0nce");
  w.document.head.appendChild(own);
  const other = w.document.createElement("script");
  other.src = "https://widgets.example/v2/index.js";
  w.document.head.appendChild(other);
  w.__otherScript = other;
  const entry = w.document.createElement("script");
  entry.type = "module";
  entry.src = BASE + "/frame-shell-T1.js";
  w.document.head.appendChild(entry);
  return new Promise((resolve) => setTimeout(() => resolve({ w, order, statuses, viaApp, entry }), 300));
}

(async () => {
  const inPage = await page("dangerously", { fastLoad: true });
  assert.strictEqual(inPage.entry.type, "javascript/blocked", "entry script blocked");
  assert.notStrictEqual(inPage.w.__otherScript.type, "javascript/blocked", "a classic script is not taken for the entry");
  assert.strictEqual(inPage.order.join(","), "a,shell:A");
  assert.strictEqual(inPage.viaApp.length, 0, "nothing went through the app");
  assert.ok(inPage.statuses.some((s) => s.stage === "module"), "modules reported");
  assert.strictEqual(inPage.w.__appLoader.inPage(), true);
  // Modules are reported to the app with a count: the first at once, then summed.
  await new Promise((r) => setTimeout(r, 400));
  const reports = inPage.statuses.filter((s) => s.stage === "module");
  assert.strictEqual(reports[0].file, "frame-shell-T1.js", "first module reported at once by name");
  assert.strictEqual(reports.reduce((n, s) => n + s.count, 0), 2, "every module counted: " + JSON.stringify(reports));
  // The read-ahead list for the next launch is saved once the send button has
  // shown (+1 s, at least 2.5 s), not only at 45 s.
  await new Promise((r) => setTimeout(r, 2700));
  const saved = JSON.parse(inPage.w.localStorage.getItem("__appModuleManifest") || "[]");
  assert.deepStrictEqual(saved.map((u) => u.split("/").pop()), ["frame-shell-T1.js", "a.js"], "list saved: " + saved);

  const refused = await page("outside-only", { fastLoad: true });
  assert.strictEqual(refused.order.join(","), "a,shell:A");
  assert.ok(refused.viaApp.length >= 1, "fell back to the app");
  assert.ok(refused.statuses.some((s) => s.stage === "inline-refused"));
  assert.strictEqual(refused.w.__appLoader.inPage(), false);

  const classic = await page("dangerously", { fastLoad: false });
  assert.strictEqual(classic.order.join(","), "a,shell:A");
  assert.strictEqual(classic.viaApp.join(","), "frame-shell-T1.js,a.js", "classic runs through the app");

  // Modules ready before the HTML is parsed wait for it, then run in order.
  const parsing = { state: "loading" };
  const early = await page("dangerously", { fastLoad: true }, parsing);
  assert.strictEqual(early.order.join(","), "", "nothing runs while the HTML is parsed");
  parsing.state = "interactive";
  early.w.document.dispatchEvent(new early.w.Event("DOMContentLoaded"));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(early.order.join(","), "a,shell:A", "runs once parsed: " + early.order);

  console.log("PATCH PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
