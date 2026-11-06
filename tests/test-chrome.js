"use strict";
// Native controls, page side (app-tweaks.js): on a page with claude.ai's labels
// the header and message box are found, hidden and reported as ready; actions
// press claude.ai's buttons; "send" types into the box and presses send; with a
// control missing nothing is hidden. Native side: ViewController.m NativeChrome.
const { JSDOM } = require(process.argv[3] + "/node_modules/jsdom");
const fs = require("fs");
const assert = require("assert");
const src = fs.readFileSync(process.argv[2] + "/ClaudeLegacy/app-tweaks.js", "utf8");

function page(html, url) {
  const dom = new JSDOM("<!doctype html><html><head></head><body>" + html + "</body></html>",
    { runScripts: "outside-only", url: url || "https://claude.ai/new", pretendToBeVisual: true });
  const w = dom.window;
  const posted = [];
  const clicks = [];
  w.webkit = { messageHandlers: { chrome: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }, appearance: { postMessage() {} } } };
  w.__appSettings = { nativeChrome: 1 }; // as the app's JSON may send it
  w.document.addEventListener("click", (e) => clicks.push(e.target.getAttribute("aria-label") || e.target.getAttribute("href")), true);
  w.document.execCommand = (cmd, ui, text) => { w.__typed = text; return true; };
  w.eval(src);
  return { w, posted, clicks };
}

const HEADER = '<header><button aria-label="Show sidebar">≡</button><button aria-label="Use incognito">g</button></header>';
const COMPOSER = '<fieldset><div contenteditable="true" aria-label="Write your prompt to Claude"></div>' +
  '<button aria-label="Add files, connectors, and more">+</button><button aria-label="Model: Opus 5.5 Extra">Opus</button>' +
  '<button aria-label="Dictate">m</button><button aria-label="Send message">↑</button><button aria-label="Use voice mode">v</button></fieldset>';
const SIDEBAR = '<nav><a href="/new">New</a><a href="/artifacts">Artifacts</a></nav>';

(async () => {
  const p = page(HEADER + SIDEBAR + COMPOSER);
  await new Promise((r) => setTimeout(r, 50));
  const state = p.posted[p.posted.length - 1];
  assert.ok(state, "state posted");
  assert.strictEqual(state.ready, true, "ready: " + JSON.stringify(state));
  assert.strictEqual(state.page, "new");
  assert.strictEqual(state.model, "Opus 5.5");
  assert.strictEqual(state.effort, "Extra");
  assert.strictEqual(state.voice, true);
  assert.strictEqual(state.incognito, true);
  const doc = p.w.document;
  assert.ok(doc.documentElement.classList.contains("app-native-chrome"));
  assert.ok(doc.querySelector("header").hasAttribute("data-app-hidden") || doc.querySelector('[aria-label="Show sidebar"]').closest("[data-app-hidden]"), "header hidden");
  assert.ok(doc.querySelector('[aria-label="Send message"]').closest("[data-app-hidden]"), "message box hidden");

  const C = p.w.__appChrome;
  assert.strictEqual(C.run("model"), "ok");
  // Sidebar: claude.ai's own interface comes back and the app's controls step aside.
  assert.strictEqual(C.run("sidebar"), "ok");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!doc.querySelector("[data-app-hidden]"), "nothing hidden while the sidebar is open");
  assert.strictEqual(p.posted[p.posted.length - 1].sidebarOpen, true, "app told to step aside");
  p.w.history.pushState({}, "", "/chat/abc"); // a chat picked from the sidebar
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(p.posted[p.posted.length - 1].sidebarOpen, false, "back after a chat is picked");
  assert.ok(/sidebar closed \(chat picked\)/.test(p.w.__appDebugLog()));
  assert.strictEqual(C.run("plus"), "ok");
  assert.strictEqual(C.run("newChat"), "ok");
  assert.strictEqual(C.run("stop"), "missing stop button");
  assert.deepStrictEqual(p.clicks, ["Model: Opus 5.5 Extra", "Show sidebar", "Add files, connectors, and more", "/new"]);

  const sent = await C.run("send", "Hello there");
  assert.strictEqual(sent, "ok");
  assert.strictEqual(p.w.__typed, "Hello there", "text typed into claude.ai's box");
  assert.strictEqual(p.clicks[p.clicks.length - 1], "Send message");
  const editor = doc.querySelector('[contenteditable="true"]');
  assert.ok(!editor.hasAttribute("inputmode"), "inputmode restored");
  assert.strictEqual(await C.run("send", "   "), "nothing to send");

  // A missing control: nothing hidden, the app keeps claude.ai's own controls.
  const q = page(HEADER + '<div contenteditable="true" aria-label="Write your prompt to Claude"></div>');
  await new Promise((r) => setTimeout(r, 50));
  const s2 = q.posted[q.posted.length - 1];
  assert.strictEqual(s2.ready, false);
  assert.ok(/send button/.test(s2.why), s2.why);
  assert.ok(!q.w.document.querySelector("[data-app-hidden]"), "nothing hidden");
  assert.ok(/native controls: on, not in use \(missing/.test(q.w.__appDebugLog()), "reason in the debug log");

  // Pages other than new chat and chats keep claude.ai's own controls.
  const r = page(HEADER + COMPOSER, "https://claude.ai/projects");
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(r.posted[r.posted.length - 1].ready, false);

  console.log("CHROME PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
