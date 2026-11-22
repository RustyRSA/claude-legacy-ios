"use strict";
// Checks the app's transpiler against claude.ai's code as it is today: downloads
// claude.ai's whole module graph from its public asset host (about 5,400 files,
// 140 MB, kept in build/claude-modules/ for the next run), transpiles every
// module and checks the output for what iOS 16.3 cannot run: syntax errors,
// class static blocks and regular-expression lookbehind. Not part of run.sh
// (it downloads); run it after claude.ai updates, or when a module fails.
//
//   node tests/check-claude-modules.js index-XXXXXXXX.js
//
// The entry file name is in the app's debug log ("entry: index-….js" in the
// launch section), or in the <script> of claude.ai's login page in any browser.
// Needs: npm install in tests/ (acorn, acorn-walk).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const acorn = require("acorn");
const walk = require("acorn-walk");

const entry = process.argv[2];
if (!entry || !/^index-[\w-]+\.js$/.test(entry)) {
  console.error("usage: node tests/check-claude-modules.js index-XXXXXXXX.js");
  process.exit(2);
}
const repo = path.resolve(__dirname, "..");
const BASE = "https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/";
const dir = path.join(repo, "build", "claude-modules");
fs.mkdirSync(dir, { recursive: true });

// static imports, side-effect imports and dynamic imports of sibling files
const REF = /(?:from\s*|import\s*\(\s*|import\s*)["'](\.\/[\w.\-]+\.js)["']/g;

async function crawl() {
  const seen = new Set();
  const queue = [entry];
  let active = 0;
  let failed = 0;
  await new Promise((done) => {
    const next = () => {
      while (active < 12 && queue.length) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);
        active++;
        (async () => {
          const file = path.join(dir, name);
          let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
          for (let i = 0; i < 3 && !text; i++) {
            try {
              const r = await fetch(BASE + name);
              if (r.ok) text = await r.text();
              else if (r.status === 404) break;
            } catch (e) {}
          }
          if (!text) { failed++; return; }
          if (!fs.existsSync(file)) fs.writeFileSync(file, text);
          let m;
          REF.lastIndex = 0;
          while ((m = REF.exec(text))) {
            const n = m[1].slice(2);
            if (!seen.has(n)) queue.push(n);
          }
        })().finally(() => {
          active--;
          if (queue.length || active) next(); else done();
        });
      }
    };
    next();
  });
  return { names: [...seen].filter((n) => fs.existsSync(path.join(dir, n))), failed };
}

function transpiler() {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(path.join(repo, "ClaudeLegacy", "legacy-transpiler.js"), "utf8") +
    "\n;globalThis.LT = LegacyTranspiler;", ctx);
  ctx.LT.init({ BASE_URL: BASE.replace(/\/$/, ""), minify: true, target: { platform: "iOS", version: "16.3" }, runScript() {} });
  return ctx.LT;
}

(async () => {
  const t0 = Date.now();
  const { names, failed } = await crawl();
  console.log(names.length + " modules (" + failed + " could not be downloaded) in " + Math.round((Date.now() - t0) / 1000) + " s");
  const LT = transpiler();
  const problems = { "transpile error": [], "syntax error": [], "static block": [], lookbehind: [] };
  for (const name of names) {
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    let out;
    try {
      out = LT.transpile(BASE + name, src);
    } catch (e) {
      problems["transpile error"].push(name + ": " + e.message);
      continue;
    }
    try {
      new vm.Script(out, { filename: name });
    } catch (e) {
      problems["syntax error"].push(name + ": " + e.message);
      continue;
    }
    const ast = acorn.parse(out, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true });
    walk.full(ast, (node) => {
      if (node.type === "StaticBlock") problems["static block"].push(name);
      if (node.type === "Literal" && node.regex && /\(\?<[=!]/.test(node.regex.pattern)) {
        problems.lookbehind.push(name + " /" + node.regex.pattern.slice(0, 40) + "/");
      }
    });
  }
  let bad = 0;
  for (const kind of Object.keys(problems)) {
    const list = [...new Set(problems[kind])];
    bad += list.length;
    console.log(kind + ": " + list.length + (list.length ? "\n  " + list.slice(0, 20).join("\n  ") : ""));
  }
  console.log(bad ? "PROBLEMS FOUND" : "ALL MODULES OK");
  process.exit(bad ? 1 : 0);
})();
