// app-tweaks.js — injected at document start, before every other script.
//
// 1. App feel: no pinch or double-tap zoom, no grey tap flash, page size setting,
//    taps that are not swallowed by hover effects, selectable message text, and
//    the strips above and below the page (plus the status bar text) follow the
//    colours Claude draws at its top and bottom edges.
// 2. Voice mode on iOS versions that cannot record Opus: claude.ai's voice session
//    has an uncompressed recording mode (16 kHz PCM via ScriptProcessor); these
//    patches switch it on and let the voice button appear.
// 3. WebSocket addresses: iOS 16 only accepts ws:// and wss://, so https:// and
//    relative addresses (which newer browsers convert) are converted here; the
//    voice session needs this.
// 4. A small debug log, copied from the three-finger long-press menu: launch
//    timings, chat-opening timings, taps, sign-outs, background behaviour, and
//    how the voice and dictation connections went. Nothing secret is recorded.
(function () {
  "use strict";
  if (window.__appTweaksLoaded) return;
  window.__appTweaksLoaded = true;

  // Set by the app just before this script (ViewController.m -injectSettings).
  var settings = window.__appSettings || {};
  var TAP_FIX = settings.tapFix !== false;
  var PAGE_SCALE = Math.min(1.25, Math.max(1, Number(settings.pageScale) || 1));
  // Advanced > Diagnostics. Off: the measurements that cost time on every launch
  // and tap are skipped (page-watching work, frames after taps, long timers,
  // main-thread stalls, typing events, the IndexedDB probe). Errors, sign-outs,
  // API timings, taps without a click and the voice log are always kept.
  var DIAGNOSTICS = !!settings.diagnostics;

  // ---------------------------------------------------------------------------
  // Debug log
  // ---------------------------------------------------------------------------
  var MAX_LINES = 400;
  var scriptsStartAt = window.performance ? performance.now() : 0; // the app's scripts start here
  var lines = [];
  var startedAt = Date.now();
  var patchStatus = { supportCheck: "not seen yet", pcmMode: "not seen yet" };

  function record(kind, text) {
    lines.push(((Date.now() - startedAt) / 1000).toFixed(1) + "s " + kind + " " + text);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  }

  // ---------------------------------------------------------------------------
  // IndexedDB: no explicit commit
  // ---------------------------------------------------------------------------
  // On iOS 16.3, IDBTransaction.commit() as claude.ai calls it trips an
  // assertion in WebKit's IndexedDB server (UniqueIDBDatabaseTransaction::commit),
  // which takes down WebKit's whole networking process: every request in flight
  // fails ("Load failed"), IndexedDB is gone until a reload ("Connection to
  // Indexed Database server lost"), and claude.ai runs without its saved state
  // (crash reports, 5 Nov 2026: 15 of 15 the same). commit() only asks for what
  // happens anyway once a transaction has no requests left, so it does nothing here.
  var idbCommits = 0;
  try {
    if (window.IDBTransaction && typeof IDBTransaction.prototype.commit === "function") {
      IDBTransaction.prototype.commit = function () {
        idbCommits += 1;
      };
    }
  } catch (e) {}

  // Cheap descriptions only: the transpiler logs every module's exports, and
  // serialising those objects would slow every launch.
  function describe(value) {
    if (value === null || value === undefined) return String(value);
    var type = typeof value;
    if (type === "string") return value;
    if (type === "number" || type === "boolean") return String(value);
    if (value instanceof Error) return value.name + ": " + value.message;
    if (Array.isArray(value)) return "[Array(" + value.length + ")]";
    try {
      if (typeof value.message === "string") return (value.name || "Error") + ": " + value.message;
      var tag = Object.prototype.toString.call(value);
      return tag === "[object Object]" ? describeFields(value) : tag;
    } catch (e) {
      return "[object]";
    }
  }
  // A plain object (often an error wrapped by claude.ai): its field names, and
  // the values only of fields that describe an error, never other text.
  var ERROR_FIELDS = /^(name|message|code|type|reason|status|error)$/;
  function describeFields(value) {
    var keys = Object.keys(value).slice(0, 8);
    return "{" + keys.map(function (key) {
      var v = value[key];
      if (!ERROR_FIELDS.test(key)) return key;
      if (v && typeof v === "object" && typeof v.message === "string") return key + ": " + (v.name || "Error") + ": " + v.message;
      if (v && typeof v === "object" && v.target && v.target.error) return key + ": " + describe(v.target.error);
      if (typeof v === "string") return key + ": " + v.slice(0, 120);
      if (typeof v === "number" || typeof v === "boolean") return key + ": " + v;
      return key + ": " + Object.prototype.toString.call(v);
    }).join(", ") + "}";
  }

  function describeAll(args) {
    var parts = [];
    for (var i = 0; i < args.length && i < 6; i++) parts.push(describe(args[i]));
    var text = parts.join(" ");
    return text.length > 500 ? text.slice(0, 500) + "…" : text;
  }

  var NOISE = /^(\[(cache hit|cache miss|importModule|exportModule|evaluateJavaScript)\]|Datadog Browser SDK)/;
  var RELEVANT = /voice|audio|record|micro|\bmic\b|getUserMedia|websocket|speech|\bpcm\b|opus|permission|dictation/i;

  ["error", "warn", "info", "log", "debug"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      try {
        var first = arguments[0];
        // The transpiler logs every module three times over; passing those on
        // to the engine's console only costs time at launch.
        if (typeof first === "string" && NOISE.test(first)) return;
        var text = describeAll(arguments);
        if (level === "error" || level === "warn" || RELEVANT.test(text)) record(level, text);
      } catch (e) {}
      return original.apply(this, arguments);
    };
  });

  window.addEventListener("error", function (event) {
    record("uncaught", (event && event.message) || "error");
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    record("rejection", reason && reason.message ? reason.message : describe(reason));
  });

  // The app reports every audio-route notification; keep only the changes.
  var lastNative = "";
  window.__appLogNative = function (text) {
    text = String(text);
    if (text === lastNative) return;
    lastNative = text;
    record("native", text);
  };

  window.__appDebugLog = function () {
    var md = navigator.mediaDevices;
    var webmOpus = false;
    try {
      webmOpus = !!(window.MediaRecorder && MediaRecorder.isTypeSupported &&
        MediaRecorder.isTypeSupported("audio/webm;codecs=opus"));
    } catch (e) {}
    var header = [
      "page: " + location.origin + location.pathname,
      "userAgent: " + navigator.userAgent,
      "getUserMedia: " + (md && typeof md.getUserMedia === "function" ? "yes" : "no") +
        ", AudioContext: " + (window.AudioContext || window.webkitAudioContext ? "yes" : "no") +
        ", MediaRecorder webm/opus: " + (webmOpus ? "yes" : "no") +
        ", AudioEncoder: " + (typeof window.AudioEncoder !== "undefined" ? "yes" : "no"),
      "voice support check: " + patchStatus.supportCheck,
      "voice PCM mode: " + patchStatus.pcmMode,
      "settings: page size " + Math.round(PAGE_SCALE * 100) + "%, tap fix " + (TAP_FIX ? "on" : "off") +
        ", diagnostics " + (DIAGNOSTICS ? "on" : "off (turn on in Advanced for timings of taps, frames and stalls)") +
        ", loading " + (window.__appLoader ? window.__appLoader.mode +
          (window.__appLoader.mode === "fast" ? (window.__appLoader.inPage() ? " (in page)" : " (through the app)") : "") : "?")
    ].concat(chromeSummary(), launchSummary(), chatSummary(), tapSummary(), responsivenessSummary(), screenInventory(), ["----"]);
    return header.concat(lines).join("\n");
  };

  // Lines that must survive a reload or relaunch (sign-outs, launch times) also
  // go to the app's own event log.
  var appEventCount = 0;
  function appEvent(text) {
    record("event", text);
    if (++appEventCount > 40) return;
    try {
      window.webkit.messageHandlers.appEvent.postMessage(String(text).slice(0, 400));
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Voice mode on old iOS
  // ---------------------------------------------------------------------------
  // claude.ai shows the voice button only when the browser can record Opus
  // (WebCodecs AudioEncoder, or MediaRecorder with WebM/Opus); iOS 16 has neither.
  // Both patterns match on property names and code shape, not on minified names.
  //
  // Support check:  typeof navigator.mediaDevices?.getUserMedia == "function" && (A() || B())
  //            ->   typeof navigator.mediaDevices?.getUserMedia == "function" && (!0 || A() || B())
  var SUPPORT_CHECK = /(typeof\s+navigator\.mediaDevices\?\.getUserMedia\s*==\s*["']function["']\s*&&\s*\()(\s*[\w$]+\(\)\s*\|\|\s*[\w$]+\(\)\s*\))/;
  // Voice session default:  usePcm: x = !1, preferredBackend: ...
  //                    ->   usePcm: x = !0, preferredBackend: ...
  // With usePcm the session records through ScriptProcessor and tells the server
  // it is sending 16 kHz linear16 audio instead of Opus.
  var PCM_DEFAULT = /(usePcm\s*:\s*[\w$]+\s*=\s*)!1(\s*,\s*preferredBackend\s*:)/;

  window.__appPatchModule = function (code, file) {
    if (!appStarted) launch.firstModule = performance.now();
    appStarted = true;
    if (typeof code !== "string") return code;
    try {
      if (code.indexOf("getUserMedia") !== -1 && SUPPORT_CHECK.test(code)) {
        code = code.replace(SUPPORT_CHECK, "$1!0||$2");
        patchStatus.supportCheck = "patched (" + file + ")";
        record("app", "voice: support check patched in " + file);
      }
      if (code.indexOf("usePcm") !== -1 && PCM_DEFAULT.test(code)) {
        code = code.replace(PCM_DEFAULT, "$1!0$2");
        patchStatus.pcmMode = "enabled (" + file + ")";
        record("app", "voice: PCM recording mode enabled in " + file);
      }
    } catch (e) {
      record("app", "voice patch failed in " + file + ": " + describe(e));
    }
    return code;
  };

  // ---------------------------------------------------------------------------
  // Voice connection log
  // ---------------------------------------------------------------------------
  // Records what the voice and dictation sockets do: the transport and audio
  // format requested, how each socket closed, and any error frame the server
  // sent (the "can't be used" style message in voice mode is the server's own).
  // No credentials are logged: the ticket travels in the subprotocol, which is
  // never recorded, and ids in the path are shortened.
  var VOICE_SOCKET = /\/api\/ws\/(voice|speech_to_text|text_to_speech)\//;
  var LOGGED_PARAMS = ["input_encoding", "input_sample_rate", "output_format", "client_platform",
    "capabilities", "entry_source", "connect_reason"];
  var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  var ERROR_FRAME = /"(error|error_code|display_message|fatal)"|"type"\s*:\s*"[^"]*(error|fatal|refus|unavailable|reject)/i;

  function describeSocketURL(raw) {
    try {
      var url = new URL(String(raw), location.href);
      var params = [];
      LOGGED_PARAMS.forEach(function (key) {
        var value = url.searchParams.get(key);
        if (value !== null) params.push(key + "=" + value);
      });
      return url.pathname.replace(UUID, "…") + (params.length ? " [" + params.join(" ") + "]" : "");
    } catch (e) {
      return "(unreadable url)";
    }
  }

  function watchSocket(ws, label) {
    var startedAt = Date.now();
    var frames = 0;
    ws.addEventListener("open", function () {
      record("ws", label + " open after " + (Date.now() - startedAt) + "ms");
    });
    ws.addEventListener("error", function () {
      record("ws", label + " error event");
    });
    ws.addEventListener("close", function (event) {
      record("ws", label + " closed, code " + event.code +
        (event.reason ? ", reason " + JSON.stringify(String(event.reason).slice(0, 200)) : "") +
        (event.wasClean ? " (clean)" : ""));
    });
    ws.addEventListener("message", function (event) {
      if (typeof event.data !== "string" || frames >= 20 || !ERROR_FRAME.test(event.data)) return;
      frames++;
      record("ws", label + " frame " + event.data.slice(0, 600));
    });
  }

  // iOS 16's WebSocket accepts only absolute ws:// and wss:// addresses. The
  // current WebSocket standard (and newer browsers) also take https:// and
  // relative addresses and convert them, and claude.ai's voice session relies on
  // that: it dials https://claude.ai/api/ws/voice/..., which Safari 16 rejects
  // with a SyntaxError before connecting. Convert addresses the same way here.
  function toSocketURL(raw) {
    try {
      var href = new URL(String(raw), location.href).href.replace(/#.*$/, "");
      if (/^https:/i.test(href)) return href.replace(/^https:/i, "wss:");
      if (/^http:/i.test(href)) return href.replace(/^http:/i, "ws:");
      return /^wss?:/i.test(href) ? href : raw;
    } catch (e) {
      return raw;
    }
  }

  if (typeof window.WebSocket === "function" && typeof Proxy === "function") {
    var socketCount = 0;
    window.WebSocket = new Proxy(window.WebSocket, {
      construct: function (Target, args, newTarget) {
        var list = Array.prototype.slice.call(args);
        var original = list.length ? String(list[0]) : "";
        if (list.length) list[0] = toSocketURL(list[0]);
        var converted = list.length > 0 && !/^wss?:/i.test(original) && /^wss?:/i.test(String(list[0]));
        var voice = VOICE_SOCKET.test(original);
        var label = voice ? "#" + (++socketCount) : "";
        if (voice) {
          record("ws", label + " connect " + describeSocketURL(list[0]) +
            (converted ? " (address converted to " + String(list[0]).split(":")[0] + ")" : ""));
        }
        var ws;
        try {
          ws = Reflect.construct(Target, list, newTarget);
        } catch (e) {
          if (voice) record("ws", label + " could not be created: " + describe(e));
          throw e;
        }
        if (voice) {
          try {
            watchSocket(ws, label);
            openSockets.push(ws);
            if (openSockets.length > 8) openSockets.shift();
          } catch (e) {}
        }
        return ws;
      }
    });
  }

  // Voice mode can also carry audio over WebRTC; log how those connections go.
  if (typeof window.RTCPeerConnection === "function" && typeof Proxy === "function") {
    var peerCount = 0;
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct: function (Target, args, newTarget) {
        var pc = Reflect.construct(Target, args, newTarget);
        try {
          var label = "rtc#" + (++peerCount);
          record("rtc", label + " created");
          pc.addEventListener("connectionstatechange", function () {
            record("rtc", label + " connection " + pc.connectionState);
          });
          pc.addEventListener("iceconnectionstatechange", function () {
            record("rtc", label + " ice " + pc.iceConnectionState);
          });
        } catch (e) {}
        return pc;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // App feel
  // ---------------------------------------------------------------------------
  // Page size: everything (buttons, text, spacing) is drawn PAGE_SCALE times
  // larger by giving the page a narrower layout width and zooming it to fit, so
  // claude.ai keeps its own mobile layout and style, only bigger. Nothing here
  // depends on claude.ai's class names.
  var viewWidth = 0;
  function currentViewWidth() {
    var vv = window.visualViewport;
    var w = vv && vv.width && vv.scale ? Math.round(vv.width * vv.scale) : 0;
    return w || Math.min(screen.width, screen.height) || 390;
  }
  function viewportContent(original) {
    var parts = String(original || "width=device-width, initial-scale=1, viewport-fit=cover")
      .split(",").map(function (s) { return s.trim(); }).filter(function (s) {
        return s && !/^(width|initial-scale|maximum-scale|minimum-scale|user-scalable)\s*=/i.test(s);
      });
    if (PAGE_SCALE > 1.001) {
      if (!viewWidth) viewWidth = currentViewWidth();
      var scale = PAGE_SCALE.toFixed(3);
      parts.unshift("width=" + Math.round(viewWidth / PAGE_SCALE), "initial-scale=" + scale,
        "minimum-scale=" + scale, "maximum-scale=" + scale);
    } else {
      parts.unshift("width=device-width", "initial-scale=1", "maximum-scale=1");
    }
    parts.push("user-scalable=no");
    return parts.join(", ");
  }
  function lockViewport() {
    var head = document.head;
    if (!head) return;
    var metas = head.querySelectorAll('meta[name="viewport"]');
    if (!metas.length) {
      var meta = document.createElement("meta");
      meta.name = "viewport";
      meta.setAttribute("data-app", viewportContent(""));
      meta.content = meta.getAttribute("data-app");
      head.appendChild(meta);
      return;
    }
    for (var i = 0; i < metas.length; i++) {
      var content = metas[i].getAttribute("content") || "";
      if (content === metas[i].getAttribute("data-app")) continue; // already ours
      var next = viewportContent(metas[i].getAttribute("data-original") || content);
      if (!metas[i].hasAttribute("data-original")) metas[i].setAttribute("data-original", content);
      metas[i].setAttribute("data-app", next);
      metas[i].setAttribute("content", next);
    }
  }
  // Rotating the phone changes the width the page has to fill.
  window.addEventListener("orientationchange", function () {
    if (PAGE_SCALE <= 1.001) return;
    setTimeout(function () {
      var metas = document.querySelectorAll('meta[name="viewport"]');
      viewWidth = Math.round((window.orientation === 90 || window.orientation === -90)
        ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height));
      for (var i = 0; i < metas.length; i++) metas[i].removeAttribute("data-app");
      lockViewport();
    }, 300);
  });

  // Message bubbles and replies (class names as of October 2026; if claude.ai
  // renames them this rule simply stops matching).
  var MESSAGE_TEXT = [".font-claude-response", ".font-user-message", '[data-testid="user-message"]']
    .map(function (sel) { return sel + "," + sel + " *"; }).join(",");

  function addStyle() {
    if (document.getElementById("app-tweaks-style")) return;
    var style = document.createElement("style");
    style.id = "app-tweaks-style";
    style.textContent =
      // No grey flash on tap. Links keep the normal long-press menu (Open, Copy,
      // Share) and message text can be selected and copied, as in other apps.
      "*{-webkit-tap-highlight-color:transparent!important}" +
      MESSAGE_TEXT + "{-webkit-user-select:text!important;user-select:text!important;" +
        "-webkit-touch-callout:default!important}" +
      "a[href]{-webkit-touch-callout:default!important}" +
      // Taps fire immediately: no waiting to see whether a double tap follows.
      "html{touch-action:manipulation}" +
      // The page itself never rubber-bands.
      "html,body{overscroll-behavior:none}";
    (document.head || document.documentElement).appendChild(style);
  }

  // The message box sits inside the same scroll area as the messages, so pulling
  // past the end of a chat dragged it along. Stop that scroll area (and any
  // other scroll area holding the message box) from rubber-banding.
  var COMPOSER = 'div[contenteditable="true"], textarea, [data-testid="chat-input"]';
  var lastComposerCheck = 0;
  function pinComposer() {
    var now = Date.now();
    if (now - lastComposerCheck < 1000) return;
    lastComposerCheck = now;
    var editors = document.querySelectorAll(COMPOSER);
    var composer = null;
    var lowest = -Infinity;
    for (var i = 0; i < editors.length; i++) {
      var rect = editors[i].getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > lowest) {
        lowest = rect.bottom;
        composer = editors[i];
      }
    }
    for (var el = composer && composer.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      if (el.__appPinned) continue;
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        el.style.setProperty("overscroll-behavior-y", "none");
        el.__appPinned = true;
      }
    }
  }

  // Colours ------------------------------------------------------------------
  function parseRGB(value) {
    var m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,\/]+([\d.]+%?))?\s*\)/.exec(value || "");
    if (!m) return null;
    var alpha = 1;
    if (m[4] !== undefined) alpha = m[4].slice(-1) === "%" ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a: alpha };
  }

  // Computed colours can come back as lab()/oklch()/color(); a 1x1 canvas turns
  // anything the engine understands into plain RGB.
  var probe = null;
  var SENTINEL = "#010203";
  function toRGB(cssColour) {
    var direct = parseRGB(cssColour);
    if (direct) return direct;
    try {
      probe = probe || document.createElement("canvas");
      probe.width = 1;
      probe.height = 1;
      var ctx = probe.getContext("2d");
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = cssColour;
      if (String(ctx.fillStyle).toLowerCase() === SENTINEL) return null; // not a colour
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) {
      return null;
    }
  }

  // The colour actually on screen at (x, y): every element stacked at that
  // point, front to back, blended until an opaque one. A dimming overlay over
  // the page therefore reads as the dimmed page, not as whatever lies below it.
  function colourAt(x, y) {
    var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
    var r = 0, g = 0, b = 0, left = 1;
    for (var i = 0; i < stack.length && left > 0.01; i++) {
      var el = stack[i];
      if (!el || el.nodeType !== 1) continue;
      var c = toRGB(getComputedStyle(el).backgroundColor);
      if (!c || c.a <= 0) continue;
      var a = Math.min(1, c.a);
      r += c.r * a * left;
      g += c.g * a * left;
      b += c.b * a * left;
      left *= 1 - a;
    }
    if (left > 0.5) return null; // mostly see-through: nothing to match
    var scale = 1 / (1 - left);
    return { r: Math.round(r * scale), g: Math.round(g * scale), b: Math.round(b * scale) };
  }

  // Samples just inside the page's top and bottom edges, near the left side so
  // centred controls (the message box) do not decide the colour.
  var lastReported = "";
  var candidate = "";
  var confirmTimer = null;
  function reportAppearance() {
    if (!document.body) return;
    var report = null;
    try {
      var height = document.documentElement.clientHeight || window.innerHeight;
      var top = colourAt(4, 1);
      var bottom = colourAt(4, Math.max(1, height - 2)) || top;
      if (top) report = { top: top, bottom: bottom };
    } catch (e) {
      return;
    }
    if (!report) return;
    var key = JSON.stringify(report);
    if (key === lastReported) {
      candidate = "";
      return;
    }
    // A colour seen once may be one frame of an animation (the sidebar sliding
    // away, one chat replaced by the next), which made the edges flash. It is
    // passed on only when a second look a moment later sees the same.
    if (key !== candidate) {
      candidate = key;
      clearTimeout(confirmTimer);
      confirmTimer = (nativeSetTimeout || setTimeout)(reportAppearance, 120);
      return;
    }
    candidate = "";
    lastReported = key;
    try {
      window.webkit.messageHandlers.appearance.postMessage(report);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Responsiveness measurements (shown at the top of the debug log)
  // ---------------------------------------------------------------------------
  var NativeObserver = window.MutationObserver;
  var appStarted = false; // set when the first claude.ai module runs
  var domReady = false;   // set once the document (and the polyfills' end-of-document scripts) are in
  var observerCost = { early: { calls: 0, ms: 0, worst: 0 }, app: { calls: 0, ms: 0, worst: 0 } };
  var tapReactions = [];
  var longFrames = { count: 0, worst: 0, frames: 0 };

  // Times every MutationObserver callback. Observers created before claude.ai's
  // own code starts belong to the compatibility polyfills; later ones to the app.
  if (DIAGNOSTICS && typeof NativeObserver === "function" && typeof Proxy === "function" && window.performance) {
    window.MutationObserver = new Proxy(NativeObserver, {
      construct: function (Target, args, newTarget) {
        var callback = args[0];
        var bucket = appStarted && domReady ? observerCost.app : observerCost.early;
        if (typeof callback === "function") {
          args = [function () {
            var t = performance.now();
            try {
              return callback.apply(this, arguments);
            } finally {
              var spent = performance.now() - t;
              bucket.calls++;
              bucket.ms += spent;
              if (spent > bucket.worst) bucket.worst = spent;
            }
          }].concat(Array.prototype.slice.call(args, 1));
        }
        return Reflect.construct(Target, args, newTarget);
      }
    });
  }

  // After each tap: how long until the page changes anything, and whether any
  // frame in the next 1.2 s took longer than 50 ms.
  function measureTap() {
    var tappedAt = performance.now();
    if (typeof NativeObserver === "function") {
      var done = false;
      var watcher = new NativeObserver(function () {
        if (done) return;
        done = true;
        watcher.disconnect();
        tapReactions.push(performance.now() - tappedAt);
        if (tapReactions.length > 40) tapReactions.shift();
      });
      watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      setTimeout(function () {
        if (!done) { done = true; watcher.disconnect(); }
      }, 1000);
    }
    watchFrames();
  }

  // One frame watcher at a time; each tap extends it to 1.2 s after that tap.
  var frameWatchUntil = 0;
  var frameWatchRunning = false;
  function watchFrames() {
    frameWatchUntil = performance.now() + 1200;
    if (frameWatchRunning) return;
    frameWatchRunning = true;
    var last = performance.now();
    var frame = function (now) {
      var gap = now - last;
      last = now;
      longFrames.frames++;
      if (gap > 50) longFrames.count++;
      if (gap > longFrames.worst) longFrames.worst = gap;
      if (now < frameWatchUntil) window.requestAnimationFrame(frame);
      else frameWatchRunning = false;
    };
    window.requestAnimationFrame(frame);
  }

  function round(n) { return Math.round(n); }
  function responsivenessSummary() {
    if (!DIAGNOSTICS) return ["IndexedDB commit() calls skipped: " + idbCommits];
    var sorted = tapReactions.slice().sort(function (a, b) { return a - b; });
    var median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    var worst = sorted.length ? sorted[sorted.length - 1] : 0;
    return [
      "taps measured: " + sorted.length + ", page reacts after median " + round(median) + " ms (worst " + round(worst) + " ms)",
      "frames after taps: " + longFrames.frames + ", over 50 ms: " + longFrames.count + " (worst " + round(longFrames.worst) + " ms)",
      "page-watching work: polyfills " + round(observerCost.early.ms) + " ms in " + observerCost.early.calls +
        " calls (worst " + round(observerCost.early.worst) + " ms), claude.ai " + round(observerCost.app.ms) + " ms in " +
        observerCost.app.calls + " calls (worst " + round(observerCost.app.worst) + " ms)",
      "IndexedDB commit() calls skipped: " + idbCommits
    ];
  }

  // ---------------------------------------------------------------------------
  // Taps and chat switching
  // ---------------------------------------------------------------------------
  // iOS WebKit sends a tap as touch events followed by pretend mouse events
  // (mouseover, mousemove, ...) and only then a click. If the page reacts to the
  // pretend mouseover by showing something (claude.ai's chat list reveals a
  // menu button on hover), WebKit treats the tap as "hover only" and never sends
  // the click: the tap does nothing and a second tap is needed. With the tap fix
  // on, those pretend mouse events are kept away from the page for one second
  // after a touch. Clicks, pointer and touch events are untouched.
  var lastTouchAt = 0;
  var hoverEventsHeld = 0;
  var MOUSE_ECHO = ["mouseover", "mouseenter", "mousemove", "mouseout", "mouseleave"];
  document.addEventListener("touchstart", function () { lastTouchAt = Date.now(); }, { capture: true, passive: true });
  document.addEventListener("touchend", function () { lastTouchAt = Date.now(); }, { capture: true, passive: true });
  if (TAP_FIX) {
    MOUSE_ECHO.forEach(function (type) {
      window.addEventListener(type, function (event) {
        if (Date.now() - lastTouchAt < 1000) {
          event.stopImmediatePropagation();
          hoverEventsHeld++;
        }
      }, true);
    });
  }

  function describeTarget(el) {
    if (!el || el.nodeType !== 1) return "?";
    var link = el.closest ? el.closest("a[href], button, [role='button'], [role='menuitem'], [role='option']") : null;
    var node = link || el;
    var label = node.getAttribute("aria-label") || node.getAttribute("data-testid") || "";
    var href = node.getAttribute("href") || "";
    if (href) href = href.replace(UUID, "…").split("?")[0];
    var text = (node.textContent || "").trim().slice(0, 1) ? "text" : "no text";
    return node.tagName.toLowerCase() + (label ? " '" + label.slice(0, 40) + "'" : "") +
      (href ? " " + href : "") + (label || href ? "" : " (" + text + ")");
  }

  // A tap is a short touch that does not move. Each one should produce a click.
  var tapStats = { taps: 0, clicked: 0, missed: 0, chatTaps: 0, chatMissed: 0, recentMisses: [] };
  var touch = null;
  var pendingTap = null;
  document.addEventListener("touchstart", function (event) {
    var t = event.touches && event.touches[0];
    if (!t || event.touches.length > 1) { touch = null; return; }
    touch = { x: t.clientX, y: t.clientY, at: Date.now(), target: event.target, moved: false };
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", function (event) {
    var t = event.touches && event.touches[0];
    if (touch && t && (Math.abs(t.clientX - touch.x) > 10 || Math.abs(t.clientY - touch.y) > 10)) touch.moved = true;
  }, { capture: true, passive: true });
  document.addEventListener("touchend", function () {
    var t = touch;
    touch = null;
    if (!t || t.moved) return;
    var held = Date.now() - t.at;
    if (held >= 450) {
      noteLongPress(t.target, held);
      return;
    }
    var chatLink = t.target && t.target.closest ? t.target.closest('a[href*="/chat/"]') : null;
    var tap = { target: t.target, chat: !!chatLink, href: chatLink ? chatLink.getAttribute("href") : "", at: performance.now() };
    tapStats.taps++;
    if (tap.chat) tapStats.chatTaps++;
    pendingTap = tap;
    setTimeout(function () {
      if (pendingTap !== tap) return;
      pendingTap = null;
      tapStats.missed++;
      if (tap.chat) tapStats.chatMissed++;
      var what = describeTarget(tap.target);
      tapStats.recentMisses.push(what);
      if (tapStats.recentMisses.length > 8) tapStats.recentMisses.shift();
      record("tap", "no click followed a tap on " + what);
    }, 800);
  }, { capture: true, passive: true });
  document.addEventListener("click", function (event) {
    if (!pendingTap) return;
    var tap = pendingTap;
    pendingTap = null;
    tapStats.clicked++;
    if (tap.chat) startChatOpen(tap.href, tap.at);
  }, true);

  function tapSummary() {
    return [
      "taps: " + tapStats.taps + ", clicked " + tapStats.clicked + ", no click " + tapStats.missed +
        " (chat list: " + tapStats.chatTaps + " taps, " + tapStats.chatMissed + " without a click)" +
        (TAP_FIX ? ", hover events held back " + hoverEventsHeld : ", tap fix off"),
    ].concat(tapStats.recentMisses.length ? ["  taps without a click: " + tapStats.recentMisses.join("; ")] : []);
  }

  // Long presses: what the page allows there (selection and the link menu).
  var longPresses = 0;
  function noteLongPress(target, held) {
    if (++longPresses > 12 || !target || target.nodeType !== 1) return;
    var style = getComputedStyle(target);
    setTimeout(function () {
      var selected = 0;
      try { selected = String(window.getSelection() || "").length; } catch (e) {}
      record("press", "long press " + held + " ms on " + describeTarget(target) +
        ": select " + (style.webkitUserSelect || style.userSelect || "?") +
        ", callout " + (style.webkitTouchCallout || "?") + ", selected " + selected + " chars");
    }, 400);
  }

  // Opening a chat from the list: tap -> address changes -> the conversation's
  // data arrives -> the screen stops changing.
  var chatOpens = [];
  var chatOpen = null;
  var lastMutationAt = 0;
  function startChatOpen(href, tappedAt) {
    chatOpen = { href: href, at: tappedAt || performance.now(), routeAt: 0, dataAt: 0, apiMs: 0, settledAt: 0 };
    var current = chatOpen;
    var check = function () {
      if (chatOpen !== current) return;
      var now = performance.now();
      if (current.dataAt && now - lastMutationAt > 400) {
        current.settledAt = Math.max(lastMutationAt, current.dataAt);
        finishChatOpen(current);
        return;
      }
      if (now - current.at > 10000) {
        finishChatOpen(current);
        return;
      }
      setTimeout(check, 100);
    };
    setTimeout(check, 100);
  }
  function finishChatOpen(c) {
    if (chatOpen === c) chatOpen = null;
    var part = function (label, at) { return at ? label + " +" + Math.round(at - c.at) + " ms" : label + " (not seen)"; };
    var line = [part("address", c.routeAt), part("data", c.dataAt) + (c.apiMs ? " (request " + Math.round(c.apiMs) + " ms)" : ""),
      part("screen settled", c.settledAt)].join(", ") + chatOpenWork(c);
    chatOpens.push(line);
    if (chatOpens.length > 8) chatOpens.shift();
    record("chat", "opened a chat: " + line);
  }
  // What kept the page busy between the tap and the chat's data: modules
  // claude.ai loaded for it (and how long the slowest waited for its code) and
  // main-thread stalls.
  function chatOpenWork(c) {
    var end = c.dataAt || c.settledAt || performance.now();
    var info = loaderStats();
    var mods = info ? info.modules.filter(function (m) { return m.requestedAt >= c.at && m.requestedAt <= end; }) : [];
    var transpiled = 0, longestWait = 0;
    mods.forEach(function (m) {
      if (m.how === "worker" || m.how === "main") transpiled++;
      if (m.codeAt && m.codeAt - m.requestedAt > longestWait) longestWait = m.codeAt - m.requestedAt;
    });
    var blocked = 0;
    stalls.forEach(function (g) { if (g.at >= c.at && g.at <= end) blocked += g.ms; });
    return "; before the data: " + mods.length + " modules (" + transpiled + " transpiled, slowest waited " +
      Math.round(longestWait) + " ms), main thread blocked " + Math.round(blocked) + " ms";
  }
  function chatSummary() {
    return chatOpens.length ? ["chat opens (latest last):"].concat(chatOpens.map(function (l) { return "  " + l; })) : [];
  }

  ["pushState", "replaceState"].forEach(function (name) {
    var original = window.history && window.history[name];
    if (typeof original !== "function") return;
    window.history[name] = function () {
      var result = original.apply(this, arguments);
      try { onRoute(); } catch (e) {}
      return result;
    };
  });
  window.addEventListener("popstate", function () { try { onRoute(); } catch (e) {} });
  var lastPath = location.pathname;
  function onRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (chatOpen && !chatOpen.routeAt) chatOpen.routeAt = performance.now();
    checkSignedOut();
  }

  // ---------------------------------------------------------------------------
  // Network: API timings at launch and when opening chats, sign-in failures
  // ---------------------------------------------------------------------------
  var apiAtLaunch = [];
  var authFailures = 0;
  function apiPath(url) {
    try {
      var u = new URL(url, location.href);
      if (u.hostname !== location.hostname) return "";
      return u.pathname.indexOf("/api/") === 0 ? u.pathname.replace(UUID, "…") : "";
    } catch (e) {
      return "";
    }
  }
  function noteApi(path, method, startedAt, status, response, url) {
    var now = performance.now();
    var ms = now - startedAt;
    if (startedAt < 60000 && apiAtLaunch.length < 40) {
      apiAtLaunch.push({ path: path, method: method, at: startedAt, ms: ms, status: status });
    }
    if (chatOpen && !chatOpen.dataAt && method === "GET" && /\/chat_conversations(_v\d+)?\/…/.test(path) &&
        String(url).indexOf(String(chatOpen.href).split("/").pop()) !== -1) {
      chatOpen.dataAt = now;
      chatOpen.apiMs = ms;
    }
    if ((status === 401 || status === 403) && response && authFailures < 10) {
      authFailures++;
      response.clone().text().then(function (body) {
        var kind = "";
        try {
          var json = JSON.parse(body);
          var err = json && (json.error || json);
          kind = [err.type, err.error_code, err.details && err.details.error_code].filter(Boolean).join("/");
        } catch (e) {}
        appEvent("api " + status + " " + method + " " + path + (kind ? " (" + String(kind).slice(0, 80) + ")" : ""));
      }, function () {
        appEvent("api " + status + " " + method + " " + path);
      });
    }
  }
  // Requests that fail without an answer ("Load failed"): whether the page
  // cancelled them, and how busy the bridge to the app's module store was.
  var failedRequests = 0;
  function noteFailedRequest(path, method, startedAt, error, init) {
    if (++failedRequests > 12) return;
    var aborted = !!(init && init.signal && init.signal.aborted);
    var store = loaderStats();
    var s = store ? store.stats : {};
    record("net", method + " " + path.replace(/^\/api\//, "") + " failed after " + Math.round(performance.now() - startedAt) +
      " ms: " + describe(error) + (aborted ? ", cancelled by the page" : "") +
      (document.visibilityState === "hidden" ? ", page hidden" : "") +
      ", store requests open " + (s.storeInFlight || 0) + ", batches read " + (s.batchesRead || 0) + "/" + (s.batches || 0));
  }

  // The app's native chat list: when claude.ai fetches its own list of chats,
  // their ids, names and times are handed to the app (kept on the phone, shown
  // from the chat list button). No request of the app's own is made, and names
  // never go to the debug log.
  var CHAT_LIST_PATH = /^\/api\/organizations\/…\/chat_conversations(_v\d+)?$/;
  var CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var chatListPosts = 0;
  var chatListCount = 0;
  function chatItems(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === "object") {
      for (var key in json) {
        var list = json[key];
        if (Array.isArray(list) && list.length && list[0] && typeof (list[0].uuid || list[0].id) === "string") return list;
      }
    }
    return [];
  }
  function postChats(chats, source) {
    if (!chats.length) return;
    chatListPosts++;
    chatListCount += chats.length;
    if (chatListPosts <= 6) record("chrome", "chat list: " + chats.length + " chats from " + source);
    try {
      window.webkit.messageHandlers.chatList.postMessage({ chats: chats });
    } catch (e) {}
  }
  var chatFieldsNoted = false;
  function noteChatList(json) {
    var chats = [];
    var first = chatItems(json)[0];
    if (first && !chatFieldsNoted) {
      // Field names only (never values): what claude.ai's list offers.
      chatFieldsNoted = true;
      record("chrome", "chat list item fields: " + Object.keys(first).slice(0, 40).join(", "));
    }
    nativeSetTimeout(chatGroupsFromPage, 1500);
    chatItems(json).forEach(function (item) {
      var id = item && String(item.uuid || item.id || "");
      if (!id || !CHAT_ID.test(id) || chats.length >= 300) return;
      var updated = Date.parse(item.updated_at || item.created_at || "");
      chats.push({ id: id, name: String(item.name || item.title || "").slice(0, 200), updated: updated > 0 ? updated : 0 });
    });
    postChats(chats, "claude.ai's list");
  }
  // The sections of claude.ai's sidebar (Starred, your own groups, Recents) with
  // the chats under each, read from what claude.ai drew there: section headings
  // are its small text buttons (under 31 px tall, no label), chats are its
  // links. Sent only when it changed. If claude.ai changes that layout the
  // app's list simply has no sections.
  var groupsSent = "";
  function chatGroupsFromPage() {
    var aside = find("aside");
    if (!aside) return;
    var nodes = aside.querySelectorAll('button, a[href^="/chat/"]');
    var groups = [];
    var heading = "";
    var current = null;
    var count = 0;
    for (var i = 0; i < nodes.length && count < 300 && groups.length < 40; i++) {
      var el = nodes[i];
      var text = String(el.textContent || "").trim();
      if (el.tagName === "A") {
        var id = String(el.getAttribute("href")).slice(6).split(/[?#/]/)[0];
        if (!CHAT_ID.test(id)) continue;
        if (!current) {
          current = { name: heading.slice(0, 60), chats: [] };
          groups.push(current);
        }
        current.chats.push({ id: id, name: text.slice(0, 200) });
        count++;
      } else if (text && text.length <= 60 && !el.getAttribute("aria-label") && !el.getAttribute("data-testid")) {
        var height = el.getBoundingClientRect().height;
        if (height > 0 && height < 31) {
          heading = text;
          current = null;
        }
      }
    }
    if (!count) return;
    var key = JSON.stringify(groups);
    if (key === groupsSent) return;
    groupsSent = key;
    record("chrome", "chat list: " + groups.length + " sections with " + count + " chats from the sidebar");
    try {
      window.webkit.messageHandlers.chatList.postMessage({ groups: groups });
    } catch (e) {}
  }
  // When no list was seen (claude.ai changed its address or shape): the chat
  // links claude.ai drew in its sidebar, without times.
  function chatsFromPage() {
    if (chatListPosts) return;
    var seen = {};
    var chats = [];
    var links = document.querySelectorAll('aside a[href^="/chat/"]');
    for (var i = 0; i < links.length && chats.length < 300; i++) {
      var id = String(links[i].getAttribute("href")).slice(6).split(/[?#/]/)[0];
      if (!CHAT_ID.test(id) || seen[id]) continue;
      seen[id] = true;
      chats.push({ id: id, name: String(links[i].textContent || "").trim().slice(0, 200), updated: 0 });
    }
    postChats(chats, "the page's links");
  }

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input || "");
      var path = apiPath(url);
      var promise = nativeFetch.apply(this, arguments);
      if (path) {
        var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        var startedAt = performance.now();
        promise.then(function (response) {
          noteApi(path, method, startedAt, response.status, response, url);
          if (NATIVE_CHROME && method === "GET" && response.status === 200 && CHAT_LIST_PATH.test(path)) {
            response.clone().json().then(noteChatList, function () {});
          }
        }, function (error) {
          noteApi(path, method, startedAt, "failed", null, url);
          noteFailedRequest(path, method, startedAt, error, init);
        });
      }
      return promise;
    };
  }

  // Signed out: claude.ai sends an involuntary sign-out to /logout?involuntary=1
  // and then /login?from=logout&reauth=1. The app's event log keeps the time
  // and, from the API lines above, which request was refused.
  var signedOutNoted = false;
  function checkSignedOut() {
    var path = location.pathname;
    var params = new URLSearchParams(location.search);
    var out = path === "/logout" || (path.indexOf("/login") === 0 && params.get("from") === "logout");
    if (!out || signedOutNoted) return;
    signedOutNoted = true;
    var detail = ["involuntary", "reauth", "reauth_reason"].filter(function (k) { return params.has(k); })
      .map(function (k) { return k + "=" + String(params.get(k)).slice(0, 30); }).join(" ");
    appEvent("signed out: " + path + (detail ? " (" + detail + ")" : ""));
  }
  checkSignedOut();

  // ---------------------------------------------------------------------------
  // Launch timeline
  // ---------------------------------------------------------------------------
  var launch = { dom: 0, firstModule: 0, interactive: 0, sendButton: 0, reported: false };
  // patch.js reads sendButton to decide which modules the next launch reads ahead.
  window.__appLaunchMarks = launch;
  var longTimers = [];
  var stalls = [];
  var nativeSetTimeout = window.setTimeout;
  function callerOf(stack) {
    var frames = String(stack || "").split("\n");
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (!f || /app-tweaks|callerOf|setTimeout/.test(f)) continue;
      var m = /([\w.-]+\.js):(\d+):(\d+)/.exec(f);
      if (m) return m[1] + ":" + m[2] + ":" + m[3];
    }
    return "?";
  }
  // Timers of 2 s or more set during the first 40 s: a start-up that waits for a
  // timeout (rather than working) shows up here.
  if (DIAGNOSTICS) window.setTimeout = function (fn, delay) {
    var ms = Number(delay) || 0;
    if (ms >= 2000 && typeof fn === "function" && performance.now() < 40000 && longTimers.length < 30) {
      var entry = { ms: ms, at: performance.now(), by: callerOf(new Error().stack), firedAt: 0 };
      longTimers.push(entry);
      var original = fn;
      var args = Array.prototype.slice.call(arguments);
      args[0] = function () {
        entry.firedAt = performance.now();
        return original.apply(this, arguments);
      };
      return nativeSetTimeout.apply(window, args);
    }
    return nativeSetTimeout.apply(window, arguments);
  };

  // The page cannot run its timers while the main thread is busy; gaps in a
  // 100 ms heartbeat show how long it was blocked, and when.
  if (DIAGNOSTICS) (function heartbeat() {
    var last = performance.now();
    var beat = setInterval(function () {
      var now = performance.now();
      var gap = now - last;
      last = now;
      if (gap > 400 && document.visibilityState === "visible" && stalls.length < 12) {
        stalls.push({ at: now - gap, ms: gap });
      }
      if (now > 40000) clearInterval(beat);
    }, 100);
  })();

  // "Interactive" is when React has taken over the server-drawn page: its
  // internal keys appear on the message box. Until then taps do nothing.
  function reactOwns(el) {
    if (!el) return false;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("__reactFiber") === 0 || keys[i].indexOf("__reactProps") === 0) return true;
    }
    return false;
  }
  function pollLaunch() {
    var now = performance.now();
    if (!launch.interactive) {
      var box = document.querySelector(COMPOSER);
      if (reactOwns(box)) launch.interactive = now;
    }
    if (!launch.sendButton && document.querySelector('button[aria-label*="Send" i], button[aria-label*="send" i]')) {
      launch.sendButton = now;
    }
    if ((launch.interactive && launch.sendButton) || now > 90000) {
      reportLaunch();
      return;
    }
    nativeSetTimeout(pollLaunch, 200);
  }
  function seconds(ms) { return ms ? (ms / 1000).toFixed(1) + " s" : "not seen"; }
  function loaderStats() {
    try {
      return window.LegacyTranspiler && window.LegacyTranspiler.stats ? window.LegacyTranspiler.stats() : null;
    } catch (e) {
      return null;
    }
  }
  function reportLaunch() {
    if (launch.reported) return;
    launch.reported = true;
    var info = loaderStats();
    var s = info ? info.stats : {};
    var modules = info ? info.modules : [];
    appEvent("launch: page interactive at " + seconds(launch.interactive) + ", send button " + seconds(launch.sendButton) +
      " (" + (window.__appLoader ? window.__appLoader.mode : "?") + " loading, " + modules.length + " modules, " +
      (s.hits || 0) + " from cache, " + (s.misses || 0) + " transpiled)");
  }
  function launchSummary() {
    var info = loaderStats() || { stats: null, modules: [] };
    var out = info.stats ? loaderLines(info) : ["launch: loader statistics unavailable"];
    if (apiAtLaunch.length) {
      out.push("  API at launch: " + apiAtLaunch.slice(0, 14).map(function (a) {
        return a.method + " " + a.path.replace(/^\/api\//, "") + " " + Math.round(a.ms) + " ms (" + a.status + ") @" + seconds(a.at);
      }).join("; "));
    }
    if (longTimers.length) {
      out.push("  long timers: " + longTimers.slice(0, 10).map(function (t) {
        return Math.round(t.ms) + " ms @" + seconds(t.at) + " by " + t.by + (t.firedAt ? " fired " + seconds(t.firedAt) : "");
      }).join("; "));
    }
    if (stalls.length) {
      out.push("  main thread blocked: " + stalls.map(function (g) {
        return Math.round(g.ms) + " ms @" + seconds(g.at);
      }).join(", "));
    }
    return out;
  }
  function loaderLines(info) {
    var s = info.stats;
    var mods = info.modules;
    var lastRan = 0, lastDone = 0;
    mods.forEach(function (m) {
      if (m.ranAt > lastRan) lastRan = m.ranAt;
      if (m.doneAt > lastDone) lastDone = m.doneAt;
    });
    var out = [
      "launch (this page load): " + mods.length + " modules — " + s.hits + " from cache, " + s.misses + " transpiled (" +
        s.workerJobs + " in workers, " + s.mainJobs + " on the page), " + s.prefetchUsed + " ready in advance",
      "  page parsed " + seconds(launch.dom) + ", first module " + seconds(launch.firstModule) + ", last module ran " +
        seconds(lastRan) + ", last finished " + seconds(lastDone) + ", interactive " + seconds(launch.interactive) +
        ", send button " + seconds(launch.sendButton),
      "  transpiling " + Math.round(s.transpileMs) + " ms, downloading " + Math.round(s.fetchMs) + " ms, cache reads " +
        Math.round(s.readMs) + " ms, workers " + s.workers + (s.workerError ? " (" + s.workerError + ")" : "") +
        ", cache saves failed " + s.putFailures + (s.putError ? " (" + s.putError + ")" : "") +
        ", old entries removed " + s.pruned + ", old caches removed " + s.cachesRemoved +
        ", downloads retried " + (s.retries || 0) + ", modules not loaded " + (s.loadFailures || 0) +
        (s.loadError ? " (" + s.loadError + ")" : "")
    ];
    var loader = window.__appLoader;
    if (loader && loader.runTimes) {
      var rt = loader.runTimes();
      out.push("  main thread: app scripts " + Math.round(scriptsStartAt) + "–" + Math.round(loader.scriptReadyAt) +
        " ms; claude.ai module code " + rt.count + " modules in " + Math.round(rt.ms) + " ms (longest " +
        Math.round(rt.longest) + " ms " + rt.longestFile + "), " + rt.atParse + " of them in one go at " +
        seconds(rt.atParseAt) + " taking " + Math.round(rt.atParseMs) + " ms");
    }
    if (s.store) {
      var first = mods[0];
      out.push("  storage: " + (s.store === "app" ? "app files" : "web cache") + ", entry code ready " +
        (first && first.codeAt ? seconds(first.codeAt) : "not seen") + ", batches " + s.batchesRead + " of " + s.batches +
        " read in " + Math.round(s.batchMs) + " ms (first ready " + seconds(s.firstBatchAt) + "), " + s.batchHits +
        " modules from batches, " + s.migrated + " moved from the web cache" +
        (s.cacheOpenMs ? " (opened in " + Math.round(s.cacheOpenMs) + " ms)" : "") +
        (s.storeFiles ? ", " + s.storeFiles + " files " + (s.storeBytes / 1048576).toFixed(1) + " MB" : "") +
        (s.storeError ? " (" + s.storeError + ")" : ""));
    }
    var slow = mods.filter(function (m) { return m.ranAt && m.codeAt; })
      .sort(function (a, b) { return (b.ranAt - b.codeAt) - (a.ranAt - a.codeAt); }).slice(0, 5)
      .map(function (m) { return String(m.src).split("/").pop() + " " + Math.round(m.ranAt - m.codeAt) + " ms"; });
    if (slow.length) out.push("  slowest to start: " + slow.join(", "));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Background: what happens to the page, the microphone and audio
  // ---------------------------------------------------------------------------
  var micTracks = [];
  var audioContexts = [];
  var openSockets = [];
  var hiddenAt = 0;
  var hiddenBeats = { last: 0, longest: 0 };
  function mediaState() {
    var parts = [];
    micTracks.forEach(function (t, i) {
      if (t.readyState !== "ended" || i === micTracks.length - 1) {
        parts.push("mic " + t.readyState + (t.muted ? " muted" : "") + (t.enabled ? "" : " disabled"));
      }
    });
    audioContexts.forEach(function (c) { if (c.state !== "closed") parts.push("audio " + c.state); });
    var live = openSockets.filter(function (ws) { return ws.readyState <= 1; }).length;
    if (live) parts.push(live + " voice connection" + (live > 1 ? "s" : "") + " open");
    return parts.length ? parts.join(", ") : "no microphone or voice connection";
  }
  document.addEventListener("visibilitychange", function () {
    var now = performance.now();
    if (document.visibilityState === "hidden") {
      hiddenAt = now;
      hiddenBeats.last = now;
      hiddenBeats.longest = 0;
      record("life", "page hidden: " + mediaState());
    } else if (hiddenAt) {
      record("life", "page visible after " + seconds(now - hiddenAt) + " (longest pause while hidden " +
        seconds(hiddenBeats.longest) + "): " + mediaState());
      hiddenAt = 0;
    }
  });
  // While hidden, a 1 s heartbeat: a long gap means iOS paused the page.
  setInterval(function () {
    if (!hiddenAt) return;
    var now = performance.now();
    var gap = now - hiddenBeats.last;
    hiddenBeats.last = now;
    if (gap > hiddenBeats.longest) hiddenBeats.longest = gap;
  }, 1000);
  try {
    var md = navigator.mediaDevices;
    if (md && typeof md.getUserMedia === "function") {
      var originalGUM = md.getUserMedia.bind(md);
      md.getUserMedia = function (constraints) {
        return originalGUM(constraints).then(function (stream) {
          try {
            stream.getAudioTracks().forEach(function (track) {
              micTracks.push(track);
              if (micTracks.length > 6) micTracks.shift();
              ["mute", "unmute", "ended"].forEach(function (type) {
                track.addEventListener(type, function () {
                  record("life", "microphone " + type + (document.visibilityState === "hidden" ? " (page hidden)" : ""));
                });
              });
            });
          } catch (e) {}
          return stream;
        });
      };
    }
  } catch (e) {}
  ["AudioContext", "webkitAudioContext"].forEach(function (name) {
    var Original = window[name];
    if (typeof Original !== "function" || typeof Proxy !== "function") return;
    window[name] = new Proxy(Original, {
      construct: function (Target, args, newTarget) {
        var ctx = Reflect.construct(Target, args, newTarget);
        try {
          audioContexts.push(ctx);
          if (audioContexts.length > 6) audioContexts.shift();
          ctx.addEventListener("statechange", function () {
            if (document.visibilityState === "hidden" || ctx.state === "interrupted") {
              record("life", "audio " + ctx.state + (document.visibilityState === "hidden" ? " (page hidden)" : ""));
            }
          });
        } catch (e) {}
        return ctx;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // What is on screen (for sizing controls): visible buttons and their sizes
  // ---------------------------------------------------------------------------
  function screenInventory() {
    var out = [];
    try {
      var nodes = document.querySelectorAll("button, a[href], [role='button'], input, textarea, [contenteditable='true']");
      var h = window.innerHeight, w = window.innerWidth;
      for (var i = 0; i < nodes.length && out.length < 45; i++) {
        var r = nodes[i].getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) continue;
        out.push("  " + describeTarget(nodes[i]) + " " + Math.round(r.width) + "x" + Math.round(r.height) +
          " at " + Math.round(r.left) + "," + Math.round(r.top));
      }
    } catch (e) {}
    return out.length ? ["on screen now (CSS px, layout width " + window.innerWidth + "):"].concat(out) : [];
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Native controls (round 12)
  // ---------------------------------------------------------------------------
  // The app draws a standard iOS top bar and message bar (ViewController.m,
  // NativeChrome). Its bars are solid and cover claude.ai's header and message
  // box, which are also made invisible but stay in place: the app presses their buttons and puts text into
  // claude.ai's box, so claude.ai still does the work, and its menus open where the
  // app's buttons are. Controls are found by their labels; when one is missing,
  // nothing is hidden (ready: false) and the app shows claude.ai's own controls.
  var NATIVE_CHROME = !!settings.nativeChrome; // true or 1 from the app
  var chromeState = { ready: false, why: "not started" };
  var chromeSent = "";
  var EDITOR = '[contenteditable="true"][aria-label="Write your prompt to Claude"]';
  var EFFORTS = /^(Low|Medium|High|Extra|Max)$/;

  function find(selector, root) {
    try {
      return (root || document).querySelector(selector);
    } catch (e) {
      return null;
    }
  }
  // The outermost ancestor that is still the same control (no taller than
  // maxHeight), so its card or bar is hidden too, not only what is inside.
  // Never past an element holding the sidebar panel (aside), which must stay.
  function wholeControl(el, maxHeight) {
    var best = el;
    var parent = el && el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      var box = parent.getBoundingClientRect();
      if (box.height > maxHeight || box.height === 0 || parent.querySelector("aside")) break;
      best = parent;
      parent = parent.parentElement;
    }
    return best;
  }
  // The nearest element holding all of them (none if that is the whole page).
  function holding(list) {
    list = list.filter(Boolean);
    var box = list[0];
    while (box && !list.every(function (el) { return box.contains(el); })) box = box.parentElement;
    return box && box !== document.body && box !== document.documentElement ? box : null;
  }
  // The top bar's buttons (chat title, "More options", share; incognito on a new
  // chat). Not the sidebar's: claude.ai's "Show sidebar" button sits inside the
  // collapsed sidebar panel (aside.dframe-sidebar), which must stay untouched.
  // Only buttons that are on screen in the top strip and stay there: buttons of
  // messages scrolled above the screen also have a small "top" (log 11 Nov: the
  // reply toolbars were taken for the top bar, hidden, and searched for again at
  // every scroll).
  function topBarButtons() {
    var out = [];
    var buttons = document.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].closest("aside")) continue;
      var box = buttons[i].getBoundingClientRect();
      if (box.width > 0 && box.top >= -1 && box.bottom <= 70 && box.left > 40 && pinned(buttons[i])) out.push(buttons[i]);
    }
    return out;
  }
  // Stays in place when the chat scrolls: outside every scroll area, or held by
  // a sticky or fixed ancestor inside it.
  function pinned(el) {
    for (var node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      var style = getComputedStyle(node);
      if (style.position === "sticky" || style.position === "fixed") return true;
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return false;
    }
    return true;
  }
  // Found controls are kept until the address changes or one leaves the page,
  // so the page is not searched again after every change.
  var found = null;
  function stillThere(list) {
    return list.every(function (el) { return el.isConnected; });
  }
  function chromeControls() {
    var c = {};
    c.editor = find(EDITOR) || find('.ProseMirror[contenteditable="true"]');
    c.send = find('button[aria-label="Send message"]');
    c.sidebarButton = find('button[aria-label="Show sidebar"]');
    var samePage = !!found && found.path === location.pathname;
    // The message box card found before is kept while it still holds the text
    // box and send button (it is collapsed, so it cannot be measured again).
    if (found && found.composer && found.composer.isConnected && c.editor && c.send &&
        found.composer.contains(c.editor) && found.composer.contains(c.send)) {
      c.composer = found.composer;
    } else if (c.editor && c.send) {
      // The whole card: the text, + and model buttons, mic, send.
      var box = holding([c.editor, c.send, find('button[aria-label^="Model:"]'),
        find('button[aria-label="Add files, connectors, and more"]')]) || holding([c.editor, c.send]);
      if (box) c.composer = wholeControl(box, box.getBoundingClientRect().height + 60);
    }
    var searched = false; // the page was searched for the top bar with its message box there
    if (samePage && stillThere(found.topBar) && (found.searched || !c.composer)) {
      c.topBar = found.topBar;
      c.topHeight = found.topHeight;
      searched = !!found.searched;
    } else if (!c.composer) {
      // Still loading (or voice mode has replaced the message box): the page is
      // not searched for a top bar until its message box is there.
      c.topBar = [];
      c.topHeight = 0;
    } else {
      // The top bar's groups (in a chat they sit in different parts of the
      // layout), each hidden on its own; one inside another counts once.
      var groups = [];
      topBarButtons().forEach(function (button) {
        var group = wholeControl(button, 80);
        if (groups.some(function (g) { return g.contains(group); })) return;
        groups = groups.filter(function (g) { return !group.contains(g); });
        groups.push(group);
      });
      c.topBar = groups;
      // How far down claude.ai's top bar reaches: the app's bar covers that much.
      var topHeight = 0;
      groups.forEach(function (g) {
        var bottom = g.getBoundingClientRect().bottom;
        if (bottom > topHeight && bottom <= 90) topHeight = bottom;
      });
      c.topHeight = Math.round(topHeight);
      searched = true;
    }
    if (c.composer || (found && c.topBar !== found.topBar)) {
      if (!found || found.composer !== c.composer || found.topBar !== c.topBar || found.path !== location.pathname) {
        found = { path: location.pathname, editor: c.editor, composer: c.composer, topBar: c.topBar, topHeight: c.topHeight, searched: searched };
      } else {
        found.editor = c.editor;
      }
    }
    c.more = null;
    c.topBar.some(function (g) { return (c.more = find('button[aria-label^="More options"]', g)); });
    return c;
  }
  // Something the hidden marks depend on changed (a new page, or claude.ai
  // drew its controls again): they are set again at once, before the screen is
  // drawn, so claude.ai's own controls never flash.
  function chromeStale() {
    if (pageKind() === "other") return false;
    if (!found || !found.composer) {
      return !!find('button[aria-label="Send message"]') && !!find(EDITOR);
    }
    return found.path !== location.pathname || !found.composer.isConnected ||
      !found.editor || !found.editor.isConnected || !stillThere(found.topBar);
  }
  function describeElement(el) {
    if (!el) return "none";
    var box = el.getBoundingClientRect();
    var cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "")
      .split(/\s+/).slice(0, 3).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + " " + Math.round(box.width) + "x" + Math.round(box.height) +
      " at " + Math.round(box.left) + "," + Math.round(box.top);
  }
  // The sidebar counts as open when its "Artifacts" link is what a tap there would hit.
  function sidebarOpen() {
    var link = find('a[href="/artifacts"]');
    if (!link) return false;
    var box = link.getBoundingClientRect();
    if (box.width === 0 || box.right <= 0 || box.left >= window.innerWidth) return false;
    var hit = document.elementFromPoint(box.left + Math.min(20, box.width / 2), box.top + box.height / 2);
    return !!hit && (hit === link || link.contains(hit));
  }
  function stopButton(root) {
    var buttons = root ? root.querySelectorAll("button[aria-label]") : [];
    for (var i = 0; i < buttons.length; i++) {
      if (/^stop/i.test(buttons[i].getAttribute("aria-label"))) return buttons[i];
    }
    return null;
  }
  // The chat's name for the app's top bar, from the page title ("Name - Claude").
  // Shown only; never written to the debug log.
  function chatTitle() {
    var title = String(document.title || "").replace(/\s*[-\u2013|]\s*Claude\s*$/, "").trim();
    return title === "Claude" ? "" : title.slice(0, 80);
  }
  function pageKind() {
    var path = location.pathname;
    if (path === "/" || path === "/new") return "new";
    return /^\/chat\//.test(path) ? "chat" : "other";
  }

  // claude.ai's message box takes no room either (the page ends where the app's
  // message bar begins), so the last message sits right above the app's bar.
  var collapsedNow = null;
  function setCollapsed(el) {
    if (collapsedNow === el) return;
    if (collapsedNow) collapsedNow.removeAttribute("data-app-collapsed");
    if (el) el.setAttribute("data-app-collapsed", "");
    collapsedNow = el;
  }
  var hiddenNow = [];
  // Only what changed is touched: re-setting the marks restyles the page.
  function setHidden(list) {
    hiddenNow.forEach(function (el) {
      if (list.indexOf(el) === -1) el.removeAttribute("data-app-hidden");
    });
    list.forEach(function (el) {
      if (!el.hasAttribute("data-app-hidden")) el.setAttribute("data-app-hidden", "");
    });
    hiddenNow = list;
    var root = document.documentElement;
    if (root.classList.contains("app-native-chrome") !== list.length > 0) {
      root.classList.toggle("app-native-chrome", list.length > 0);
    }
  }

  // While claude.ai's sidebar is open, its own interface is shown untouched and
  // the app's controls step aside. Open: the sidebar's links are what a tap hits,
  // or the sidebar button says it is expanded, or a close button is there. Ends
  // when it was seen open and is closed again, when a chat is picked (the address
  // changes), or after 30 s.
  var sidebarMode = null;
  function sidebarShowing() {
    var button = find('button[aria-label="Show sidebar"]');
    return sidebarOpen() || !!find('button[aria-label="Close sidebar"], button[aria-label="Hide sidebar"]') ||
      !!(button && button.getAttribute("aria-expanded") === "true");
  }
  function inSidebarMode() {
    if (!sidebarMode) return false;
    var open = sidebarShowing();
    if (open) sidebarMode.seenOpen = true;
    if ((sidebarMode.seenOpen && !open) || location.pathname !== sidebarMode.path ||
        performance.now() - sidebarMode.since > 30000) {
      nativeSetTimeout(chatGroupsFromPage, 300);
      record("chrome", "sidebar closed (" + (location.pathname !== sidebarMode.path ? "chat picked" :
        sidebarMode.seenOpen ? "seen closing" : "30 s passed, never seen open") + ")");
      sidebarMode = null;
      return false;
    }
    return true;
  }
  function openSidebar(c) {
    sidebarMode = { since: performance.now(), path: location.pathname, seenOpen: false };
    setHidden([]);
    var result = press(c.sidebarButton, "sidebar button");
    nativeSetTimeout(function () {
      var hit = document.elementFromPoint(100, Math.round(window.innerHeight / 2));
      var button = find('button[aria-label="Show sidebar"]');
      record("chrome", "sidebar after 700 ms: open " + sidebarShowing() + ", links hit " + sidebarOpen() +
        ", expanded " + (button ? button.getAttribute("aria-expanded") : "no button") +
        ", at the middle " + describeElement(hit));
    }, 700);
    return result;
  }

  // Voice mode and dictation happen inside claude.ai's message box (its voice
  // screen, the dictated words). While one runs, that box is shown as it is and
  // the app's message bar steps aside. Over when claude.ai's voice / dictate
  // button is back and its box is empty again (dictated text is sent or cleared
  // there), or when it never started within 5 s.
  var takeover = null;
  function startTakeover(kind) {
    takeover = { kind: kind, since: performance.now(), path: location.pathname, busy: false };
  }
  function inTakeover(c) {
    if (!takeover) return false;
    var idle = !!find(takeover.kind === "voice" ? 'button[aria-label="Use voice mode"]' : 'button[aria-label="Dictate"]');
    if (!idle) takeover.busy = true;
    var empty = !c.editor || !c.editor.textContent.replace(/\s/g, "");
    var age = performance.now() - takeover.since;
    var over = location.pathname !== takeover.path ||
      (idle && empty && !!c.editor && !!c.send && age > (takeover.busy ? 800 : 5000));
    if (!over) return true;
    record("chrome", takeover.kind + " ended after " + Math.round(age / 1000) + " s" + (takeover.busy ? "" : " (never seen starting)"));
    takeover = null;
    return false;
  }

  var lastHiddenFound = null;
  function updateChrome() {
    var c = chromeControls();
    var kind = pageKind();
    var own = kind !== "other" && inTakeover(c);
    var missing = [];
    if (!c.editor) missing.push("message box");
    if (!c.send) missing.push("send button");
    if (!c.composer) missing.push("message box card");
    var ready = kind !== "other" && (missing.length === 0 || own);
    var sidebar = ready && inSidebarMode();
    var hideBox = ready && !sidebar && !own && c.composer ? c.composer : null;
    // The sidebar button alone, never its panel: the native menu button covers it.
    setHidden(ready && !sidebar ? c.topBar.concat([hideBox, c.sidebarButton]).filter(Boolean) : []);
    setCollapsed(hideBox);
    if (ready && !sidebar) {
      // Once per search of the page, not at every change of size or position.
      if (found !== lastHiddenFound) {
        lastHiddenFound = found;
        record("chrome", "hidden " + kind + ": top bar " +
          (c.topBar.length ? c.topBar.slice(0, 4).map(describeElement).join(" + ") : "none") +
          (c.topBar.length > 4 ? " + " + (c.topBar.length - 4) + " more" : "") +
          "; message box " + describeElement(c.composer));
      }
    }
    var model = find('button[aria-label^="Model:"]');
    var modelName = model ? model.getAttribute("aria-label").replace(/^Model:\s*/, "") : "";
    var words = modelName.split(" ");
    var effort = words.length > 1 && EFFORTS.test(words[words.length - 1]) ? words.pop() : "";
    chromeState = {
      ready: ready,
      why: kind === "other" ? "page " + location.pathname.split("/")[1] : missing.length ? "missing " + missing.join(", ") : "",
      page: kind,
      title: kind === "chat" ? chatTitle() : "",
      topHeight: c.topHeight || 0,
      viewWidth: window.innerWidth || 0,
      sidebarOpen: sidebar,
      composerShown: own,
      streaming: !!(c.composer && stopButton(c.composer)),
      model: words.join(" "),
      effort: effort,
      voice: !!find('button[aria-label="Use voice mode"]'),
      dictate: !!find('button[aria-label="Dictate"]'),
      incognito: !!find('button[aria-label="Use incognito"]'),
      more: !!c.more
    };
    var key = JSON.stringify(chromeState);
    if (key === chromeSent) return;
    chromeSent = key;
    try {
      window.webkit.messageHandlers.chrome.postMessage(chromeState);
    } catch (e) {}
  }

  function press(el, label) {
    if (!el) return "missing " + label;
    el.click();
    return "ok";
  }
  // Hands the text to claude.ai's (empty) message box as a paste, without focusing
  // it, so the app's keyboard stays up. Only short text: claude.ai turns long
  // pastes into an attached file. False when the paste did not land.
  var PASTE_LIMIT = 2000;
  function pasteInto(editor, text) {
    if (text.length > PASTE_LIMIT || editor.textContent.replace(/\s/g, "")) return false;
    if (typeof DataTransfer !== "function" || typeof ClipboardEvent !== "function") return false;
    try {
      var data = new DataTransfer();
      data.setData("text/plain", text);
      var event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      // Without readable clipboard data the editor would take focus to capture it.
      if (!event.clipboardData || event.clipboardData.getData("text/plain") !== text) return false;
      editor.dispatchEvent(event);
    } catch (e) {
      return false;
    }
    return editor.textContent.replace(/\s/g, "").length > 0;
  }
  // Types the text into claude.ai's box: focused with inputmode "none" so the
  // page's own keyboard stays away (the app's keyboard drops for a moment).
  function typeInto(editor, text) {
    editor.focus();
    var range = document.createRange();
    range.selectNodeContents(editor);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
  }
  // Puts the text into claude.ai's message box and presses its send button.
  function sendText(text) {
    var c = chromeControls();
    if (!c.editor || !c.send) return Promise.resolve("message box not found");
    if (!text.replace(/\s/g, "")) return Promise.resolve("nothing to send");
    var editor = c.editor;
    var mode = editor.getAttribute("inputmode");
    var how = "pasted";
    if (!pasteInto(editor, text)) {
      how = "typed";
      editor.setAttribute("inputmode", "none");
      try {
        typeInto(editor, text);
      } catch (e) {
        return Promise.resolve("typing failed: " + describe(e));
      }
    }
    return new Promise(function (resolve) {
      var tries = 0;
      var finish = function (result) {
        if (how === "typed") {
          try { editor.blur(); } catch (e) {}
          if (mode === null) editor.removeAttribute("inputmode");
          else editor.setAttribute("inputmode", mode);
        }
        record("chrome", "send (" + how + "): " + result);
        resolve(result);
      };
      var attempt = function () {
        var send = find('button[aria-label="Send message"]');
        if (send && !send.disabled) {
          send.click();
          finish("ok");
        } else if (++tries > 40) {
          finish("send button stayed disabled");
        } else {
          nativeSetTimeout(attempt, 50);
        }
      };
      attempt();
    });
  }

  // The app's keyboard covers the bottom of the page (the page itself does not
  // shrink for it), so claude.ai's message list gets that much room at its end,
  // and stays scrolled to the end when it was there. arg: "points,viewWidthPoints".
  var keyboardScroller = null;
  function messageScroller() {
    var start = find('button[aria-label="Copy"]') || chromeControls().composer;
    for (var el = start; el && el !== document.body; el = el.parentElement) {
      var overflow = getComputedStyle(el).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement;
  }
  function setKeyboardRoom(arg) {
    var parts = String(arg).split(",");
    var points = Number(parts[0]) || 0;
    var width = Number(parts[1]) || window.innerWidth;
    var px = Math.round(points * window.innerWidth / width);
    if (keyboardScroller && (!px || !keyboardScroller.isConnected)) {
      keyboardScroller.style.removeProperty("padding-bottom");
      keyboardScroller = null;
    }
    if (!px) return "ok";
    var scroller = messageScroller();
    if (!scroller) return "no message list";
    var atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    scroller.style.setProperty("padding-bottom", px + "px", "important");
    keyboardScroller = scroller;
    if (atEnd) scroller.scrollTop = scroller.scrollHeight;
    return "ok";
  }

  window.__appChrome = {
    noteChatList: noteChatList,
    chatGroupsFromPage: chatGroupsFromPage,
    run: function (name, arg) {
      var c = chromeControls();
      var result;
      switch (name) {
        case "sidebar": result = openSidebar(c); break;
        case "incognito": result = press(find('button[aria-label="Use incognito"]'), "incognito button"); break;
        case "newChat":
          var link = find('a[href="/new"]');
          if (link) link.click();
          else location.assign("/new");
          result = "ok";
          break;
        case "openChat":
          // From the app's chat list: claude.ai's own link to that chat when it
          // has one (no reload), else the chat's address.
          var chatId = String(arg || "");
          if (!CHAT_ID.test(chatId)) { result = "not a chat id"; break; }
          var chatLink = find('a[href="/chat/' + chatId + '"]');
          if (chatLink) chatLink.click();
          else location.assign("/chat/" + chatId);
          result = "ok";
          break;
        case "more": result = press(c.more, "chat menu"); break;
        case "plus": result = press(find('button[aria-label="Add files, connectors, and more"]'), "+ button"); break;
        case "model": result = press(find('button[aria-label^="Model:"]'), "model button"); break;
        case "dictate":
        case "voice":
          // claude.ai's box is shown first, so its voice screen or the dictated
          // words open where they can be seen.
          startTakeover(name);
          updateChrome();
          result = press(find(name === "voice" ? 'button[aria-label="Use voice mode"]' : 'button[aria-label="Dictate"]'), name + " button");
          if (result !== "ok") takeover = null;
          break;
        case "stop": result = press(c.composer && stopButton(c.composer), "stop button"); break;
        case "send": return sendText(String(arg || ""));
        case "keyboard": return setKeyboardRoom(arg);
        default: result = "unknown action " + name;
      }
      if (result !== "ok") record("chrome", name + ": " + result);
      nativeSetTimeout(updateChrome, 50);
      return result;
    }
  };

  function startChrome() {
    var style = document.createElement("style");
    style.textContent = "html.app-native-chrome [data-app-hidden]{opacity:0!important;pointer-events:none!important}" +
      "html.app-native-chrome [data-app-collapsed]{height:0!important;min-height:0!important;max-height:0!important;" +
      "overflow:hidden!important;padding-top:0!important;padding-bottom:0!important;margin-top:0!important;" +
      "margin-bottom:0!important;border-width:0!important}";
    (document.head || document.documentElement).appendChild(style);
    var pending = null;
    var schedule = function () {
      if (pending) return;
      pending = nativeSetTimeout(function () { pending = null; updateChrome(); }, 120);
    };
    try {
      // An observer runs before the screen is drawn: when the controls have
      // just appeared or been replaced, they are hidden in that same moment.
      new NativeObserver(function () {
        if (chromeStale()) updateChrome();
        else schedule();
      }).observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "disabled", "data-state"]
      });
    } catch (e) {}
    document.addEventListener("touchend", function () { nativeSetTimeout(updateChrome, 350); }, { passive: true, capture: true });
    setInterval(updateChrome, 1000);
    nativeSetTimeout(chatsFromPage, 8000);
    nativeSetTimeout(chatGroupsFromPage, 5000);
    setInterval(chatGroupsFromPage, 60000);
    updateChrome();
  }

  function chromeSummary() {
    if (!NATIVE_CHROME) return ["native controls: off"];
    var s = chromeState;
    return ["chat list: " + chatListCount + " chats handed to the app in " + chatListPosts + " reports",
      "native controls: on, " + (s.ready ? "in use" : "not in use (" + s.why + ")") +
      (s.ready ? ", page " + s.page + ", sidebar " + (s.sidebarOpen ? "open" : "closed") +
        ", answering " + (s.streaming ? "yes" : "no") + ", model " + (s.model || "?") + (s.effort ? " " + s.effort : "") : "")];
  }

  function onReady() {
    domReady = true;
    if (NATIVE_CHROME) startChrome();
    launch.dom = performance.now();
    pollLaunch();
    lockViewport();
    addStyle();
    reportAppearance();
    try {
      if (document.head && typeof NativeObserver === "function") {
        new NativeObserver(lockViewport).observe(document.head, {
          childList: true, subtree: true, attributes: true, attributeFilter: ["content"]
        });
      }
      var pending = null;
      var schedule = function () {
        if (pending) return;
        pending = setTimeout(function () { pending = null; reportAppearance(); }, 150);
      };
      var themeAttributes = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode"] };
      if (typeof NativeObserver === "function") {
        new NativeObserver(schedule).observe(document.documentElement, themeAttributes);
        if (document.body) new NativeObserver(schedule).observe(document.body, themeAttributes);
      }
      if (window.matchMedia) {
        var dark = window.matchMedia("(prefers-color-scheme: dark)");
        if (dark.addEventListener) dark.addEventListener("change", schedule);
      }
      document.addEventListener("touchstart", pinComposer, { passive: true, capture: true });
      // Opening the sidebar or a sheet changes the edge colours. Re-check a few
      // times while the animation runs; the app cross-fades between reports.
      var SAMPLE_TIMES = [60, 140, 240, 380, 560];
      document.addEventListener("touchend", function () {
        if (DIAGNOSTICS) measureTap();
        for (var i = 0; i < SAMPLE_TIMES.length; i++) setTimeout(reportAppearance, SAMPLE_TIMES[i]);
      }, { passive: true, capture: true });
    } catch (e) {
      record("app", "observer setup failed: " + describe(e));
    }
    // Page navigations inside the app can change the header colour too.
    setInterval(reportAppearance, 2000);
    if (DIAGNOSTICS) {
      ["beforeinput", "input", "compositionstart", "compositionend", "keydown"].forEach(function (type) {
        document.addEventListener(type, watchComposer, true);
      });
      nativeSetTimeout(probeIndexedDB, 3000);
    }
    // Chat-opening timings need to know when the screen last changed.
    try {
      if (document.body && typeof NativeObserver === "function") {
        new NativeObserver(function () {
          if (chatOpen) lastMutationAt = performance.now();
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      }
    } catch (e) {}
  }

  // Typing in the message box: when claude.ai shows its send button. Only the
  // kind of each event is noted, never what was typed.
  var composerNotes = 0;
  function sendButtonState() {
    var button = document.querySelector('button[aria-label="Send message"]');
    if (!button) return "none";
    var box = button.getBoundingClientRect();
    var style = getComputedStyle(button);
    if (!box.width || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.1) return "hidden";
    return button.disabled ? "disabled" : "shown";
  }
  function watchComposer(event) {
    if (composerNotes >= 16) return;
    if (event.type === "keydown" && event.key !== "Enter") return;
    var target = event.target;
    if (!target || !target.closest || !target.closest('[contenteditable="true"], textarea')) return;
    composerNotes++;
    var kind = event.type + (event.inputType ? " " + event.inputType : "") + (event.isComposing ? " (composing)" : "") +
      (event.key === "Enter" ? " Enter" : "");
    var before = sendButtonState();
    nativeSetTimeout(function () {
      record("type", kind + ": send button " + before + ", 300 ms later " + sendButtonState());
    }, 300);
  }

  // claude.ai reports its IndexedDB reads as refused: does IndexedDB work at
  // all here? A throwaway database is opened, written, read and deleted.
  function probeIndexedDB() {
    var t0 = performance.now();
    var done = function (text) {
      record("idb", "probe " + text + " in " + Math.round(performance.now() - t0) + " ms");
    };
    try {
      if (!window.indexedDB) return done("unavailable");
      var request = indexedDB.open("__app_probe", 1);
      request.onupgradeneeded = function () { request.result.createObjectStore("s"); };
      request.onerror = function () { done("open failed: " + describe(request.error)); };
      request.onblocked = function () { done("open blocked"); };
      request.onsuccess = function () {
        var db = request.result;
        try {
          var tx = db.transaction("s", "readwrite");
          tx.objectStore("s").put(1, "k");
          tx.oncomplete = function () {
            var read = db.transaction("s", "readonly").objectStore("s").get("k");
            read.onsuccess = function () {
              db.close();
              indexedDB.deleteDatabase("__app_probe");
              done(read.result === 1 ? "ok" : "read back wrong value");
            };
            read.onerror = function () { db.close(); done("read failed: " + describe(read.error)); };
          };
          tx.onerror = function () { db.close(); done("write failed: " + describe(tx.error)); };
        } catch (e) {
          db.close();
          done("failed: " + describe(e));
        }
      };
      if (indexedDB.databases) {
        indexedDB.databases().then(function (list) {
          record("idb", list.length + " databases on claude.ai: " + list.map(function (d) {
            return String(d.name).slice(0, 40) + " v" + d.version;
          }).join(", "));
        }, function (e) {
          record("idb", "database list failed: " + describe(e));
        });
      }
    } catch (e) {
      done("failed: " + describe(e));
    }
    try {
      if (window.caches && caches.keys) {
        caches.keys().then(function (names) {
          record("idb", names.length + " web caches on claude.ai" + (names.length ? ": " + names.map(function (n) {
            return String(n).slice(0, 40);
          }).join(", ") : ""));
        }, function () {});
      }
      var localChars = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        localChars += key.length + String(localStorage.getItem(key) || "").length;
      }
      record("idb", "local storage " + localStorage.length + " entries, " + Math.round(localChars / 1024) + " K characters");
    } catch (e) {}
  }

  // Apply the page size as soon as claude.ai's viewport tag is parsed, so the
  // first frame is already drawn at the chosen size.
  if (PAGE_SCALE > 1.001 && typeof NativeObserver === "function" && document.readyState === "loading") {
    var earlyViewport = new NativeObserver(function () {
      if (document.head && document.head.querySelector('meta[name="viewport"]')) {
        lockViewport();
        earlyViewport.disconnect();
      }
    });
    earlyViewport.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();
