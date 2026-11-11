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
  const opened = [];
  const open = (name) => {
    opened.push(name);
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
    opened,
    api: {
      open: async (name) => open(name),
      has: async (name) => stores.has(name),
      keys: async () => Array.from(stores.keys()),
      delete: async (name) => stores.delete(name),
    },
  };
}

// --- The app's module store (the moduleStore handler in ViewController.m) ----
function makeStore(fails) {
  const files = new Map();
  const calls = [];
  const dirs = new Set();
  return {
    files, calls, dirs,
    call: (m) => new Promise((resolve, reject) => setImmediate(() => {
      calls.push(m.op);
      dirs.add(m.dir);
      if (fails) return reject(new Error("refused"));
      if (m.op === "get") return resolve(m.keys.map((k) => (files.has(k) ? files.get(k) : null)));
      if (m.op === "put") { files.set(m.key, m.code); return resolve(true); }
      if (m.op === "prune") {
        const keep = new Set(m.keep);
        let removed = 0;
        for (const k of Array.from(files.keys())) if (!keep.has(k)) { files.delete(k); removed++; }
        return resolve({ removed, files: files.size, bytes: 0 });
      }
      reject(new Error("unknown operation"));
    })),
  };
}

function run({ fast, caches, manifest, store, migrate, workers = true, workerBreaks = false, failDownloads = 0, wait = 300 }) {
  const order = [];
  const fetched = [];
  const blobs = new Map();
  const fetchImpl = async (url) => {
    fetched.push(url.split("/").pop());
    const name = url.replace(BASE + "/", "");
    if (name === "c.js" && failDownloads-- > 0) throw new TypeError("Load failed");
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
    BASE_URL: BASE, fast, minify: fast, manifest: manifest || [], store, migrate,
    workerSource: transpilerSrc + "\n;\n" + workerGlue, workerCount: 2,
    target: { platform: "iOS", version: "16.3" },
    runScript: (code) => vm.runInContext(code, ctx),
  });
  LT.loadCode(BASE + "/index.js");
  return new Promise((resolve) => setTimeout(() => resolve({ LT, order, fetched, workersMade }), wait));
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
  assert.deepStrictEqual(first.LT.usedModules(60000), manifest, "all asked for within a minute");
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

  // The app's module store. First launch with it: modules move over from the
  // web cache, nothing is downloaded.
  const store = makeStore();
  const moved = await run({ fast: true, caches, manifest, store, migrate: true });
  assert.deepStrictEqual(moved.order, EXPECT, "fast order, moving to the store");
  const s4 = moved.LT.stats().stats;
  assert.strictEqual(s4.store, "app");
  assert.strictEqual(s4.migrated, 5, "moved: " + s4.migrated);
  assert.deepStrictEqual(moved.fetched, []);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(store.files.size, 5, "store filled");
  assert.strictEqual(store.files.get(BASE + "/a.js"), fastStore.get(BASE + "/a.js"), "same code");
  // Housekeeping with the store: unused files and every web cache go.
  const webBefore = new Map(fastStore);
  await moved.LT.pruneCache(manifest.filter((u) => !u.endsWith("d.js")));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!Array.from(caches.stores.keys()).some((n) => n.startsWith("transpiled")), "web caches deleted");
  assert.ok(!store.files.has(BASE + "/d.js") && store.files.has(BASE + "/c.js"), "unused file pruned");
  store.files.set(BASE + "/d.js", webBefore.get(BASE + "/d.js"));

  // Next launch: one batch read from the store, the web cache is not touched.
  caches.opened.length = 0;
  store.calls.length = 0;
  const fromStore = await run({ fast: true, caches, manifest, store, migrate: false });
  assert.deepStrictEqual(fromStore.order, EXPECT, "fast order from the store");
  const s5 = fromStore.LT.stats().stats;
  assert.strictEqual(s5.batchHits, 5, "from batches: " + s5.batchHits);
  assert.strictEqual(s5.batchesRead, 1);
  assert.strictEqual(s5.storeError, "");
  assert.deepStrictEqual(fromStore.fetched, []);
  assert.deepStrictEqual(caches.opened, [], "web cache untouched");
  assert.deepStrictEqual(store.calls, ["get"], "one request to the app: " + store.calls);
  assert.strictEqual(s5.storeInFlight, 0, "no store requests left open");

  // Empty store, nothing to move: transpiled in workers and saved in the store.
  const fresh = makeStore();
  const cold = await run({ fast: true, caches: makeCaches(), store: fresh, migrate: false });
  assert.deepStrictEqual(cold.order, EXPECT, "fast order, empty store");
  assert.strictEqual(cold.LT.stats().stats.workerJobs, 5);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(fresh.files.size, 5, "saved to the store");

  // A store that fails: the page still loads.
  const broken = makeStore(true);
  const failing = await run({ fast: true, caches: makeCaches(), manifest, store: broken, migrate: false });
  assert.deepStrictEqual(failing.order, EXPECT, "fast order, failing store");
  assert.ok(/refused/.test(failing.LT.stats().stats.storeError));
  // Larger launches are read 40 modules per request.
  const many = await run({ fast: true, caches: makeCaches(), manifest: manifest.concat(Array.from({ length: 80 }, (_, i) => BASE + "/x" + i + ".js")), store: makeStore() });
  assert.strictEqual(many.LT.stats().stats.batches, 3, "batches of 40");

  // Without the store: housekeeping on the web cache as before.
  const second2 = await run({ fast: true, caches, manifest });
  assert.deepStrictEqual(second2.order, EXPECT);

  // Housekeeping: old caches go, entries outside the keep list go.
  caches.stores.set("transpiled-v0.1.24", new Map([["old", "x"]]));
  second2.LT.pruneCache(manifest.filter((u) => !u.endsWith("d.js")));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!caches.stores.has("transpiled-v0.1.24"), "old cache removed");
  const fastStore2 = caches.stores.get("transpiled-fast-v0.1.24-1");
  assert.ok(!fastStore2.has(BASE + "/d.js") && fastStore2.has(BASE + "/c.js"), "unused entry pruned");

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

  // A download that fails (the head start, then the first real try) is tried
  // again; the page still starts, in order.
  const flaky = await run({ fast: true, caches: makeCaches(), workers: false, failDownloads: 2, wait: 2200 });
  assert.deepStrictEqual(flaky.order, EXPECT, "order after a retried download");
  const sFlaky = flaky.LT.stats().stats;
  assert.strictEqual(sFlaky.retries, 1, "one retry");
  assert.strictEqual(sFlaky.loadFailures, 0);

  // A download that keeps failing: given up after three tries, and the module
  // is not marked as loaded, so a later import starts over.
  const dead = await run({ fast: true, caches: makeCaches(), workers: false, failDownloads: 4, wait: 5200 });
  const sDead = dead.LT.stats().stats;
  assert.strictEqual(sDead.retries, 2);
  assert.strictEqual(sDead.loadFailures, 1);
  assert.ok(/^c.js: download failed/.test(sDead.loadError), sDead.loadError);
  assert.deepStrictEqual(dead.order, [], "nothing ran without c.js");
  dead.LT.importModule("./c.js");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(dead.order, EXPECT, "started over on the next import");

  console.log("LOADER PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
