(function () {
  const BASE_URL =
    "https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1";
//  const BASE_URL = window.location.href

  // Set by the app before this script runs (ViewController.m).
  const settings = window.__appSettings || {};
  const FAST = settings.fastLoad !== false;
  const MANIFEST_KEY = "__appModuleManifest";
  const HISTORY_KEY = "__appModuleHistory";
  // Set once the old web caches are gone (transpiled code now lives in the app).
  const MIGRATED_KEY = "__appStoreMigrated";

  const status = (payload) => {
    try {
      window.webkit.messageHandlers.loadingStatus.postMessage(payload);
    } catch (e) {}
  };

  const shortName = (src) => {
    const path = String(src || "").split("?")[0];
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  };

  const reportError = (message, fatal) => {
    status({ stage: "error", message: String(message), fatal: !!fatal });
  };

  status({ stage: "boot", mode: FAST ? "fast" : "classic" });

  // Anything thrown while the page is still loading is worth showing: at that
  // point a failure means a blank screen, not a glitch in an already-running app.
  window.addEventListener("error", (event) => {
    if (event && event.message) {
      const where = event.filename
        ? " (" + shortName(event.filename) + ":" + event.lineno + ")"
        : "";
      reportError(event.message + where, false);
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    if (reason) {
      reportError((reason && reason.message) || reason, false);
    }
  });

  if (!window.LegacyTranspiler || typeof window.LegacyTranspiler.init !== "function") {
    reportError(
      "legacy-transpiler.js did not load — check the Web Inspector console for a SyntaxError.",
      true
    );
    return;
  }
  const LT = window.LegacyTranspiler;

  // The page is considered loaded once module activity settles and something is painted.
  let readySent = false;
  let readyTimer = null;
  let readyAttempts = 0;

  const checkReady = () => {
    if (readySent) return;
    const painted =
      document.body && document.body.innerText.trim().length > 0;
    if (document.readyState === "complete" && painted) {
      readySent = true;
      status({ stage: "ready" });
      return;
    }
    // Claude paints well after the last module runs — around 15s in on a fast
    // device, considerably later on an old one. Poll briskly at first, then back
    // off, so the same number of (layout-forcing) innerText reads covers ~85s
    // instead of 30s and the native side is not left guessing.
    if (++readyAttempts > 100) return;
    readyTimer = setTimeout(checkReady, readyAttempts < 20 ? 300 : 1000);
  };

  const scheduleReadyCheck = () => {
    if (readySent) return;
    readyAttempts = 0;
    clearTimeout(readyTimer);
    readyTimer = setTimeout(checkReady, 800);
  };

  // ---- Running a module -----------------------------------------------------
  // Fast mode runs each module as an inline <script> carrying the page's own CSP
  // nonce: no round trip through the app, and errors keep their real message
  // and the module's file name (code run by the app only ever reports "Script
  // error."). If the page has no nonce or its policy refuses the script, the
  // module goes through the app instead, as in classic mode.
  let nonce = "";
  const takeNonce = (node) => {
    if (nonce || !node) return;
    const value = node.nonce || (node.getAttribute && node.getAttribute("nonce"));
    if (value) nonce = value;
  };
  const findNonce = () => {
    if (!nonce) {
      const scripts = document.getElementsByTagName("script");
      for (let i = 0; i < scripts.length && !nonce; i++) takeNonce(scripts[i]);
    }
    return nonce;
  };

  let inPage = FAST;
  let inlineRuns = 0;
  const STRICT = "'use strict';";

  const runInPage = (code, src) => {
    const value = findNonce();
    if (!value) return false;
    const id = ++inlineRuns;
    const marker = "window.__appInlineRan=" + id + ";";
    const body = (code.startsWith(STRICT)
      ? STRICT + marker + code.slice(STRICT.length)
      : marker + code) + "\n//# sourceURL=" + src;
    let failure = null;
    const onError = (event) => {
      if (window.__appInlineRan !== id) failure = event;
    };
    window.addEventListener("error", onError, true);
    const script = document.createElement("script");
    script.nonce = value;
    script.setAttribute("nonce", value);
    script.text = body;
    (document.head || document.documentElement).appendChild(script);
    window.removeEventListener("error", onError, true);
    script.remove();
    if (window.__appInlineRan === id) return true;
    if (failure) {
      // The module itself is broken (a syntax error this engine cannot parse).
      reportError(shortName(src) + ": " + (failure.message || "script error"), false);
      return true;
    }
    return false; // refused by the page's security policy
  };

  // A browser runs module scripts only once the page's HTML is parsed, and
  // claude.ai's entry expects that (it mounts into #root). Read from the app's
  // store, modules are ready well before that, so until then they wait here,
  // in order.
  const waitingForParse = [];
  const afterParse = (run) => {
    if (document.readyState !== "loading" && !waitingForParse.length) {
      run();
      return;
    }
    if (!waitingForParse.length) {
      const flush = () => {
        document.removeEventListener("DOMContentLoaded", flush);
        for (const queued of waitingForParse.splice(0)) queued();
      };
      document.addEventListener("DOMContentLoaded", flush);
      if (document.readyState !== "loading") setTimeout(flush, 0);
    }
    waitingForParse.push(run);
  };

  const runThroughApp = (code, src) => {
    window.webkit.messageHandlers.patchScript.postMessage({
      code: code,
      file: shortName(src),
    });
  };

  try {
    let manifest = [];
    let store = null;
    let migrate = false;
    if (FAST) {
      try {
        manifest = JSON.parse(localStorage.getItem(MANIFEST_KEY) || "[]");
        if (!Array.isArray(manifest)) manifest = [];
      } catch (e) {
        manifest = [];
      }
      // The app's module store (iOS 14 and later): files in the app's own
      // folder instead of claude.ai's web storage.
      const handlers = window.webkit && window.webkit.messageHandlers;
      if (handlers && handlers.moduleStore) {
        store = { call: (message) => handlers.moduleStore.postMessage(message) };
        try {
          localStorage.removeItem("__appModulePacks"); // round 7 build
          migrate = localStorage.getItem(MIGRATED_KEY) !== "1";
        } catch (e) {
          migrate = true;
        }
      }
    }

    LT.init({
      BASE_URL,
      fast: FAST,
      minify: FAST,
      manifest: manifest,
      store: store,
      migrate: migrate,
      workerSource: FAST ? window.__appWorkerSource : undefined,
      workerCount: 2,
      runScript: (code, src) => afterParse(() => {
        // app-tweaks.js: targeted fixes to claude.ai modules (voice mode on old iOS).
        if (typeof window.__appPatchModule === "function") {
          code = window.__appPatchModule(code, shortName(src));
        }
        let ran = false;
        if (inPage) {
          ran = runInPage(code, src);
          if (!ran) {
            inPage = false;
            status({ stage: "inline-refused", file: shortName(src) });
          }
        }
        if (ran) {
          status({ stage: "module", file: shortName(src) });
        } else {
          runThroughApp(code, src);
        }
        scheduleReadyCheck();
      }),
      target: {
        platform: 'iOS',
        version: iosVersion
      }
    });
    try {
      delete window.__appWorkerSource;
    } catch (e) {}
  } catch (e) {
    reportError("LegacyTranspiler.init failed: " + (e && e.message ? e.message : e), true);
    return;
  }

  window.__appLoader = {
    mode: FAST ? "fast" : "classic",
    inPage: () => inPage,
    inlineRuns: () => inlineRuns,
    hasNonce: () => !!findNonce(),
  };

  // ---- Remembering what this launch used --------------------------------------
  // The list lets the next launch read those modules from the cache in parallel,
  // and the last three launches' lists decide what stays in the cache.
  const sessionId = String(Date.now());
  const saveUsage = (prune) => {
    if (!FAST || typeof LT.usedModules !== "function") return;
    try {
      const used = LT.usedModules();
      if (!used.length) return;
      if (prune) localStorage.setItem(MANIFEST_KEY, JSON.stringify(used.slice(0, 800)));
      let history = [];
      try {
        history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      } catch (e) {}
      if (!Array.isArray(history)) history = [];
      history = history.filter((h) => h && h.id !== sessionId && Array.isArray(h.used));
      history.unshift({ id: sessionId, used: used.slice(0, 3000) });
      history = history.slice(0, 3);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      if (prune) {
        const keep = [];
        history.forEach((h) => keep.push.apply(keep, h.used));
        const cleared = LT.pruneCache(keep);
        LT.releaseUnused();
        if (cleared && typeof cleared.then === "function") {
          cleared.then(() => {
            try {
              localStorage.setItem(MIGRATED_KEY, "1");
            } catch (e) {}
          }).catch(() => {});
        }
      }
    } catch (e) {}
  };
  setTimeout(() => saveUsage(true), 45000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveUsage(false);
  });

  // ---- Entry scripts ----------------------------------------------------------
  // claude.ai's own entry (index-*.js) and any other module entry served from
  // its asset host, such as the artifact and document viewer (frame-shell-*.js).
  const isEntry = (node) =>
    node.src &&
    (node.src.includes("index") ||
      (node.type === "module" && node.src.indexOf(BASE_URL + "/") === 0));

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.tagName !== "SCRIPT") continue;
        takeNonce(node);
        if (isEntry(node)) {
          node.type = "javascript/blocked";
          const src = node.src;
          try {
            LT.loadCode(src)
          } catch (e) {
            // The entry chunk is blocked at this point, so failing here means
            // nothing will ever render.
            reportError(
              "Failed to transpile " + shortName(src) + ": " + (e && e.message ? e.message : e),
              true
            );
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
