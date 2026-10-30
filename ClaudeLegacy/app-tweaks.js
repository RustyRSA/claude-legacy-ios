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

  // ---------------------------------------------------------------------------
  // Debug log
  // ---------------------------------------------------------------------------
  var MAX_LINES = 400;
  var lines = [];
  var startedAt = Date.now();
  var patchStatus = { supportCheck: "not seen yet", pcmMode: "not seen yet" };

  function record(kind, text) {
    lines.push(((Date.now() - startedAt) / 1000).toFixed(1) + "s " + kind + " " + text);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  }

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
      return Object.prototype.toString.call(value);
    } catch (e) {
      return "[object]";
    }
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
        ", loading " + (window.__appLoader ? window.__appLoader.mode +
          (window.__appLoader.mode === "fast" ? (window.__appLoader.inPage() ? " (in page)" : " (through the app)") : "") : "?")
    ].concat(launchSummary(), chatSummary(), tapSummary(), responsivenessSummary(), screenInventory(), ["----"]);
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
    if (key === lastReported) return;
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
  if (typeof NativeObserver === "function" && typeof Proxy === "function" && window.performance) {
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
    var sorted = tapReactions.slice().sort(function (a, b) { return a - b; });
    var median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    var worst = sorted.length ? sorted[sorted.length - 1] : 0;
    return [
      "taps measured: " + sorted.length + ", page reacts after median " + round(median) + " ms (worst " + round(worst) + " ms)",
      "frames after taps: " + longFrames.frames + ", over 50 ms: " + longFrames.count + " (worst " + round(longFrames.worst) + " ms)",
      "page-watching work: polyfills " + round(observerCost.early.ms) + " ms in " + observerCost.early.calls +
        " calls (worst " + round(observerCost.early.worst) + " ms), claude.ai " + round(observerCost.app.ms) + " ms in " +
        observerCost.app.calls + " calls (worst " + round(observerCost.app.worst) + " ms)"
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
      part("screen settled", c.settledAt)].join(", ");
    chatOpens.push(line);
    if (chatOpens.length > 8) chatOpens.shift();
    record("chat", "opened a chat: " + line);
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
    if (chatOpen && !chatOpen.dataAt && method === "GET" && /\/chat_conversations\/…$/.test(path) &&
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
        }, function () {
          noteApi(path, method, startedAt, "failed", null, url);
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
  window.setTimeout = function (fn, delay) {
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
  (function heartbeat() {
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
        ", old entries removed " + s.pruned + ", old caches removed " + s.cachesRemoved
    ];
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
  function onReady() {
    domReady = true;
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
        measureTap();
        for (var i = 0; i < SAMPLE_TIMES.length; i++) setTimeout(reportAppearance, SAMPLE_TIMES[i]);
      }, { passive: true, capture: true });
    } catch (e) {
      record("app", "observer setup failed: " + describe(e));
    }
    // Page navigations inside the app can change the header colour too.
    setInterval(reportAppearance, 2000);
    // Chat-opening timings need to know when the screen last changed.
    try {
      if (document.body && typeof NativeObserver === "function") {
        new NativeObserver(function () {
          if (chatOpen) lastMutationAt = performance.now();
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      }
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
