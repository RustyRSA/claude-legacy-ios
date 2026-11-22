"use strict";
// Transforms of the transpiler that the app changed (22 Nov 2026): a named class
// expression's static blocks keep seeing the class's own name, classes exported
// where they are declared lose their static blocks, and an arrow function whose
// body starts with an object pattern keeps its parentheses. Each output is run.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const repo = process.argv[2];
const src = fs.readFileSync(repo + "/ClaudeLegacy/legacy-transpiler.js", "utf8");
const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
vm.runInContext(src + "\n;globalThis.LT = LegacyTranspiler;", ctx);
ctx.LT.init({ BASE_URL: "https://x/v1", minify: true, target: { platform: "iOS", version: "16.3" }, runScript() {} });

// Runs transpiled code with a tiny module system; returns what it exported.
function run(code) {
  const out = ctx.LT.transpile("https://x/v1/m.js", code);
  assert.ok(!/static\s*\{/.test(out), "no static block left:\n" + out);
  let exported = null;
  const page = { window: null };
  page.window = page;
  page.LegacyTranspiler = {
    exportModule: (_src, values) => { exported = values; },
    importModule: () => Promise.resolve({}),
    onExportsUpdated: () => {},
    getModuleExports: () => ({})
  };
  vm.runInContext(out, vm.createContext(page));
  return new Promise((resolve) => setTimeout(() => resolve(exported), 20));
}

(async () => {
  // claude.ai's voice session (20 Nov update): `new class t { static { … t.X … } }`
  // with another `t` outside.
  const voice = await run('var t; var ys = new class t { static { this.A = 250 } static { this.B = 1e3 + 2 * t.A } b() { return t.B } }; ' +
    'var Q = class U { static { this.C = U.name } }; export { ys, Q };');
  assert.strictEqual(voice.ys.b(), 1500, "static block sees the class name");
  assert.strictEqual(voice.Q.C, "U");

  // A class exported where it is declared.
  const exp = await run('export class K { static { this.v = K.name + "!" } }');
  assert.strictEqual(exp.K.v, "K!");

  // An arrow function whose body is an assignment to an object pattern.
  const arrow = await run('let n = 0; const o = { offsetX: 7 }; const f = () => ({ offsetX: n } = o); f(); export { n };');
  assert.strictEqual(arrow.n, 7, "destructuring arrow body ran");

  console.log("TRANSFORMS PASS");
})().catch((e) => { console.error(e); process.exit(1); });
