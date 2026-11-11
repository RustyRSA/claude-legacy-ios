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
  // jsdom has no layout: elements with data-rect="x,y,w,h" get that box.
  const plainRect = w.Element.prototype.getBoundingClientRect;
  w.Element.prototype.getBoundingClientRect = function () {
    const r = this.getAttribute && this.getAttribute("data-rect");
    if (!r) return plainRect.call(this);
    const [x, y, wd, h] = r.split(",").map(Number);
    return { left: x, top: y, width: wd, height: h, right: x + wd, bottom: y + h };
  };
  w.eval(src);
  return { w, posted, clicks };
}

// As on claude.ai: "Show sidebar" lives in the collapsed sidebar panel, the top bar holds the rest.
const HEADER = '<aside class="dframe-sidebar"><button aria-label="Show sidebar" data-rect="10,8,32,32">≡</button></aside>' +
  '<header><button aria-label="Use incognito" data-rect="300,8,32,32">g</button></header>';
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
  assert.strictEqual(state.title, "", "no title on a new chat");
  assert.strictEqual(state.effort, "Extra");
  assert.strictEqual(state.voice, true);
  assert.strictEqual(state.incognito, true);
  const doc = p.w.document;
  assert.ok(doc.documentElement.classList.contains("app-native-chrome"));
  assert.ok(doc.querySelector('[aria-label="Use incognito"]').closest("[data-app-hidden]"), "top bar hidden");
  assert.ok(doc.querySelector('[aria-label="Show sidebar"]').hasAttribute("data-app-hidden"), "sidebar button hidden");
  assert.ok(!doc.querySelector("aside").hasAttribute("data-app-hidden"), "sidebar panel untouched");
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

  // Keyboard room: accepted, and removed again with 0.
  assert.ok(["ok", "no message list"].includes(C.run("keyboard", "300,393")));
  assert.strictEqual(C.run("keyboard", "0,393"), "ok");

  // Where the page can take a paste: the text arrives without focusing claude.ai's
  // box (the app's keyboard stays up).
  const pp = page(HEADER + SIDEBAR + COMPOSER);
  pp.w.DataTransfer = class { constructor() { this.d = {}; } setData(t, v) { this.d[t] = v; } getData(t) { return this.d[t]; } };
  pp.w.ClipboardEvent = class extends pp.w.Event { constructor(type, init) { super(type, init); this.clipboardData = init.clipboardData; } };
  const ppEditor = pp.w.document.querySelector('[contenteditable="true"]');
  ppEditor.addEventListener("paste", (e) => { ppEditor.textContent = e.clipboardData.getData("text/plain"); });
  let focused = false;
  ppEditor.addEventListener("focus", () => { focused = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(await pp.w.__appChrome.run("send", "Pasted hello"), "ok");
  assert.strictEqual(ppEditor.textContent, "Pasted hello");
  assert.strictEqual(pp.w.__typed, undefined, "not typed");
  assert.ok(!focused, "claude.ai's box never focused");
  assert.ok(/send \(pasted\): ok/.test(pp.w.__appDebugLog()));
  // Long text is typed instead (claude.ai makes long pastes into a file).
  ppEditor.textContent = "";
  assert.strictEqual(await pp.w.__appChrome.run("send", "x".repeat(2500)), "ok");
  assert.strictEqual(pp.w.__typed.length, 2500);

  // A missing control: nothing hidden, the app keeps claude.ai's own controls.
  const q = page(HEADER + '<div contenteditable="true" aria-label="Write your prompt to Claude"></div>');
  await new Promise((r) => setTimeout(r, 50));
  const s2 = q.posted[q.posted.length - 1];
  assert.strictEqual(s2.ready, false);
  assert.ok(/send button/.test(s2.why), s2.why);
  assert.ok(!q.w.document.querySelector("[data-app-hidden]"), "nothing hidden");
  assert.ok(/native controls: on, not in use \(missing/.test(q.w.__appDebugLog()), "reason in the debug log");

  // A chat: the top bar's buttons sit in two separate parts of the layout (title
  // group and share). Both are hidden, each on its own; the sidebar panel stays.
  const CHAT_TOP = '<aside class="dframe-sidebar"><button aria-label="Show sidebar" data-rect="10,8,32,32">≡</button></aside>' +
    '<div data-rect="0,0,357,800"><div data-rect="46,8,180,32" id="titlegroup"><button aria-label="Chat, rename session" data-rect="46,10,24,32">t</button>' +
    '<button aria-label="More options for Chat" data-rect="60,10,32,32">…</button></div>' +
    '<main data-rect="0,0,357,800"><div data-rect="267,8,82,32" id="sharegroup"><button aria-label="wiggle-controls-actions-share" data-rect="267,10,82,32">s</button></div></main></div>';
  const chat = page(CHAT_TOP + COMPOSER, "https://claude.ai/chat/abc");
  await new Promise((res) => setTimeout(res, 50));
  const s3 = chat.posted[chat.posted.length - 1];
  assert.strictEqual(s3.ready, true, "chat ready: " + JSON.stringify(s3));
  assert.strictEqual(s3.more, true, "chat menu found");
  const cd = chat.w.document;
  assert.ok(cd.getElementById("titlegroup").hasAttribute("data-app-hidden"), "title group hidden");
  assert.ok(cd.getElementById("sharegroup").hasAttribute("data-app-hidden"), "share group hidden");
  assert.ok(!cd.querySelector("aside").hasAttribute("data-app-hidden"), "sidebar panel untouched");
  assert.strictEqual(chat.w.__appChrome.run("more"), "ok");
  assert.strictEqual(chat.clicks[chat.clicks.length - 1], "More options for Chat");

  // Pages other than new chat and chats keep claude.ai's own controls.
  const r = page(HEADER + COMPOSER, "https://claude.ai/projects");
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(r.posted[r.posted.length - 1].ready, false);

  console.log("CHROME PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
