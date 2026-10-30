// Runs the real legacy-transpiler on code reproducing claude.ai's voice-mode
// snippets (copied verbatim from the live build), applies app-tweaks.js's
// module patches, executes the result and checks the behaviour.
"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const repo = process.argv[2];
const transpilerSrc = fs.readFileSync(repo + "/ClaudeLegacy/legacy-transpiler.js", "utf8");
const tweaksSrc = fs.readFileSync(repo + "/ClaudeLegacy/app-tweaks.js", "utf8");

// --- Snippets exactly as they appear in claude.ai's shipped chunks ----------
const SUPPORT_MODULE = [
  'function e7(){return!!(typeof window<"u"&&(window.AudioContext||window.webkitAudioContext))}',
  'function OE(){return typeof window>"u"?!1:typeof AudioEncoder<"u"&&typeof MediaStreamTrackProcessor<"u"}',
  'function dj(){return!!(typeof window<"u"&&window.MediaRecorder&&MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus"))}',
  'function Ay(){return!!(typeof window<"u"&&typeof navigator.mediaDevices?.getUserMedia=="function"&&(OE()||dj()))}',
  'function Lh(){if(typeof window>"u")return!1;let e=window.AudioContext||window.webkitAudioContext;return typeof navigator.mediaDevices?.getUserMedia=="function"&&!!e}',
  'function JX(){return Ay()&&e7()}',
  'export{Ay,JX,Lh};',
].join("");

const SESSION_MODULE = [
  'var T={sampleRate:16e3,channels:1,timeslice:40,audioBitsPerSecond:24e3,usePcm:!1,preferredBackend:"webcodecs",micMaxBufferFrames:0,publishMicAnalyser:!0};',
  'class Q{start(t){let{accountUuid:a,organizationUuid:l,voice:x,voiceConfig:ee,baseUrl:te,usePcm:ne=!1,preferredBackend:S="webcodecs",outputFormat:re="pcm",allowWorkletSink:ie=!0}=t;',
  'let e={inputEncoding:"opus",inputSampleRate:16e3,outputFormat:"pcm_16000",...ne?{inputEncoding:"linear16",inputSampleRate:16e3}:{}};',
  'return{usePcm:ne,backend:S,params:e}}}',
  'function recorderDefaults(){return T}',
  'export{Q,recorderDefaults};',
].join("");

// --- Load the transpiler (no window: it skips its fetch/animate patches) ----
const tctx = vm.createContext({ console, Set, Map, Promise, Math, JSON, Number, String, Object, Array, RegExp, Error });
vm.runInContext(transpilerSrc + "\n;globalThis.LegacyTranspiler = LegacyTranspiler;", tctx);
const LT = tctx.LegacyTranspiler;
LT.init({ BASE_URL: "https://assets.example/v1", target: { platform: "iOS", version: "16.3" }, runScript() {} });

const supportOut = LT.transpile("https://assets.example/v1/shared-m-2-test.js", SUPPORT_MODULE);
const sessionOut = LT.transpile("https://assets.example/v1/ccc-test.js", SESSION_MODULE);

// --- Load app-tweaks.js in a minimal fake page ------------------------------
const listeners = {};
const fakeDocument = {
  readyState: "loading",
  addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
};
const fakeWindow = { addEventListener() {}, history: { pushState() {}, replaceState() {} } };
const pageCtx = vm.createContext({
  window: fakeWindow, document: fakeDocument, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  navigator: { userAgent: "test", mediaDevices: { getUserMedia() {} } }, location: { origin: "https://claude.ai", pathname: "/new" },
  Date, Math, String, Array, Object, Error, RegExp, setTimeout, setInterval, clearInterval,
  performance, URL, URLSearchParams, screen: { width: 393, height: 852 },
});
vm.runInContext(tweaksSrc, pageCtx);
const patch = fakeWindow.__appPatchModule;
assert.strictEqual(typeof patch, "function", "app-tweaks.js must define window.__appPatchModule");

// --- Apply the patches to the transpiled code -------------------------------
const supportPatched = patch(supportOut, "shared-m-2-test.js");
const sessionPatched = patch(sessionOut, "ccc-test.js");

const show = (label, code, re) => { const m = code.match(re); console.log(label + ": " + (m ? m[0] : "(no match)")); };
show("support check, transpiled ", supportOut, /typeof navigator[^;]*?\)\)/);
show("support check, patched    ", supportPatched, /typeof navigator[^;]*?\)\)/);
show("voice default, transpiled ", sessionOut, /usePcm:\s*\w+\s*=\s*![01]/);
show("voice default, patched    ", sessionPatched, /usePcm:\s*\w+\s*=\s*![01]/);
assert.notStrictEqual(supportPatched, supportOut, "support check was not patched");
assert.notStrictEqual(sessionPatched, sessionOut, "usePcm default was not patched");
assert.ok(/usePcm:\s*!1/.test(sessionPatched), "the recorder's own default object must stay unchanged");

// Patching twice must be harmless (patterns no longer match).
assert.strictEqual(patch(supportPatched, "again"), supportPatched);
assert.strictEqual(patch(sessionPatched, "again"), sessionPatched);

// --- Execute the patched modules in a page like iOS 16 (no AudioEncoder, no webm/opus)
function run(code, src, extraGlobals) {
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, info() {}, error: console.error }, Promise, Set, Map, Math, JSON, Object, Array, Error, setTimeout, fetch: async () => ({}) }, extraGlobals));
  ctx.window = ctx;
  vm.runInContext(transpilerSrc + "\n;globalThis.LegacyTranspiler = LegacyTranspiler;", ctx);
  ctx.LegacyTranspiler.init({ BASE_URL: "https://assets.example/v1", target: { platform: "iOS", version: "16.3" }, runScript() {} });
  vm.runInContext(code, ctx);
  return new Promise((resolve) => setTimeout(() => resolve(ctx.LegacyTranspiler.getModuleExports(src)), 50));
}

const ios16 = {
  navigator: { mediaDevices: { getUserMedia() {} } },
  AudioContext: function () {},
  MediaRecorder: { isTypeSupported: (t) => t === "audio/mp4" },
};

(async () => {
  const before = await run(supportOut, "https://assets.example/v1/shared-m-2-test.js", ios16);
  const after = await run(supportPatched, "https://assets.example/v1/shared-m-2-test.js", ios16);
  const noMic = await run(supportPatched, "https://assets.example/v1/shared-m-2-test.js", Object.assign({}, ios16, { navigator: {} }));
  console.log("voice available on iOS 16, unpatched:", before.JX(), "| patched:", after.JX(), "| patched without mic API:", noMic.JX());
  assert.strictEqual(before.JX(), false);
  assert.strictEqual(after.JX(), true);
  assert.strictEqual(noMic.JX(), false, "must still require getUserMedia");

  const sBefore = await run(sessionOut, "https://assets.example/v1/ccc-test.js", ios16);
  const sAfter = await run(sessionPatched, "https://assets.example/v1/ccc-test.js", ios16);
  const r1 = new sBefore.Q().start({});
  const r2 = new sAfter.Q().start({});
  const r3 = new sAfter.Q().start({ usePcm: false });
  console.log("voice session, unpatched:", JSON.stringify(r1));
  console.log("voice session, patched:  ", JSON.stringify(r2));
  assert.strictEqual(r1.usePcm, false);
  assert.strictEqual(r2.usePcm, true);
  assert.strictEqual(r2.params.inputEncoding, "linear16");
  assert.strictEqual(r3.usePcm, false, "an explicit caller value must still win");
  assert.strictEqual(sAfter.recorderDefaults().usePcm, false);
  console.log("ALL PASS");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
