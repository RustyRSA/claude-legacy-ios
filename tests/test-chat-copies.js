"use strict";
// Chat copies (round 24), page side (app-tweaks.js): when claude.ai fetches a
// chat with its messages, the text of the branch on screen goes to the app's
// chatList handler (tools, artifacts and files as short marks, thinking left
// out); a chat claude.ai reports as gone is reported too. Off unless the app sets
// chatCopies. No text, names or file names in the debug log.
const { JSDOM } = require(process.argv[3] + "/node_modules/jsdom");
const fs = require("fs");
const assert = require("assert");
const src = fs.readFileSync(process.argv[2] + "/ClaudeLegacy/app-tweaks.js", "utf8");

const ORG = "11111111-2222-4333-8444-555555555555";
const CHAT = "4407ad06-cdee-427d-ae9c-fb9a4db6c0d9";
const ROOT = "00000000-0000-4000-8000-000000000000";
const URL_OF = (id) => "https://claude.ai/api/organizations/" + ORG + "/chat_conversations/" + id +
  "?tree=True&rendering_mode=messages&render_all_tools=true";

// A chat whose second question was edited: two branches, the second on screen.
const CONVERSATION = {
  uuid: CHAT, name: "Secret plans", updated_at: "2026-11-26T18:00:00Z",
  current_leaf_message_uuid: "m5",
  chat_messages: [
    { uuid: "m1", parent_message_uuid: ROOT, index: 0, sender: "human", created_at: "2026-11-26T17:00:00Z",
      content: [{ type: "text", text: "First question" }], files: [{ file_name: "notes.pdf" }], files_v2: [{ file_name: "notes.pdf" }] },
    { uuid: "m2", parent_message_uuid: "m1", index: 1, sender: "assistant", created_at: "2026-11-26T17:00:05Z",
      content: [{ type: "thinking", thinking: "hidden thoughts" }, { type: "text", text: "First **answer**" },
        { type: "tool_use", name: "artifacts", input: { title: "Plan" } }, { type: "tool_result", content: [] },
        { type: "tool_use", name: "web_search", input: {} }, { type: "tool_use", name: "web_search", input: {} }] },
    { uuid: "m3", parent_message_uuid: "m2", index: 2, sender: "human", created_at: "2026-11-26T17:01:00Z",
      content: [{ type: "text", text: "Old second question" }] },
    { uuid: "m4", parent_message_uuid: "m2", index: 4, sender: "human", created_at: "2026-11-26T17:02:00Z",
      content: [{ type: "text", text: "New second question" }] },
    { uuid: "m5", parent_message_uuid: "m4", index: 5, sender: "assistant", created_at: "2026-11-26T17:02:09Z",
      content: [{ type: "text", text: "Second answer" }] },
  ],
};

function page(settings, respond) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>",
    { runScripts: "outside-only", url: "https://claude.ai/chat/" + CHAT, pretendToBeVisual: true });
  const w = dom.window;
  const posted = [];
  w.webkit = { messageHandlers: { chatList: { postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))) },
    chrome: { postMessage() {} }, appearance: { postMessage() {} } } };
  w.__appSettings = settings;
  // claude.ai's own request, answered like the real one (the body can be read once, clone() first).
  w.fetch = async (url) => {
    const { status, body } = respond(url);
    const make = () => ({ status, ok: status === 200, url, clone: make, text: async () => body, json: async () => JSON.parse(body) });
    return make();
  };
  w.eval(src);
  return { w, posted };
}

(async () => {
  const p = page({ nativeChrome: 1, chatCopies: true }, (url) =>
    url.indexOf(CHAT) !== -1 ? { status: 200, body: JSON.stringify(CONVERSATION) } : { status: 404, body: "{}" });

  // The branch on screen, oldest first; marks for tools, artifacts and files.
  // Results come from the page's own realm: compared as plain data.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const copy = plain(p.w.__appChrome.chatCopyFrom(CONVERSATION, CHAT));
  assert.deepStrictEqual(copy.messages.map((m) => m.role + ": " + m.text), [
    "user: First question\n\n[File: notes.pdf]",
    "assistant: First **answer**\n\n[Artifact: Plan]\n\n[Used web search]",
    "user: New second question",
    "assistant: Second answer",
  ]);
  assert.strictEqual(copy.messages[0].at, Date.parse("2026-11-26T17:00:00Z"));
  assert.strictEqual(copy.name, "Secret plans");
  assert.strictEqual(copy.earlier, false);
  assert.strictEqual(p.w.__appChrome.chatCopyFrom({ chat_messages: [] }, CHAT), null, "nothing to keep");
  assert.strictEqual(p.w.__appChrome.chatCopyFrom({ other: 1 }, CHAT), null, "not a chat");

  // Without parent links: in claude.ai's order.
  const flat = plain(p.w.__appChrome.chatCopyFrom({ chat_messages: [
    { index: 1, sender: "assistant", text: "b" }, { index: 0, sender: "human", text: "a" }] }, CHAT));
  assert.deepStrictEqual(flat.messages.map((m) => m.text), ["a", "b"]);

  // A very long chat keeps its newest messages.
  const big = { chat_messages: Array.from({ length: 12 }, (_, i) => ({ index: i, sender: i % 2 ? "assistant" : "human", text: i + ":" + "x".repeat(150000) })) };
  const kept = p.w.__appChrome.chatCopyFrom(big, CHAT);
  assert.strictEqual(kept.earlier, true);
  assert.ok(kept.messages.length < 12 && kept.messages[kept.messages.length - 1].text.startsWith("11:"), "newest kept");

  // claude.ai fetches the chat: its copy goes to the app a moment later.
  await p.w.fetch(URL_OF(CHAT));
  await new Promise((r) => setTimeout(r, 1700));
  const sent = p.posted.filter((m) => m.copy);
  assert.strictEqual(sent.length, 1, "copy sent: " + JSON.stringify(p.posted).slice(0, 200));
  assert.strictEqual(sent[0].copy.id, CHAT);
  assert.strictEqual(sent[0].copy.messages.length, 4);
  // The same chat fetched again unchanged: not sent again.
  await p.w.fetch(URL_OF(CHAT));
  await new Promise((r) => setTimeout(r, 1700));
  assert.strictEqual(p.posted.filter((m) => m.copy).length, 1, "unchanged chat not sent twice");
  // A chat claude.ai no longer has.
  const GONE = "5681ff6f-e872-4539-91f3-c38fb5bc04e1";
  await p.w.fetch(URL_OF(GONE));
  assert.ok(p.posted.some((m) => m.gone === GONE), "gone chat reported");
  // Other requests on the same chat (title, completion) are not copies.
  await p.w.fetch("https://claude.ai/api/organizations/" + ORG + "/chat_conversations/" + CHAT + "/title");
  await new Promise((r) => setTimeout(r, 1700));
  assert.strictEqual(p.posted.filter((m) => m.copy).length, 1);
  // The debug log has counts only.
  const log = p.w.__appDebugLog();
  assert.ok(/chat copy: 4 messages, \d+ characters/.test(log), "noted in the log");
  assert.ok(!/Secret plans|question|answer|notes\.pdf|Plan\]/.test(log), "no text, names or file names in the log");

  // Off: nothing is read or sent.
  const off = page({ nativeChrome: 1, chatCopies: false }, () => ({ status: 200, body: JSON.stringify(CONVERSATION) }));
  await off.w.fetch(URL_OF(CHAT));
  await new Promise((r) => setTimeout(r, 1700));
  assert.strictEqual(off.posted.filter((m) => m.copy || m.gone).length, 0, "off: nothing sent");

  console.log("CHAT COPIES PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
