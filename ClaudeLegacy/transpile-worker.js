// Runs inside a background Worker, after legacy-transpiler.js (the app joins the
// two files into one script, see -workerSource in ViewController.m). Downloads a
// claude.ai module and transpiles it off the page's main thread.
"use strict";
self.onmessage = async function (event) {
  var message = event.data || {};
  if (message.type === "init") {
    LegacyTranspiler.init(Object.assign({ runScript: function () {} }, message.options));
    return;
  }
  if (message.type !== "job") return;
  try {
    var t0 = Date.now();
    var response = await fetch(message.src);
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + message.src);
    var source = await response.text();
    var t1 = Date.now();
    var code = LegacyTranspiler.transpile(message.src, source);
    self.postMessage({ id: message.id, code: code, fetchMs: t1 - t0, transpileMs: Date.now() - t1 });
  } catch (error) {
    self.postMessage({ id: message.id, error: String((error && error.message) || error) });
  }
};
