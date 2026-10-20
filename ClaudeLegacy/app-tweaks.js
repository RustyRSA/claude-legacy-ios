// app-tweaks.js — injected at document start, before every other script.
//
// 1. App feel: no pinch or double-tap zoom, no long-press link callouts, no grey
//    tap flash, and the strips above and below the page (plus the status bar
//    text) follow the colours Claude draws at its top and bottom edges.
// 2. Voice mode on iOS versions that cannot record Opus: claude.ai's voice session
//    has an uncompressed recording mode (16 kHz PCM via ScriptProcessor); these
//    patches switch it on and let the voice button appear.
// 3. A small debug log, copied from the three-finger long-press menu, including
//    how the voice and dictation connections went.
(function () {
  "use strict";
  if (window.__appTweaksLoaded) return;
  window.__appTweaksLoaded = true;

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

  var NOISE = /^\[(cache hit|cache miss|importModule|exportModule|evaluateJavaScript)\]/;
  var RELEVANT = /voice|audio|record|micro|\bmic\b|getUserMedia|websocket|speech|\bpcm\b|opus|permission|dictation/i;

  ["error", "warn", "info", "log", "debug"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      try {
        var first = arguments[0];
        if (!(typeof first === "string" && NOISE.test(first))) {
          var text = describeAll(arguments);
          if (level === "error" || level === "warn" || RELEVANT.test(text)) record(level, text);
        }
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

  window.__appLogNative = function (text) {
    record("native", String(text));
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
      "----"
    ];
    return header.concat(lines).join("\n");
  };

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
  var VOICE_SOCKET = /\/api\/ws\/(voice|speech_to_text)\//;
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

  if (typeof window.WebSocket === "function" && typeof Proxy === "function") {
    var socketCount = 0;
    window.WebSocket = new Proxy(window.WebSocket, {
      construct: function (Target, args, newTarget) {
        var ws = Reflect.construct(Target, args, newTarget);
        try {
          if (VOICE_SOCKET.test(String(args[0]))) {
            var label = "#" + (++socketCount);
            record("ws", label + " connect " + describeSocketURL(args[0]));
            watchSocket(ws, label);
          }
        } catch (e) {}
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
  function lockViewport() {
    var head = document.head;
    if (!head) return;
    var metas = head.querySelectorAll('meta[name="viewport"]');
    if (!metas.length) {
      var meta = document.createElement("meta");
      meta.name = "viewport";
      meta.content = "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no";
      head.appendChild(meta);
      return;
    }
    for (var i = 0; i < metas.length; i++) {
      var content = metas[i].getAttribute("content") || "";
      if (/user-scalable\s*=\s*no/i.test(content)) continue;
      var parts = content.split(",").map(function (s) { return s.trim(); }).filter(function (s) {
        return s && !/^(maximum-scale|minimum-scale|user-scalable)\s*=/i.test(s);
      });
      parts.push("maximum-scale=1", "user-scalable=no");
      metas[i].setAttribute("content", parts.join(", "));
    }
  }

  function addStyle() {
    if (document.getElementById("app-tweaks-style")) return;
    var style = document.createElement("style");
    style.id = "app-tweaks-style";
    style.textContent =
      "a{-webkit-touch-callout:none!important}" +
      "*{-webkit-tap-highlight-color:transparent!important}";
    (document.head || document.documentElement).appendChild(style);
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

  // The first opaque background found at (x, y), walking up from the element there.
  function colourAt(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el.nodeType === 1) {
      var c = toRGB(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.5) return { r: c.r, g: c.g, b: c.b };
      el = el.parentElement;
    }
    if (!document.body) return null;
    var body = toRGB(getComputedStyle(document.body).backgroundColor);
    return body && body.a > 0.5 ? { r: body.r, g: body.g, b: body.b } : null;
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

  function onReady() {
    lockViewport();
    addStyle();
    reportAppearance();
    try {
      if (document.head) {
        new MutationObserver(lockViewport).observe(document.head, {
          childList: true, subtree: true, attributes: true, attributeFilter: ["content"]
        });
      }
      var pending = null;
      var schedule = function () {
        if (pending) return;
        pending = setTimeout(function () { pending = null; reportAppearance(); }, 150);
      };
      var themeAttributes = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode"] };
      new MutationObserver(schedule).observe(document.documentElement, themeAttributes);
      if (document.body) new MutationObserver(schedule).observe(document.body, themeAttributes);
      if (window.matchMedia) {
        var dark = window.matchMedia("(prefers-color-scheme: dark)");
        if (dark.addEventListener) dark.addEventListener("change", schedule);
      }
      // Opening the sidebar or a sheet changes the edge colours; re-check once
      // the animation has settled.
      document.addEventListener("touchend", function () {
        setTimeout(reportAppearance, 400);
      }, { passive: true, capture: true });
    } catch (e) {
      record("app", "observer setup failed: " + describe(e));
    }
    // Page navigations inside the app can change the header colour too.
    setInterval(reportAppearance, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();
