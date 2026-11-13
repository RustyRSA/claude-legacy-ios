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
  const chatLists = [];
  w.webkit = { messageHandlers: { chrome: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) }, appearance: { postMessage() {} },
    chatList: { postMessage: (m) => chatLists.push(JSON.parse(JSON.stringify(m))) } } };
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
  return { w, posted, clicks, chatLists };
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
  assert.ok(doc.querySelector("fieldset").hasAttribute("data-app-collapsed"), "message box takes no room");
  assert.strictEqual(state.composerShown, false);

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

  // A missing control: the app is not in use and claude.ai's top bar stays; only
  // the message box is hidden for its first 6 s (its buttons usually follow).
  const q = page(HEADER + '<div contenteditable="true" aria-label="Write your prompt to Claude"></div>');
  await new Promise((r) => setTimeout(r, 50));
  const s2 = q.posted[q.posted.length - 1];
  assert.strictEqual(s2.ready, false);
  assert.ok(/send button/.test(s2.why), s2.why);
  assert.deepStrictEqual(Array.from(q.w.document.querySelectorAll("[data-app-hidden]")).map((el) => el.getAttribute("aria-label")),
    ["Write your prompt to Claude"], "only the message box hidden, for now");
  assert.ok(/native controls: on, not in use \(missing/.test(q.w.__appDebugLog()), "reason in the debug log");

  // A chat: the top bar's buttons sit in two separate parts of the layout (title
  // group and share). Both are hidden, each on its own; the sidebar panel stays.
  const CHAT_TOP = '<aside class="dframe-sidebar"><button aria-label="Show sidebar" data-rect="10,8,32,32">≡</button></aside>' +
    '<div data-rect="0,0,357,800"><div data-rect="46,8,180,32" id="titlegroup"><button aria-label="Chat, rename session" data-rect="46,10,24,32">t</button>' +
    '<button aria-label="More options for Chat" data-rect="60,10,32,32">…</button></div>' +
    '<main data-rect="0,0,357,800"><div data-rect="267,8,82,32" id="sharegroup"><button aria-label="wiggle-controls-actions-share" data-rect="267,10,82,32">s</button></div>' +
    // A reply's toolbar scrolled far above the screen: not part of the top bar.
    '<div data-rect="82,-5404,132,24" id="replytools"><button aria-label="Copy" data-rect="82,-5404,24,24">c</button></div></main></div>';
  const chat = page(CHAT_TOP + COMPOSER, "https://claude.ai/chat/abc");
  await new Promise((res) => setTimeout(res, 50));
  const s3 = chat.posted[chat.posted.length - 1];
  assert.strictEqual(s3.ready, true, "chat ready: " + JSON.stringify(s3));
  assert.strictEqual(s3.more, true, "chat menu found");
  const cd = chat.w.document;
  assert.ok(cd.getElementById("titlegroup").hasAttribute("data-app-hidden"), "title group hidden");
  assert.ok(cd.getElementById("sharegroup").hasAttribute("data-app-hidden"), "share group hidden");
  assert.ok(!cd.getElementById("replytools").hasAttribute("data-app-hidden"), "reply toolbar above the screen untouched");
  assert.strictEqual(s3.topHeight, 40, "how far claude.ai's top bar reaches");
  assert.ok(!cd.querySelector("aside").hasAttribute("data-app-hidden"), "sidebar panel untouched");
  assert.strictEqual(chat.w.__appChrome.run("more"), "ok");
  assert.strictEqual(chat.clicks[chat.clicks.length - 1], "More options for Chat");

  // Voice mode: claude.ai's own message box is shown again and the app is told,
  // until claude.ai's voice button is back.
  const v = page(HEADER + SIDEBAR + COMPOSER);
  await new Promise((res) => setTimeout(res, 50));
  const vd = v.w.document;
  const voiceButton = vd.querySelector('[aria-label="Use voice mode"]');
  voiceButton.addEventListener("click", () => voiceButton.setAttribute("aria-label", "Stop voice mode"));
  assert.strictEqual(v.w.__appChrome.run("voice"), "ok");
  await new Promise((res) => setTimeout(res, 200));
  const vs = v.posted[v.posted.length - 1];
  assert.strictEqual(vs.ready, true);
  assert.strictEqual(vs.composerShown, true, "app told to step aside for voice mode");
  assert.ok(!vd.querySelector("fieldset").hasAttribute("data-app-hidden"), "claude.ai's box shown during voice mode");
  assert.ok(!vd.querySelector("fieldset").hasAttribute("data-app-collapsed"));
  assert.ok(vd.querySelector('[aria-label="Use incognito"]').closest("[data-app-hidden]"), "top bar still hidden");
  voiceButton.setAttribute("aria-label", "Use voice mode");
  await new Promise((res) => setTimeout(res, 1300));
  const ve = v.posted[v.posted.length - 1];
  assert.strictEqual(ve.composerShown, false, "back to the app's bar after voice mode");
  assert.ok(vd.querySelector("fieldset").hasAttribute("data-app-collapsed"));

  // claude.ai's text box without its buttons yet: hidden already, app not ready.
  const e = page(HEADER + SIDEBAR + '<fieldset id="early"><div contenteditable="true" aria-label="Write your prompt to Claude"></div></fieldset>');
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(e.posted[e.posted.length - 1].ready, false);
  assert.ok(e.w.document.querySelector('[contenteditable]').closest("[data-app-hidden]"), "message box hidden before its buttons");
  assert.ok(!e.w.document.querySelector('[aria-label="Use incognito"]').closest("[data-app-hidden]"), "nothing else hidden yet");

  // Text that turns up in claude.ai's hidden box goes to the app's bar, once.
  const st = page(HEADER + SIDEBAR + COMPOSER);
  await new Promise((res) => setTimeout(res, 50));
  st.w.document.querySelector('[contenteditable]').textContent = "late words";
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!st.posted.some((m) => m.dictated), "not taken while it may still be changing");
  await new Promise((res) => setTimeout(res, 1700));
  assert.ok(st.posted.some((m) => m.dictated === "late words"), "stray text handed to the app");
  assert.strictEqual(st.posted.filter((m) => m.dictated === "late words").length, 1, "handed over once");
  assert.ok(!/late words/.test(st.w.__appDebugLog()), "the text stays out of the debug log");

  // Dictation: claude.ai swaps its send button for finish / cancel. The box stays
  // hidden, the app is told it is listening, and finish / cancel press claude.ai's.
  const dc = page(HEADER + SIDEBAR + COMPOSER);
  await new Promise((res) => setTimeout(res, 50));
  const dd = dc.w.document;
  const sendButton = dd.querySelector('[aria-label="Send message"]');
  sendButton.setAttribute("aria-label", "Finish dictation");
  const cancel = dd.createElement("button");
  cancel.setAttribute("aria-label", "Cancel dictation");
  dd.querySelector("fieldset").appendChild(cancel);
  await new Promise((res) => setTimeout(res, 300));
  const ds = dc.posted[dc.posted.length - 1];
  assert.strictEqual(ds.ready, true, "still in use while dictating");
  assert.strictEqual(ds.dictating, true);
  assert.strictEqual(ds.composerShown, false, "claude.ai's box is not shown for dictation");
  assert.ok(dd.querySelector("fieldset").hasAttribute("data-app-collapsed"));
  assert.strictEqual(dc.w.__appChrome.run("dictateCancel"), "ok");
  assert.strictEqual(dc.clicks[dc.clicks.length - 1], "Cancel dictation");
  assert.strictEqual(dc.w.__appChrome.run("dictateFinish"), "ok");
  assert.strictEqual(dc.clicks[dc.clicks.length - 1], "Finish dictation");
  // A moment later claude.ai replaces the text box by its sound display: still
  // in use, still hidden.
  dd.querySelector('[contenteditable]').remove();
  await new Promise((res) => setTimeout(res, 300));
  const ds2 = dc.posted[dc.posted.length - 1];
  assert.strictEqual(ds2.ready, true, "in use without the text box while dictating: " + ds2.why);
  assert.strictEqual(ds2.dictating, true);
  assert.ok(dd.querySelector("fieldset").hasAttribute("data-app-collapsed"), "box still hidden");

  // At launch claude.ai draws the box, then draws it anew: the new one is hidden
  // in the same moment, and what the boxes were is remembered for the next launch.
  const el2 = page(HEADER + SIDEBAR + '<div class="early-stand-in-wrapper one" data-rect="20,180,310,60"><textarea data-rect="29,190,291,32"></textarea></div>');
  await new Promise((res) => setTimeout(res, 50));
  const ed = el2.w.document;
  assert.ok(ed.querySelector("textarea").closest("[data-app-hidden]"), "stand-in hidden");
  ed.querySelector(".early-stand-in-wrapper").remove();
  const real = ed.createElement("div");
  real.className = "real-box-in-the-middle two";
  real.setAttribute("data-rect", "20,230,320,50");
  real.innerHTML = '<div contenteditable="true" aria-label="Write your prompt to Claude" data-rect="33,238,299,22"></div>';
  ed.body.appendChild(real);
  await new Promise((res) => setTimeout(res, 20)); // well under the 120 ms timer
  assert.ok(real.querySelector("[contenteditable]").closest("[data-app-hidden]"), "redrawn box hidden at once");
  const remembered = JSON.parse(el2.w.localStorage.getItem("__appEarlyBox"));
  assert.ok(remembered.early.some((sel) => sel.includes("early-stand-in-wrapper")) && remembered.early.some((sel) => sel.includes("real-box-in-the-middle")),
    "early boxes remembered: " + JSON.stringify(remembered));

  // The sidebar's sections: small text buttons are headings, links are chats; a
  // row that is a button (32 px) is not a heading.
  const GA = "4407ad06-cdee-427d-ae9c-fb9a4db6c0d9", GB = "5681ff6f-e872-4539-91f3-c38fb5bc04e1", GC = "172b4950-1441-4bd4-9e21-0dfb407689e7";
  const g = page('<aside><button aria-label="Show sidebar" data-rect="10,8,32,32">≡</button><button data-rect="4,86,271,32">Search</button>' +
    '<button data-rect="10,276,261,29">Starred</button><a href="/chat/' + GA + '">Pinned one</a>' +
    '<a href="/artifact/Xog38J8m">An artifact</a><a href="/artifacts">Artifacts</a><button data-rect="4,376,271,32">Morning briefing</button><a href="/chat/' + GB + '">Second</a>' +
    '<button data-rect="10,560,233,29">Closed group</button><button data-rect="10,600,233,29">Recents</button><button aria-label="Filter and group recents" data-rect="247,602,24,24">f</button>' +
    '<a href="/chat/' + GC + '">Third</a></aside>' + COMPOSER);
  g.w.__appChrome.chatGroupsFromPage();
  assert.deepStrictEqual(g.chatLists[g.chatLists.length - 1], { groups: [
    { name: "Starred", chats: [{ path: "/chat/" + GA, name: "Pinned one" }, { path: "/artifact/Xog38J8m", name: "An artifact" },
      { path: "/chat/" + GB, name: "Second" }] },
    { name: "Closed group", chats: [] },
    { name: "Recents", chats: [{ path: "/chat/" + GC, name: "Third" }] }] });
  assert.ok(!/Pinned one|Starred/.test(g.w.__appDebugLog()), "names stay out of the debug log");

  // The chat list claude.ai fetched goes to the app: id, name, time; anything
  // that is not a chat is left out. Both shapes: a plain list and {data: [...]}.
  const ID1 = "4407ad06-cdee-427d-ae9c-fb9a4db6c0d9", ID2 = "5681ff6f-e872-4539-91f3-c38fb5bc04e1";
  chat.w.__appChrome.noteChatList([{ uuid: ID1, name: "First", updated_at: "2026-11-11T10:00:00Z" }, { uuid: "nope", name: "x" }]);
  chat.w.__appChrome.noteChatList({ data: [{ uuid: ID2, name: "Second", updated_at: "2026-11-10T10:00:00Z" }], has_more: false });
  assert.deepStrictEqual(chat.chatLists[0], { chats: [{ id: ID1, name: "First", updated: Date.parse("2026-11-11T10:00:00Z") }] });
  assert.strictEqual(chat.chatLists[1].chats[0].name, "Second");
  assert.ok(!/First|Second/.test(chat.w.__appDebugLog()), "chat names stay out of the debug log");
  assert.strictEqual(chat.w.__appChrome.run("openPath", "/chat/../../evil"), "not a chat address");
  assert.strictEqual(chat.w.__appChrome.run("openPath", "https://evil.example/chat/x"), "not a chat address");

  // The model menu: claude.ai's menu is opened unseen, read, and closed; a pick
  // presses the item in it.
  const md = chat.w.document;
  const modelButton = md.querySelector('[aria-label^="Model:"]');
  let picked = "";
  modelButton.addEventListener("click", () => {
    const open = md.querySelector('[role="menu"]');
    if (open) { open.remove(); return; }
    const menu = md.createElement("div");
    menu.setAttribute("role", "menu");
    menu.innerHTML = '<div role="group" aria-label="Models"><div role="menuitemradio" aria-checked="true">\uE123 Opus 5.5</div>' +
      '<div role="menuitemradio" aria-checked="false">Sonnet 5.5</div></div>' +
      '<div role="menuitemradio" aria-checked="true">Extra</div>' +
      '<div role="menuitem" aria-haspopup="menu">More models</div>' +
      '<div role="menuitem">Fable is included in Max and Team plans</div><div role="menuitem">Close</div>';
    menu.addEventListener("click", (e) => { picked = e.target.textContent; menu.remove(); });
    md.body.appendChild(menu);
  });
  const listed = JSON.parse(await chat.w.__appChrome.run("menuItems", "model"));
  assert.deepStrictEqual(listed.map((i) => i.title), ["Opus 5.5", "Sonnet 5.5", "Extra", "More models"], "icon characters left out");
  assert.deepStrictEqual(listed.map((i) => i.group), ["Models", "Models", "Effort", ""]);
  assert.strictEqual(listed[0].checked, true);
  assert.strictEqual(listed[3].sub, true);
  assert.ok(!md.querySelector('[role="menu"]'), "claude.ai's menu closed again");
  assert.ok(!md.documentElement.classList.contains("app-menu-quiet"), "menus visible again");
  assert.strictEqual(await chat.w.__appChrome.run("menuPick", "model\n1\nSonnet 5.5"), "ok");
  assert.strictEqual(picked, "Sonnet 5.5");
  assert.ok(!md.documentElement.classList.contains("app-menu-quiet"));
  assert.strictEqual(await chat.w.__appChrome.run("menuItems", "nothing"), "[]");

  // Pages other than new chat and chats keep claude.ai's own controls.
  const r = page(HEADER + COMPOSER, "https://claude.ai/projects");
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(r.posted[r.posted.length - 1].ready, false);

  console.log("CHROME PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
