"use strict";
// Counts brackets in Objective-C files outside comments and strings, so a typo
// shows before the CI build does. Same as balance.py, for PCs without Python.
const fs = require("fs");
function strip(src) {
  let out = "", i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (src.startsWith("//", i)) { const j = src.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (src.startsWith("/*", i)) { const j = src.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
let bad = 0;
for (const path of process.argv.slice(2)) {
  const s = strip(fs.readFileSync(path, "utf8"));
  const counts = ["{}", "()", "[]"].map(([o, c]) => {
    const a = s.split(o).length - 1, b = s.split(c).length - 1;
    if (a !== b) bad += 1;
    return o + c + " " + a + "/" + b;
  });
  console.log(path.split(/[\\/]/).slice(-2).join("/"), counts.join(" "));
}
if (bad) { console.log("BRACKETS UNBALANCED"); process.exit(1); }
