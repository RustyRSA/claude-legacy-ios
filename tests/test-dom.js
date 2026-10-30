"use strict";
// Loads app-tweaks.js into a jsdom page and checks the page-side behaviour:
// viewport lock and styles, edge colours (incl. a dimming overlay and following
// a tap), pinning the message box's scroll area, debug-log filtering, socket
// handling with an iOS-16-strict fake WebSocket, and the responsiveness figures.
const { JSDOM } = require(process.argv[3] + "/node_modules/jsdom");
const fs = require("fs");
const assert = require("assert");
const src = fs.readFileSync(process.argv[2] + "/ClaudeLegacy/app-tweaks.js", "utf8");
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"></head>' +
  '<body style="background: rgb(21, 21, 21)">' +
  '<header id="top" style="background: rgb(30, 30, 30)">h</header>' +
  '<div id="overlay" style="background: rgba(0, 0, 0, 0.5)"></div>' +
  '<main id="scroller" style="overflow-y: auto"><div id="messages">m</div><div id="editor" contenteditable="true">type</div></main>' +
  '<footer id="bottom" style="background: rgb(40, 40, 40)">f</footer></body></html>';
const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://claude.ai/new", pretendToBeVisual: true });
const w = dom.window;
const $ = (id) => w.document.getElementById(id);
const posted = [];
w.webkit = { messageHandlers: { appearance: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) } } };
let overlayShown = false;
w.document.elementsFromPoint = (x, y) => (y < 10
  ? (overlayShown ? [$("overlay"), $("top"), w.document.body, w.document.documentElement] : [$("top"), w.document.body, w.document.documentElement])
  : [$("bottom"), w.document.body, w.document.documentElement]);
$("editor").getBoundingClientRect = () => ({ top: 700, bottom: 740, height: 40, left: 0, right: 390, width: 390 });

class StrictSocket extends w.EventTarget {
  constructor(url, protocols) {
    super();
    if (!/^wss?:\/\//.test(String(url))) throw new w.DOMException("The string did not match the expected pattern.", "SyntaxError");
    this.url = String(url); this.protocols = protocols; StrictSocket.made.push(this);
  }
  fire(type, props) { const e = new w.Event(type); Object.assign(e, props || {}); this.dispatchEvent(e); }
}
StrictSocket.made = [];
StrictSocket.OPEN = 1;
w.WebSocket = StrictSocket;

w.eval(src);
w.__appPatchModule("export const x = 1;", "first-module.js"); // claude.ai code has started

// Sockets: https -> wss for the voice session; already-wss untouched; bad still throws.
const ws = new w.WebSocket("https://claude.ai/api/ws/voice/organizations/0b1c2d3e-1111-2222-3333-444455556666/chat_conversations/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff?input_encoding=linear16");
assert.ok(ws.url.startsWith("wss://claude.ai/api/ws/voice/"));
const dict = new w.WebSocket("wss://claude.ai/api/ws/speech_to_text/voice_stream?a=b", ["p", "ticket.SECRET"]);
assert.strictEqual(dict.url, "wss://claude.ai/api/ws/speech_to_text/voice_stream?a=b");
assert.throws(() => new w.WebSocket("ftp://claude.ai/api/ws/voice/x"));

// MutationObserver still works through the timing wrapper, and its cost is counted
// (created after start-up, so it counts as claude.ai's).
let seen = 0;
setTimeout(() => {
  const mo = new w.MutationObserver((records) => { seen += records.length; });
  assert.ok(mo instanceof w.MutationObserver);
  mo.observe($("messages"), { childList: true });
  $("messages").appendChild(w.document.createElement("p"));
}, 10);

w.console.warn("Datadog Browser SDK: truncated");
w.console.log("[AudioRecorder] Selected backend:", "pcm");
for (let i = 0; i < 3; i++) w.__appLogNative("audio: route changed, output Speaker");

setTimeout(() => {
  assert.strictEqual(seen, 1, "wrapped MutationObserver delivered records");
  const vp = w.document.querySelector('meta[name="viewport"]').getAttribute("content");
  assert.ok(/user-scalable=no/.test(vp) && /maximum-scale=1/.test(vp));
  const css = $("app-tweaks-style").textContent;
  assert.ok(/touch-action:manipulation/.test(css) && /overscroll-behavior:none/.test(css) && /tap-highlight/.test(css));
  assert.deepStrictEqual(posted[0], { top: { r: 30, g: 30, b: 30 }, bottom: { r: 40, g: 40, b: 40 } });

  // Message box: touching the page pins the scroll area that holds it.
  w.document.dispatchEvent(new w.Event("touchstart"));
  assert.strictEqual($("scroller").__appPinned, true, "scroll area holding the message box pinned");
  assert.ok(!$("messages").__appPinned, "unrelated elements untouched");

  // Sidebar-like change: a tap, then a dimming overlay appears 100 ms later.
  const before = posted.length;
  w.document.dispatchEvent(new w.Event("touchend"));
  setTimeout(() => { overlayShown = true; $("overlay").setAttribute("data-open", "true"); }, 100);
  setTimeout(() => {
    const last = posted[posted.length - 1];
    console.log("after tap + overlay:", JSON.stringify(last));
    assert.ok(posted.length > before, "a new report followed the tap");
    assert.deepStrictEqual(last.top, { r: 15, g: 15, b: 15 }, "overlay blended over the header (50% black over 30)");

    const log = w.__appDebugLog();
    console.log("---- debug log ----\n" + log + "\n-------------------");
    assert.ok(/taps measured: 1, page reacts after median \d+ ms/.test(log), "tap reaction measured");
    assert.ok(/frames after taps: [1-9]\d*, over 50 ms: \d+/.test(log), "frames watched");
    assert.ok(/page-watching work: polyfills \d+ ms in \d+ calls .* claude\.ai \d+ ms in [1-9]\d* calls/.test(log), "observer cost split");
    assert.ok(!/Datadog/.test(log) && /Selected backend/.test(log));
    assert.strictEqual((log.match(/output Speaker/g) || []).length, 1);
    assert.ok(!/SECRET|0b1c2d3e/.test(log));
    console.log("DOM PASS");
    process.exit(0);
  }, 700);
}, 50);
