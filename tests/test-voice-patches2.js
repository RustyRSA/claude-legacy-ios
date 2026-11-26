"use strict";
// claude.ai's voice code since 23-26 Nov 2026 (no usePcm option): the app's two
// patches ask the server for linear16 and make the recorder record PCM. The
// excerpts are claude.ai's own code (ccc68ce7f-rlplIK8G.js), names unchanged.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const repo = process.argv[2];
const tweaks = fs.readFileSync(repo + "/ClaudeLegacy/app-tweaks.js", "utf8");

const page = { console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, performance: { now: () => 0 },
  setTimeout, clearTimeout, setInterval: () => 0, location: { href: "https://claude.ai/new", pathname: "/new", search: "" },
  navigator: {}, addEventListener() {}, document: { readyState: "complete", addEventListener() {}, querySelector() { return null }, querySelectorAll() { return [] }, documentElement: { appendChild() {} }, head: null, body: null },
  history: {}, URLSearchParams, Date, Math, JSON, Object, Array, String, RegExp, Error, Promise, Proxy, Reflect, Number, Set, Map };
page.window = page;
const ctx = vm.createContext(page);
try { vm.runInContext(tweaks, ctx); } catch (e) {}
assert.strictEqual(typeof page.__appPatchModule, "function", "app-tweaks loaded");

const session = 'class S{constructor(){this.unsentVoiceSettings={};this.voice="buttery"}' +
  'start(x,B,C){let e={...Cn,...x,...Jo(this.unsentVoiceSettings),voice:this.voice,clientAec:B,outputFormat:C==="opus"?"opus_48000_32":"pcm_16000"};' +
  'let r=new Qt({sampleRate:e.inputSampleRate,channels:e.inputChannels,preferredBackend:Jt()??"webcodecs",micMaxBufferFrames:0,onCaptureClockMismatch:e=>{}});' +
  'return{e,config:r.config}}}';
const prelude = 'var Cn={inputEncoding:"opus",inputSampleRate:16e3,inputChannels:1};function Jo(v){return v}function Jt(){return null}' +
  'class Qt{constructor(c){this.config=Object.assign({usePcm:!1},c)}}';

const patched = page.__appPatchModule(session, "ccc-test.js");
assert.notStrictEqual(patched, session, "patched");
assert.strictEqual(page.__appPatchModule(patched, "ccc-test.js"), patched, "patching twice changes nothing");
const run = (code) => vm.runInNewContext(prelude + code + ";new S().start({},true,\"pcm\")");
const before = run(session);
const after = run(patched);
assert.strictEqual(before.e.inputEncoding, "opus");
assert.strictEqual(before.config.usePcm, false);
assert.strictEqual(after.e.inputEncoding, "linear16", "server asked for linear16");
assert.strictEqual(after.e.inputSampleRate, 16000);
assert.strictEqual(after.config.usePcm, true, "recorder records PCM");
assert.strictEqual(after.e.clientAec, true);
assert.strictEqual(after.e.outputFormat, "pcm_16000");
console.log("VOICE2 PASS");
process.exit(0);
