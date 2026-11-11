"use strict";
// app-tweaks.js round-6 behaviour in jsdom: page size, tap fix, taps without a
// click, selectable message text, sign-out and refused-request events, long
// timers and the launch summary.
const { JSDOM } = require(process.argv[3] + "/node_modules/jsdom");
const fs = require("fs");
const assert = require("assert");
const src = fs.readFileSync(process.argv[2] + "/ClaudeLegacy/app-tweaks.js", "utf8");

function make(url, settings) {
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head>' +
    '<body><nav><a id="chat" href="/chat/0b1c2d3e-1111-2222-3333-444455556666"><span id="label">x</span></a></nav>' +
    '<div class="font-claude-response"><p id="reply">hello</p></div><div id="editor" contenteditable="true">t</div></body></html>';
  const dom = new JSDOM(html, { runScripts: "outside-only", url, pretendToBeVisual: true });
  const w = dom.window;
  const events = [];
  w.__appSettings = Object.assign({ diagnostics: true }, settings); // long timers and stalls are measured
  w.webkit = { messageHandlers: { appEvent: { postMessage: (m) => events.push(m) }, appearance: { postMessage() {} } } };
  w.document.elementsFromPoint = () => [w.document.body];
  w.visualViewport = { width: 393, scale: 1 };
  let respond = { status: 200, body: "{}" };
  w.fetch = async () => ({ status: respond.status, clone() { return { text: async () => respond.body }; } });
  w.eval(src);
  return { w, events, setResponse: (r) => { respond = r; } };
}
const touch = (w, type, target, x = 10, y = 10) => {
  const e = new w.Event(type, { bubbles: true });
  e.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
  target.dispatchEvent(e);
};

(async () => {
  // Page size 110 %: narrower layout width, zoomed to fit.
  const big = make("https://claude.ai/new", { pageScale: 1.1, tapFix: true });
  await new Promise((r) => setTimeout(r, 50));
  const vp = big.w.document.querySelector('meta[name="viewport"]').getAttribute("content");
  assert.ok(/width=357/.test(vp) && /initial-scale=1\.100/.test(vp) && /maximum-scale=1\.100/.test(vp) && /viewport-fit=cover/.test(vp), vp);
  const css = big.w.document.getElementById("app-tweaks-style").textContent;
  assert.ok(/\.font-claude-response \*/.test(css) && /user-select:text/.test(css) && !/a\{-webkit-touch-callout:none/.test(css));

  // Tap fix: the pretend mouseover after a touch does not reach the page.
  let hovered = 0;
  big.w.document.getElementById("chat").addEventListener("mouseover", () => hovered++);
  touch(big.w, "touchstart", big.w.document.getElementById("label"));
  big.w.document.getElementById("label").dispatchEvent(new big.w.MouseEvent("mouseover", { bubbles: true }));
  assert.strictEqual(hovered, 0, "mouseover held back after a touch");
  touch(big.w, "touchend", big.w.document.getElementById("label"));
  // No click follows: counted as a tap without a click.
  await new Promise((r) => setTimeout(r, 900));
  let log = big.w.__appDebugLog();
  assert.ok(/chat list: 1 taps, 1 without a click/.test(log), log.split("\n").filter((l) => /taps/.test(l)).join(" | "));
  assert.ok(/a \/chat\/…/.test(log), "missed tap target described without the id");

  // A tap that is followed by a click is fine and starts a chat-open timing.
  touch(big.w, "touchstart", big.w.document.getElementById("label"));
  touch(big.w, "touchend", big.w.document.getElementById("label"));
  big.w.document.getElementById("label").dispatchEvent(new big.w.MouseEvent("click", { bubbles: true }));
  big.w.history.pushState({}, "", "/chat/0b1c2d3e-1111-2222-3333-444455556666");
  await new Promise((r) => setTimeout(r, 50));
  log = big.w.__appDebugLog();
  assert.ok(/clicked 1/.test(log));

  // Long timers during start-up are listed with their caller.
  big.w.setTimeout(() => {}, 5000);
  log = big.w.__appDebugLog();
  assert.ok(/long timers: 5000 ms/.test(log), "long timer listed");

  // Refused request and an involuntary sign-out reach the app's event log.
  big.setResponse({ status: 401, body: '{"type":"error","error":{"type":"permission_error","details":{"error_code":"account_session_invalid"}}}' });
  await big.w.fetch("/api/organizations/0b1c2d3e-1111-2222-3333-444455556666/chat_conversations");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(big.events.some((e) => /^api 401 GET \/api\/organizations\/…\/chat_conversations \(permission_error\/account_session_invalid\)$/.test(e)), big.events.join(" | "));
  const out = make("https://claude.ai/login?from=logout&reauth=1&returnTo=%2Fnew", {});
  assert.ok(out.events.some((e) => e === "signed out: /login (reauth=1)"), out.events.join(" | "));

  // Tap fix off: the page gets its hover events.
  const off = make("https://claude.ai/new", { tapFix: false });
  let hovered2 = 0;
  off.w.document.getElementById("chat").addEventListener("mouseover", () => hovered2++);
  touch(off.w, "touchstart", off.w.document.getElementById("label"));
  off.w.document.getElementById("label").dispatchEvent(new off.w.MouseEvent("mouseover", { bubbles: true }));
  assert.strictEqual(hovered2, 1);
  await new Promise((r) => setTimeout(r, 50));
  const vp2 = off.w.document.querySelector('meta[name="viewport"]').getAttribute("content");
  assert.ok(/width=device-width/.test(vp2) && /maximum-scale=1(,|$)/.test(vp2), vp2);

  console.log(log.split("\n").slice(0, 14).join("\n"));
  console.log("TWEAKS2 PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
