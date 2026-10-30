"use strict";
// Exercises the transpiler's module loader in Node: classic and fast mode, the
// background-worker path, the deps line, prefetching from the last launch's
// list, and cache housekeeping, on a small module graph with a known order.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const repo = process.argv[2];
const transpilerSrc = fs.readFileSync(repo + "/ClaudeLegacy/legacy-transpiler.js", "utf8");
const workerGlue = fs.readFileSync(repo + "/ClaudeLegacy/transpile-worker.js", "utf8");
const BASE = "https://assets.example/v1";

const SOURCES = {
  "index.js": 'import{a as A}from"./a.js";import{b}from"./b.js";log("index:"+A+b);import("./d.js").then(m=>log("d:"+m.d));export const idx=1;',
  "a.js": 'import{c}from"./c.js";log("a");export const a="A"+c;',
  "b.js": 'import{c}from"./c.js";log("b");export const b="B"+c;',
  "c.js": 'log("c");const re=/(?<=x)y/;export const c="C";',
  "d.js": 'import{c}from"./c.js";export const d="D"+c;',
};

// --- A tiny CacheStorage --------------------------------------------------------
function makeCaches() {
  const stores = new Map();
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (url) => (m.has(url) ? new Response(m.get(url)) : undefined),
      put: async (url, resp) => { m.set(url, await resp.text()); },
      keys: async () => Array.from(m.keys()).map((url) => ({ url })),
      delete: async (req) => m.delete(typeof req === "string" ? req : req.url),
    };
  };
  return {
    stores,
    api: {
      open: async (name) => open(name),
      keys: async () => Array.from(stores.keys()),
      delete: async (name) => stores.delete(name),
    },
  };
}

function run({ fast, caches, manifest, workers = true, workerBreaks = false }) {
  const order = [];
  const fetched = [];
  const blobs = new Map();
  const fetchImpl = async (url) => {
    fetched.push(url.split("/").pop());
    const name = url.replace(BASE + "/", "");
    if (!(name in SOURCES)) return new Response("", { status: 404 });
    return new Response(SOURCES[name]);
  };
  class FakeBlob { constructor(parts) { this.text = parts.join(""); } }
  const URLx = { createObjectURL: (b) => { const id = "blob:" + blobs.size; blobs.set(id, b.text); return id; } };
  let workersMade = 0;
  class FakeWorker {
    constructor(url) {
      if (workerBreaks) throw new Error("no workers here");
      workersMade++;
      const self = { postMessage: (m) => setImmediate(() => this.onmessage && this.onmessage({ data: m })) };
      this.ctx = vm.createContext({ self, fetch: fetchImpl, Response, console, Date, Math, JSON, Object, Array, String, RegExp, Error, Set, Map, Promise, setTimeout });
      vm.runInContext(blobs.get(url), this.ctx);
    }
    postMessage(m) { setImmediate(() => this.ctx.self.onmessage({ data: JSON.parse(JSON.stringify(m)) })); }
  }
  const page = { console: { log() {}, warn() {}, error() {} }, Response, Set, Map, Promise, Math, JSON, Date, Object, Array, String, RegExp, Error, setImmediate, setTimeout, clearTimeout, performance };
  const ctx = vm.createContext(page);
  vm.runInContext(transpilerSrc + "\n;globalThis.LegacyTranspiler = LegacyTranspiler;", ctx);
  // Only now does the page get a window (the transpiler skips its browser patches).
  Object.assign(page, { window: page, caches: caches.api, fetch: fetchImpl, log: (x) => order.push(x) });
  if (workers) Object.assign(page, { Worker: FakeWorker, Blob: FakeBlob, URL: URLx });
  const LT = page.LegacyTranspiler;
  LT.init({
    BASE_URL: BASE, fast, minify: fast, manifest: manifest || [],
    workerSource: transpilerSrc + "\n;\n" + workerGlue, workerCount: 2,
    target: { platform: "iOS", version: "16.3" },
    runScript: (code) => vm.runInContext(code, ctx),
  });
  LT.loadCode(BASE + "/index.js");
  return new Promise((resolve) => setTimeout(() => resolve({ LT, order, fetched, workersMade }), 300));
}

(async () => {
  const EXPECT = ["c", "a", "b", "index:ACBC", "d:DC"];

  // Classic mode: original behaviour.
  const classicCaches = makeCaches();
  const classic = await run({ fast: false, caches: classicCaches });
  assert.deepStrictEqual(classic.order, EXPECT, "classic order");
  assert.ok(classicCaches.stores.has("transpiled-v0.1.24"));

  // Fast mode, empty cache: everything transpiled in workers, same order.
  const caches = makeCaches();
  caches.stores.set("transpiled-v0.1.24", new Map([["old", "x"]])); // a leftover classic cache
  const first = await run({ fast: true, caches });
  assert.deepStrictEqual(first.order, EXPECT, "fast order, cold cache");
  const s1 = first.LT.stats().stats;
  assert.strictEqual(s1.misses, 5);
  assert.strictEqual(s1.workerJobs, 5, "all transpiled in workers");
  assert.strictEqual(first.workersMade, 2);
  const fastStore = caches.stores.get("transpiled-fast-v0.1.24-1");
  const indexCode = fastStore.get(BASE + "/index.js");
  assert.ok(indexCode.startsWith("'use strict';\n//@deps ./a.js ./b.js\n"), "deps line: " + indexCode.slice(0, 60));
  assert.ok(!/\n {2}/.test(indexCode.split("\n").slice(2).join("\n")), "minified output");
  assert.ok(!/\(\?<=/.test(fastStore.get(BASE + "/c.js")), "lookbehind removed");
  const manifest = first.LT.usedModules();
  assert.strictEqual(manifest.map((u) => u.split("/").pop()).join(","), "index.js,a.js,c.js,b.js,d.js");

  // Second launch: all from cache, read in advance, nothing downloaded.
  const second = await run({ fast: true, caches, manifest });
  assert.deepStrictEqual(second.order, EXPECT, "fast order, warm cache");
  const s2 = second.LT.stats().stats;
  assert.strictEqual(s2.hits, 5);
  assert.strictEqual(s2.misses, 0);
  assert.ok(s2.prefetchUsed >= 4, "prefetched modules used: " + s2.prefetchUsed);
  assert.deepStrictEqual(second.fetched, []);
  const mods = second.LT.stats().modules;
  assert.ok(mods.every((m) => m.codeAt >= 0 && m.ranAt >= m.codeAt && m.doneAt >= m.codeAt), "timings recorded");

  // Housekeeping: old caches go, entries outside the keep list go.
  second.LT.pruneCache(manifest.filter((u) => !u.endsWith("d.js")));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!caches.stores.has("transpiled-v0.1.24"), "old cache removed");
  assert.ok(!fastStore.has(BASE + "/d.js") && fastStore.has(BASE + "/c.js"), "unused entry pruned");

  // No workers available: transpiled on the page instead, same order.
  const noWorkers = await run({ fast: true, caches: makeCaches(), workerBreaks: true });
  assert.deepStrictEqual(noWorkers.order, EXPECT, "fast order without workers");
  const s3 = noWorkers.LT.stats().stats;
  assert.strictEqual(s3.mainJobs, 5);
  assert.ok(/no workers here/.test(s3.workerError));

  // Worker output equals page output.
  const plain = makeCaches();
  await run({ fast: true, caches: plain, workers: false });
  assert.strictEqual(plain.stores.get("transpiled-fast-v0.1.24-1").get(BASE + "/a.js"), fastStore.get(BASE + "/a.js"));

  console.log("LOADER PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
