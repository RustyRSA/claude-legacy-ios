# CLAUDE.md — Claude Legacy (RustyRSA fork)

Handoff notes for Claude Code. Read this first, then `docs` links at the end.

## What this is

A native iOS app that runs **claude.ai** inside a `WKWebView` on **iOS 16.3.1**
(Logan's jailbroken iPhone 14 Pro, installed with TrollStore). The official app
needs a newer iOS and Safari 16.3 cannot run claude.ai, so the app rewrites
claude.ai's JavaScript at runtime into something WebKit 16.3 can execute.

- Fork of [mgefimov/claude-legacy-ios](https://github.com/mgefimov/claude-legacy-ios)
  (forked at upstream `c413195`). Owner: Logan (GitHub `RustyRSA`).
- Logan builds **only from this fork**, through the GitHub Actions workflow, so the
  IPA comes from code he has seen. Never suggest the upstream release IPA.
- Goal: parity with modern native AI iPhone apps. Main use: quickly opening a
  previous chat (often started on desktop) to look something up.
- Working attitude Logan asked for: do not dismiss fixes as impossible because of
  iOS 16. State real limits, keep looking for workarounds ("there's always a way").
  An earlier session wrongly concluded this could not work at all.

## How it works

Injected as `WKUserScript`s at document start, in this order
(`-startLoading` / `-applySettingAndReload` in `ViewController.m`):

| Order | Script | Role |
|---|---|---|
| 1 | settings (inline) | `window.__appSettings` = `{fastLoad, tapFix, pageScale, diagnostics, nativeChrome}` from the app menu |
| 2 | `app-tweaks.js` | Ours. App feel, page size, tap fix, voice patches, WebSocket address fix, debug log and measurements |
| 3 | iOS version (inline) | `window.iosVersion` |
| 4 | custom CSS (document end) | Upstream: hides "Continue with Google" (Google blocks embedded web views) |
| 5 | `legacy-transpiler.js` | Bundle of [mgefimov/legacy-transpiler](https://github.com/mgefimov/legacy-transpiler) 0.1.24 (acorn + astring + transforms) **plus our loader changes** in its `src/index.ts` section |
| 6 | worker source (inline) | Fast loading: transpiler + `transpile-worker.js` as a string, turned into background Workers |
| 7 | `patch.js` | Blocks claude.ai's entry module script, starts the loader, runs each module |
| 8 | PoomSmart Polyfills | Submodule `Polyfills` (pinned commit), injected by `PolyfillsLoader.m`: base scripts plus every version folder newer than the running iOS |

The transpiler parses each ES module with acorn, turns `import`/`export` into
calls on `window.LegacyTranspiler` (`importModule`, `exportModule`,
`onExportsUpdated`), wraps the module in an async IIFE, replaces regex lookbehinds
(unsupported before iOS 16.4) and class static blocks, and prints it with astring.
Results are cached in CacheStorage on claude.ai's origin.

Modules run in one of two ways (`patch.js`):
- **Fast loading (default, round 6):** as an inline `<script>` carrying the page's
  own CSP nonce. No round trip through the app, real error messages, module file
  names in stacks (`//# sourceURL`).
- **Through the app (classic / fallback):** the code is posted to the native
  `patchScript` handler, which runs it with `evaluateJavaScript` (bypasses CSP; all
  errors show as "Script error.").

### Loader (round 6, `legacy-transpiler.js` → "Module loading")
- Classic mode = upstream behaviour (serial, cache `transpiled-v0.1.24`).
- Fast mode: one cache handle; cache `transpiled-fast-v0.1.24-1` with minified
  output; every module starts with `'use strict';\n//@deps ./a.js ./b.js\n` so its
  static imports are fetched as soon as its code is known (`warm()`); cache misses
  are downloaded and transpiled in 2 background Workers (`transpile-worker.js`,
  20 s timeout, page fallback); the modules the last launch used
  (`localStorage.__appModuleManifest`) are read from the cache in parallel at boot;
  after 45 s, caches/entries not used by the last 3 launches
  (`__appModuleHistory`) are deleted. Execution order is unchanged.
- `LegacyTranspiler.stats()` feeds the launch section of the debug log.
- App module store (round 7, iOS 14+): fast mode keeps transpiled modules as
  files in the app's Caches folder (`Library/Caches/transpiled-modules/<cache name>/<sha256 of address>.js`),
  not in claude.ai's CacheStorage. Page side asks the `moduleStore` reply handler
  (`ModuleStore` in `ViewController.m`: get / put / prune, top frame of claude.ai only).
  Boot reads the last launch's manifest 40 modules per request; all reads go through
  a queue (6 at a time): waited-for reads, then launch batches, then head starts.
  First launch moves modules over from the old web cache; housekeeping at 45 s then
  deletes every `transpiled*` web cache (`localStorage.__appStoreMigrated`).
  Without the handler (iOS 13) the web cache is used as before.

## Files

| Path | What |
|---|---|
| `ClaudeLegacy/ChatListViewController.m` | Native chat list and its store (round 13c) |
| `ClaudeLegacy/ViewController.m` | Native shell: web view, edge colour strips, menu, bridge handlers, crash recovery, session cookies, sign-in links, mic permission, debug log |
| `ClaudeLegacy/app-tweaks.js` | Page-side app behaviour and diagnostics (see header comment) |
| `ClaudeLegacy/patch.js` | Entry interception, module running, launch manifest |
| `ClaudeLegacy/legacy-transpiler.js` | Transpiler bundle + our loader (edit the "Module loading" block; the rest is upstream) |
| `ClaudeLegacy/transpile-worker.js` | Worker message handler (joined to the transpiler at runtime) |
| `ClaudeLegacy/SceneDelegate.m` | `claudelegacy://` links |
| `ClaudeLegacy/LoadingOverlayView.m` | Loading / error overlay (normally hidden at launch) |
| `ClaudeLegacy/PolyfillsLoader.m` | Upstream polyfill injection |
| `ClaudeLegacy/Info.plist` | Mic text, `claudelegacy` URL scheme, `UIBackgroundModes: audio` |
| `.github/workflows/build-ipa.yml` | The build (see below) |
| `tools/update.sh` | Logan's one-command update from Git Bash on Windows |
| `tests/` | Node/jsdom tests for the JavaScript: `bash tests/run.sh` |

## Build and install

There is no Mac. **Every native change is first compiled by CI**, so be careful
with Objective-C (method names, types, nullability) — a typo costs Logan a round
trip. Run `bash tests/run.sh` before handing anything over; it also checks bracket
balance in the `.m` files.

**Workflow `build-ipa.yml`** (manual `workflow_dispatch`, `contents: read`,
`macos-15`): actions pinned by SHA, submodules over HTTPS, unsigned
`xcodebuild archive` with build.sh's flags, IPA packaged, then verified (every
`ClaudeLegacy/*.js` byte-identical in the bundle, Polyfills folder identical,
`vtool` minimum OS ≤ 16.3), SHA-256 printed (`IPA SHA-256: …`) and in the run
summary, artifact `ClaudeLegacy-ipa`. Input `runner` (macos-15 default, macos-15-intel, macos-26; macos-14 retired 6 Nov 2026) for when GitHub has no
macos-15 machine free ("not acquired by Runner"): `gh workflow run build-ipa.yml -f runner=macos-15-intel`,
then `bash tools/update.sh --build-only` picks up that run.

**`tools/update.sh`** (Git Bash, from the repo):
`bash tools/update.sh [file.patch]` applies the newest `~/Downloads/claude-legacy-*.patch`
(or reports "already applied"), commits with the Subject line, pushes, starts or
reuses a build (a run whose commit differs only under `tools/` is reused), watches
it, downloads the IPA, checks the SHA-256 against the run log, copies it to the
phone over SSH and installs with `trollstorehelper`. Options: `--build-only`,
`--no-install`, `--rebuild`, `--phone user@address` (saved in
`~/.claude-legacy-phone`; a bare address means `mobile@` with sudo; `root@` runs
without sudo — use it if the phone only accepts Logan's SSH key).

- Commits use the repository-local GitHub no-reply address (set by the script);
  Logan blocked pushes that expose his email. Never commit his personal email.
- Logan said he won't add Claude as a co-author for now: no `Co-Authored-By`
  or other Claude attribution trailers in this repo's commits.
- From Claude Code on his PC you can edit, commit and push directly instead of
  making patch files; the build/install steps of `update.sh` still apply
  (`bash tools/update.sh --build-only`).

## History of changes (rounds)

| Commit | Round | Change |
|---|---|---|
| `1a49481`, `a67e7d2`, `2102cc7` | — | Logan: workflow and upload |
| `b313dda` | 02 | Safe-area layout with native colour strips, no bounce/pull-to-refresh, no zoom, voice log, update script |
| `3fda3ec` | 03 | update.sh: fork targeting, build reuse, no-reply author |
| `9c99976` | 04 | Voice mode works: https→wss WebSocket conversion (Safari 16 throws on https: socket URLs), PCM recording patch |
| `7e8e00c` | 05 | Full-bleed icon (no white flash), launch colours, smoother edge colours, steady composer (overscroll), tap tweaks |
| `332633c` | 06 | Fast loading, launch timeline, sign-in protection, crash reload, bridge security, page size, tap fix |
| `312d524` | 07a | Packs in CacheStorage (failed: quota full) |
| (next) | 07 | Launch: app module store outside claude.ai's storage, batched reads (see Loader) |

### Round 13 (11 Nov 2026) — review, generic native controls
- Direction (Logan): no longer a copy of the Claude iPhone app. Standard iOS chat-app
  controls (UIKit, system colours and tint, SF Symbols), designed without photo
  references; `reference/` is no longer needed.
- `NativeChrome` rebuilt: solid top bar (chat list button, chat title from the page
  title, new chat and "..." in a chat, incognito on a new chat) and solid message bar
  (model button, +, rounded text field that grows, dictate, one send / stop / voice
  button). The bars take the page's edge colours and the page's light/dark, and cover
  claude.ai's header and message box; the page still marks those invisible (12d logic,
  now a second line of defence, not required).
- Launch failures: the error screen is put up when a page load fails with a network
  error or the page reports a fatal error (the overlay is not shown at launch, so this
  used to be a blank screen); Reload loads claude.ai when there is no page to reload.
- Loader: a failed module download is tried again after 1.5 s and 3 s; a module that
  still fails is not marked loaded, so the next import starts over (`downloads retried`,
  `modules not loaded` in the launch section of the log).
- Advanced > Diagnostics (setting `Diagnostics`, default off): page-watching timing,
  frames after taps, long timers, main-thread stalls, typing events and the IndexedDB
  probe only run when on. Turn it on before asking Logan for a timing log.
- One list of injected scripts (`-installUserScripts`).
- Built (`bc74865`, macos-15-intel; macos-15 had no machine free) and installed 11 Nov.
- 13b (log 11 Nov 18:40, Logan: bars appear after ~5 s, come and go, buttons slow):
  - Top-bar search took every button with `top < 60`, so reply toolbars scrolled above
    the screen (top -5404) counted as top bar: they were hidden (also when scrolled back
    into view) and, as the chat re-rendered them, the whole page was searched again at
    every scroll. Now: on screen in the top strip (`top >= -1`, `bottom <= 70`) and
    `pinned()` (outside every scroll area or under a sticky/fixed ancestor); the
    "hidden" log line is written once per search.
  - Bars shown from launch when they were in use last time (`NativeControlsWereReady`),
    buttons off until the page reports; "not ready" on a chat/new page keeps the bars
    (buttons off, 15 s limit) instead of hiding them; other pages hide at once.
  - Top bar height follows claude.ai's own top bar (`topHeight` in the state, 51 CSS px
    = 57 pt at 110 %), tallest seen kept (`NativeTopBarHeight`).
  - Read-ahead list: modules asked for before the send button showed + 0.5 s (min 2.5 s,
    max 10 s) instead of a fixed 2.5 s. After a claude.ai update the launch is slow
    (send button 4.6 s), the fixed cut-off saved 71 of 963 modules, and the next launches
    read the rest one by one (cache reads 38 s summed, send button 3.6 s).
  - Same log: claude.ai now has 963 modules, its code runs 2,555 ms on the main thread
    (was 1,450 ms for 831 on 5 Nov); sign-in cookie still missing at every launch.
- 13c: native chat list (Phase C, first version). Page side: when claude.ai fetches
  `/api/organizations/…/chat_conversations(_vN)`, ids, names and times go to the
  `chatList` handler (no request of the app's own; if none seen after 8 s, the sidebar's
  `aside a[href^="/chat/"]` links, without times). `ChatListStore`
  (`ChatListViewController.m`, new file, added to the Xcode project by hand):
  `Application Support/chat-list.plist`, not backed up, 500 chats, dropped when not
  listed for 14 days; names never logged. The chat list button opens
  `ChatListViewController` (search, New chat, chats, "Claude menu" = claude.ai's sidebar)
  when the store has chats, also while the page loads. Picking a chat: page ready ->
  `openChat` clicks claude.ai's own link (else `location.assign`); not ready -> the
  address is loaded. Limit: only chats claude.ai has listed on this phone.
- 13d: "App settings" row in the native chat list opens the app menu (`-showAppMenu`, also
  still on the three-finger long press); light haptic on send.
- 13b–13d (`d301147`) installed 12–13 Nov. Log 13 Nov 18:57 and Logan's notes: chat list
  got 30 chats from claude.ai's list (shape guess right); top bar found as one group.
  Problems: claude.ai's controls show before / in front of the native ones at launch and
  on chat switches; big empty gap under the last message; start page (greeting, recent
  artifacts) off-centre and running under the message bar; claude.ai's + and model menus
  clipped by the bar; voice mode invisible (it runs in claude.ai's hidden box), then the
  old UI came back; chat list without his sections (pinned, own groups, recents); "App
  settings" row slow to open. Also: page process stopped by iOS with the app open, 46 s
  after launch (memory; cause not known).

### Round 14 (13 Nov 2026) — page ends at the message bar
- No flash: the page's MutationObserver sets the hidden marks in the same turn when the
  controls appear or are replaced (`chromeStale()`), before the screen is drawn; the
  120 ms timer remains for ordinary state changes. While the message box is missing the
  page is not searched for a top bar (3 selectors per change only).
- Page ends at the bar: the storyboard's bottom constraint of the web view is replaced
  (`-takeOverWebViewBottom`, `webBottomConstraint`); the native message bar reports
  80 pt (`onBarInset`) while shown, 0 when hidden. claude.ai's message box is collapsed
  to no height (`data-app-collapsed`) besides being invisible, so messages end right
  above the bar, the start page centres in what is visible, and claude.ai's menus open
  above the bar. The found message box card is kept while it holds the editor and send
  button (collapsed, it cannot be measured again).
- Voice mode / dictation ("takeover"): claude.ai's own message box is shown and the
  native message bar hidden (`composerShown` in the state, top bar stays) from the tap
  until claude.ai's voice / dictate button is back and its box is empty (dictated text
  is sent or cleared there); 5 s limit when it never starts.
- Chat list sections: `chatGroupsFromPage()` reads claude.ai's sidebar (`aside`): small
  text buttons (under 31 px, no label) are headings, `a[href^="/chat/"]` the chats;
  sent as `{groups}` to the `chatList` handler, stored with the chats
  (`chat-list.plist` is now `{chats, groups}`). The list shows those sections in
  claude.ai's order, then "Other chats". If claude.ai changes its sidebar layout the
  list just has no sections. Debug log: `chat list item fields:` (field names of
  claude.ai's list items, to build sections from the data instead, later).
- Chat list rows: a chat / New chat starts at once while the sheet slides away; the two
  menu rows close the sheet without animation first.
- Installed 13 Nov (`1e54f7d`). Logan: no flash, no clipping of claude.ai's menus,
  sections present. Open: "claude.ai's message box is not shown but its presence is
  still there" and the start page's greeting (icon left of the text) off-centre: not
  understood yet, screenshots asked for. Log: list item fields are created_at,
  is_starred, project, name, summary, updated_at, uuid, … (no field for his own groups,
  so sections stay read from the sidebar); "Pinned" holds a code session
  (`/code/project/…`) and an artifact besides chats; dictation's button does not
  change while it runs (takeover ended after 5 s with the socket still open).

### Round 15 (13 Nov 2026) — model menu, dictation, chat list sections
- Native model menu: the model button has a `UIMenu` with an uncached
  `UIDeferredMenuElement`. Page `menuItems("model")`: claude.ai's menu is opened unseen
  (`html.app-menu-quiet` makes `[role=menu]`/`[role=listbox]` transparent, 2.5 s limit),
  its `[role^=menuitem]`/`[role=option]` items read (title, subtitle, checked,
  disabled, submenu), closed with Escape (or a second press of the button); `menuPick`
  opens it unseen again and presses the item (an item with a submenu leaves claude.ai's
  submenu showing). Nothing found -> one entry "Show Claude's menu"; menu will not close
  -> claude.ai's menu shown. Written without seeing claude.ai's menu markup: the log
  line `model menu: N items (roles)` says what was found. + and "..." menus not yet.
- Dictation: running = claude.ai's Dictate button gone or a voice/dictation socket
  open; when it has been idle 0.6 s the dictated text moves to the native message bar
  (`dictated` in the state, once; never logged) and claude.ai's box is emptied.
  Voice mode still shows claude.ai's own voice screen (native skin needs its markup).
- Chat list: sections hold any `/chat/`, `/artifact/`, `/code/`, `/project/` link
  (`{path, name}`, `openPath` action, path checked on both sides); a section claude.ai
  shows closed keeps the items last seen; section headings are buttons that close /
  open the section (`ChatListCollapsedSections`); symbols this iOS has no glyph for
  (newer emoji) are left out of names (`ReadableText`, CoreText last-resort check).
- Not checked on device yet.

### Round 12 (5 Nov 2026) — native controls, stage 1
- Goal (Logan): look and feel of the iPhone app (references: `reference/` in this repo folder, local only and excluded from Git,
  App Store + Mobbin screenshots). Use Apple's own iOS 16 controls (UIKit, SF Symbols, New York
  serif), no liquid-glass imitation; no assets taken from the official app.
- `NativeChrome` (ViewController.m, iOS 15+): round menu button (top left), ghost incognito
  button on new chat or new-chat + "..." pill in a chat (top right), message box card at the
  bottom (text, +, model pill with effort in grey, mic, one action button: voice / send
  (orange) / stop). Follows the keyboard (keyboardLayoutGuide). Touches elsewhere go through.
- Page side (app-tweaks.js "Native controls"): finds claude.ai's header and message box by
  aria-labels, makes them invisible (opacity 0, no touches) but keeps them in place, reports
  state to the `chrome` handler; `window.__appChrome.run(action)` presses claude.ai's buttons
  (its menus open where the native buttons are); send = focus claude.ai's box with
  inputmode none, select all, execCommand insertText, press Send. Anything missing ->
  nothing hidden, native hidden, reason in the debug log (`native controls:` line).
- Advanced menu: "Native controls" switch (setting `NativeControls`, default on).
- 12b (screenshots 6 Nov): works on new chat; in a chat only the left part of claude.ai's
  header was hidden (title and right buttons showed) and the model pill peeked below the card;
  sidebar broken. Now: header = element holding the sidebar button and the top-right buttons,
  message box = element holding editor, send, model and + buttons; sidebar mode (claude.ai UI
  restored, native hidden until closed / chat picked / 30 s) with a diagnostic log line.
  Text in native controls showed in small caps on Logan's phone: the system font seems
  changed by a tweak (status bar too); controls use UIFont systemFont.
- 12c (log 6 Nov 13:24): the "header" hidden was `aside.dframe-sidebar` (32x32): claude.ai's
  "Show sidebar" button lives in the collapsed sidebar panel, so the panel was made invisible
  (sidebar broken) and the real top bar stayed. Now: top bar = element holding the buttons at
  the top outside `aside` (title, More options, LoganPC, Activity, share; incognito on new
  chat); the sidebar button alone is hidden, never the panel. Found controls kept per address
  (taps had slowed to a 228 ms median with the page searched after every change).
  Small caps in native text was the A-Font tweak (now disabled for the app).
- 12d (log 6 Nov 13:39): in a chat "missing header" (top bar buttons sit in different parts
  of the layout, no small common box), so claude.ai's own controls showed. Now each top-bar
  group is hidden on its own (never past an element holding the sidebar `aside`), the top bar
  is not required, and hidden marks are only touched when they change.
- 12e (Phase A): send pastes the text into claude.ai's empty box (ClipboardEvent + DataTransfer,
  no focus, so the app's keyboard stays); typed fallback for text over 2000 characters, a
  non-empty box or no clipboard support (log: `send (pasted|typed)`). Keyboard room: on
  UIKeyboardWillChangeFrame while the native box is editing, the page gets padding at the end
  of its message list (`keyboard` action, points converted to CSS px) and stays at the end.
- Not yet native: the + / model / chat menus (claude.ai's web menus open), sidebar, messages.

### Round 11 (5 Nov 2026) — launch freezes
- Log 10: main thread blocked 1.2 s at 0.0 s, 0.6 s at 1.5 s, 0.9 s at 3.4 s.
- Workers start at the first module that needs transpiling (none on most launches)
  instead of at init; no per-module console logs in fast mode (thousands per launch).
- Debug log `main thread:` line: when the app scripts ran, claude.ai module code count
  and total run time, longest module, and how many ran in one go when parsing ended.
- Result (log 11, 18:29): app scripts 4–13 ms (not the cause); claude.ai module code
  831 modules in 1,436 ms on the main thread (longest 56 ms), only 1 at parse end, so
  the 1.2 s block at 0.0 s is claude.ai's boot code being compiled and run, chained
  through promise callbacks without a break. Send button 2.0–2.3 s; API calls start at
  1.1 s once that code has run. Floor for this design: inline scripts get no bytecode
  cache. Bigger gains would need native module loading (import maps are iOS 16.4+, so
  not available) or the native chat list from the UI strategy.

### Round 10 (5 Nov 2026)
- Log 9 storage report: `Library/Caches/WebKit/CacheStorage` 1,996 MB although claude.ai
  has 0 web caches: the old transpiled caches, deleted while the networking process kept
  crashing, left their files. That fills the origin quota (IndexedDB probe:
  QuotaExceededError). NetworkCache 850 MB (WebKit HTTP cache, outside the quota),
  module store 43 MB, WebsiteData (IndexedDB, local storage) 9 MB.
- Fix: `-clearLeftoverWebCachesIfLarge` at launch: CacheStorage folder > 100 MB ->
  `removeDataOfTypes:{WKWebsiteDataTypeFetchCache}` (web caches only), logged as an app event.
- Chat open (log 9): the ~1 s wait was one new module being transpiled (1,032 ms); later
  opens use the store. Idea for later: transpile direct dynamic imports in idle time.
- Result (log 10, 18:18): "web cache storage cleared: 1996 MB before, 0 MB left, took
  4.3 s"; IndexedDB probe ok; all 14 launch API calls 200; read-ahead 346 modules (9
  batches, was 800); send button 2.0 s. Still: main thread blocked 1.2 s at 0.0 s,
  0.6 s at 1.5 s, 0.9 s at 3.4 s; sign-in cookie missing at every launch (restored by
  the app); NetworkCache 850 MB (WebKit-managed, outside the quota).

### Round 09 (5 Nov 2026)
- Debug log: `storage on disk` (native: Library/WebKit and Library/Caches folders of
  0.5 MB or more, 4 levels) to find what fills claude.ai's quota; page side lists
  IndexedDB names/versions, web cache names, local storage size.
- Chat opens: modules loaded between tap and data (transpiled, slowest wait) and
  main-thread time blocked in that window.
- Read-ahead cut-off `BOOT_MS` 6000 -> 2500 ms.

### Round 08b (5 Nov 2026) — networking process crash found
- Phone crash reports (`/var/mobile/Library/Logs/CrashReporter`): 15 of 15
  `com.apple.WebKit.Networking` crashes on 5 Nov (first 13:39) are the same:
  EXC_BREAKPOINT in `WebCore::IDBServer::UniqueIDBDatabaseTransaction::commit`
  (thread com.apple.WebKit.Storage). claude.ai calls `IDBTransaction.commit()`;
  WebKit 16.3 asserts. The crash ~0.4 s after the page is usable explains, in one:
  "Load failed" requests, "Connection to Indexed Database server lost", claude.ai
  without persisted state, likely the send button only after Return (composer draft
  in IndexedDB) and possibly sign-outs.
- Fix: `app-tweaks.js` makes `IDBTransaction.prototype.commit` a no-op (a
  transaction commits by itself once it has no requests left); count in the log.
- Also: app crash 13:28 = camera access without `NSCameraUsageDescription`; added.
- Result (log 8, 18:03, round 8b on macos-14): 12 commit() calls skipped; no failed
  requests (all 14 launch calls 200), no IndexedDB "state read rejected", send button
  shows after the first keystroke. New: the app's probe database got QuotaExceededError
  ("not enough space for domain") while claude.ai's 3 databases work, so claude.ai's
  storage is near its quota. Chat open: address +62 ms, data +1469 ms but the request
  itself 372 ms (about 1.1 s before it starts), settled +2.2 s. Main thread blocked 1.2 s
  at start and 0.5–1.0 s at 11–17 s. Read-ahead still 800 modules: claude.ai asks for
  ~800 within 6 s, so BOOT_MS 6000 does not trim it.
- Crash reports can be pulled with: `scp "root@<phone>:/var/mobile/Library/Logs/CrashReporter/*<date>*" <folder>`.

### Round 08 (5 Nov 2026)
- Log 6 (Logan: complete after 4–5 s with layout jumping, send button only after
  Return, sidebar slow, chat switch slow / sometimes 2 taps, edge strips flash on
  chat change): boot read all 800 stored modules (40 MB, batches done at 7.2 s);
  273 new modules transpiled on first chat opens; 1 of 10 chat-list taps no click.
- Read ahead only modules asked for in the first 6 s (`usedModules(BOOT_MS)`); the
  rest is read from the store on demand.
- Edge colours: a new colour is sent only when a second sample 120 ms later agrees.
- Diagnostics: plain objects in warnings show error fields (was "[object Object]");
  failed requests logged with error, cancelled?, store requests open; composer event
  kinds vs send-button state (no text); IndexedDB probe at 3 s; chat-open data
  detection also matches `chat_conversations_v2`.

### Round 07 (5 Nov 2026)
- Log 1 (31 Oct, round 06): 705 modules all from cache, first module 5.0 s, last 9.6 s.
- 07a (packs in CacheStorage), log 2: storage quota full — 172 cache saves failed,
  pack build QuotaExceededError, claude.ai's own IndexedDB read rejected; opening the
  cache took 5.5 s and the entry module was ready right after (5.7 s). claude.ai had
  updated (243 modules transpiled). So the web cache itself was the bottleneck.
- Fix: app module store (Loader). Debug log `storage:` line: app files / web cache,
  entry code ready, batches, modules moved, store size, errors.
- First launch after installing moves modules over and frees the web storage at 45 s;
  the gain shows from the second launch.
- 7b second launch (log 4): entry code ready 0.1 s (was 5.7 s), all 262 modules from
  the store, last module 1.0 s; but claude.ai failed ("Root element #root not found"):
  modules ran before the HTML was parsed (1.1 s). 7c: `patch.js` holds module runs
  until DOMContentLoaded, as a browser does for module scripts. (`ranAt` in the log is
  when a module was handed over, not when it ran.)
- 7c result (log 5, 5 Nov 16:28): page works; send button 2.1 s (was 7.2–7.8 s), entry
  code 0.1 s, 804 modules all from the store, none transpiled. Still seen: 4 API calls
  "Load failed" (plugins, marketplaces, discoverable, subscription_details; also in the
  7b first launch, not before 7b), IndexedDB state read rejected + uncaught
  TransactionInactiveError (IDBCursor.continue), main thread blocked 1.2 s at 0.0 s.

### Round 06 (30 Oct 2026)
- Fast loading (loader above) with in-page nonce execution; Advanced menu toggle.
- Debug log: launch timeline (modules, cache hits/misses, transpile/download time,
  interactive time = React owns the message box, send button time, API calls at
  launch, timers ≥ 2 s with caller, main-thread stalls), taps without a click,
  chat-open timings (address → data → screen settled), long-press info, page
  hidden/visible with mic/audio/socket state, on-screen controls and sizes.
- Persistent **app event log** (NSUserDefaults `AppEventLog`, 200 lines) shown at
  the top of the copied log: launches, background/foreground, page process
  stopped, reloads, sign-in cookie changes (fingerprint only), refused API
  requests (401/403 + error code), sign-outs.
- Sign-in cookie protection: WebKit cookie flush (private
  `_flushCookiesToDiskWithCompletionHandler:`, guarded) on change and on going to
  the background; app copy of claude.ai's persistent cookies
  (`Application Support/session-cookies.plist`, CompleteUntilFirstUserAuthentication,
  excluded from backup) restored at launch when missing or older.
- Sign-in links: "Open copied link" menu item, offer on sign-in pages when a link
  is on the clipboard, `claudelegacy://` scheme. Every link is shown and needs a tap;
  only `https://claude.ai` addresses. Verification itself is never automated.
- Page process killed by iOS: reload in place (same chat); error screen only after
  3 stops in 90 s, and its Continue reloads.
- Bridge security fix and mic scope fix (see Security).
- Page size 100 / 110 (default) / 118 % via the viewport (narrower layout width,
  zoomed to fit; no claude.ai selectors).
- Tap fix: WebKit's pretend mouse events after a touch are kept from the page for
  1 s, so hover reveals cannot swallow the click (suspected sidebar cause). Toggle.
- Long-press: link callout restored (round 02 CSS had disabled it), message text
  selectable (`.font-claude-response`, `.font-user-message`, `[data-testid=user-message]`).
- Artifact/Doc pages: `frame-shell-*.js` entry now intercepted (any module script
  from the asset host). The document itself still runs in a cross-origin frame
  (see open items).
- `UIBackgroundModes: audio` for voice in the background (effect unverified).
- update.sh `--phone`; tests added to the repo.

## Measurements and facts (Oct 2026)

- claude.ai startup graph: `index-*.js` + static imports = **75 modules,
  18.6 MB** minified source → 27.1 MB transpiled (22.2 MB minified). Full transpile
  of those took **6.2 s on a desktop CPU** (Chromium); expect more on the phone.
  A 580 KB module ≈ 0.2 s. The whole reachable graph is ~3,500 files / 128 MB.
- Only 20 of the 75 contain regex lookbehind and 2 contain static blocks — the
  syntax 16.3 cannot parse — but every module needs the import/export rewrite in
  the current design.
- claude.ai CSP: `script-src 'nonce-…' 'strict-dynamic'` + hashes +
  `'wasm-unsafe-eval'` (no `unsafe-eval`); `worker-src 'self' blob: assets.claude.ai
  assets-proxy.anthropic.com s-cdn.anthropic.com`; no `connect-src`/`default-src`.
  Nonce'd inline scripts and blob Workers were verified to run under this policy
  (desktop Chromium); worker output is byte-identical to page output.
- Before round 06: `patch.js`'s fetch wrapper never ran (the transpiler's
  `patchFetch` makes `window.fetch` a getter that ignores assignment).
- Artifact URL `claude.ai/artifact/<id>`: HTML shell, entry `frame-shell-*.js`
  (imports `preload-helper`, `shared-frame-boot`), document rendered in an iframe
  at `<uuid>.frame.claudeusercontent.com` (also `<uuid>-top.frame…`).
- Involuntary sign-out: after an API request is refused as an auth error (with
  "settle" retries), claude.ai goes to `/logout?involuntary=1&returnTo=/login?from=logout&reauth=1…`.
  So a sign-out means the server refused the session: cookie missing/stale or
  session revoked. The round 06 event log tells these apart.
- Voice: module `c3e5e55a7-*.js` (name changes per build) does not end the session
  on `visibilitychange`; it detects a system-muted mic and sleep. Background stop is
  WebKit/iOS suspending the page and muting capture.
- claude.ai uses Base UI context menus (long-press, inline `WebkitTouchCallout:none`).
- Voice availability hook needs getUserMedia and (AudioEncoder + MediaStreamTrackProcessor
  or MediaRecorder webm/opus); round 04 patches force it on and switch to PCM.

## Security notes

Reviewed: `ViewController.m`, `patch.js`, the transpiler's own transforms and
loader, the Polyfills files loaded on 16.3. acorn, astring, pako and the Temporal
polyfill bundled in the transpiler were only scanned (well-known libraries).
The app's code only contacts `claude.ai` and `assets-proxy.anthropic.com`; no
analytics of its own (claude.ai itself runs Datadog RUM).

- **Fixed in 06 — bridge open to every frame.** `window.webkit.messageHandlers`
  exists in all frames, including embedded third-party and user-generated content
  (artifacts, previews, videos). `patchScript` runs code in the main page, so any
  embedded frame could have run code with the signed-in claude.ai session. Now
  every handler accepts messages only from the top frame of `https://claude.ai`.
- **Fixed in 06 — microphone auto-grant** covered every `*.claude.ai` subdomain and
  any frame; now only `claude.ai`'s top frame (others denied).
- Residual: transpiled code lives in claude.ai's CacheStorage; code running on
  claude.ai could tamper with it and persist across launches. Only claude.ai's own
  origin can write there.
- Session copy (06) is stored with the same protection class iOS uses for
  WebKit's own cookie file, never logged (fingerprints only), not backed up.
- Private API use: the cookie flush selector only (guarded by `respondsToSelector:`).
- Debug log: no message content, ids shortened, socket tickets never logged.

## Logan's requirements to keep

- When a sign-out happens he wants to go through claude.ai's **normal email
  verification manually**, for security. Do not bypass or automate it; only make
  that normal flow work on iOS 16.3.1 (link opened inside the app, or a Safari-side
  fix via his own jailbreak tweak suite, Snap).
- Keep account access minimal: no connectors that alter data behind his logins.
- Before blaming an outside party (claude.ai, Apple, an ISP), rule out causes on
  this app's side first.
- Metric units. Commands for him: one line each, labelled "PowerShell (PC)" or
  "phone SSH"; the phone shell is zsh without awk/pkill; multi-line pastes over SSH
  get mangled.
- He doesn't want to read long explanations: lead with the decision or the steps.
- He has a personal brace/indent style; match the file you are in and ask before
  reformatting.

## Decisions (30 Oct 2026)

- **Patch vs rebuild:** rebuild in place. Keep the transpiler transforms, acorn/
  astring and the Polyfills as pinned, reviewed dependencies; own and rewrite
  everything around them (native shell, loader — done). A from-scratch rebuild
  would recreate the same three pieces. Revisit only if measurements show the
  transpile design itself is the bottleneck (then: text-level patching of only the
  modules that need it + native module loading).
- **UI strategy (recommended, Logan to confirm):** layered — (1) selector-free
  global changes (page size, tap fix) done; (2) targeted touch-ups keyed on
  `aria-label` / `data-testid` that fail soft when claude.ai changes; (3) a native
  chat list + read-only chat viewer for instant look-ups while claude.ai loads;
  no full redesign of claude.ai's UI.

## Roadmap (6 Nov 2026, agreed with Logan)

Route: rebuild in place, layered. claude.ai's web app stays the engine (runtime
transpile + polyfills); the app owns the shell, loading, storage, diagnostics, and
draws standard iOS 16 controls (UIKit, system colours, SF Symbols; generic chat-app
design since round 13, not a copy of the Claude iPhone app) that drive
claude.ai's controls underneath and fall back to claude.ai's own UI when a control is
not found. Rejected: own client on claude.ai's private API (fragile, account risk),
decompiling the official app (not decryptable on 16.3, terms and font licences),
native module loading (needs import maps, iOS 16.4+), liquid glass (iOS 26 only).

Scores (estimates, ISO/IEC 25010, official app = 10): before 30 Oct / now / target.
Usability 3/4/8 · Performance 2/6/7-8 · Reliability 3/7/8 · Functional completeness
6/8/8-9 · Compatibility 6/8/8 · Security 5/8/8 · Maintainability 4/6/7.

| Phase | Work | Status |
|---|---|---|
| A | Native controls stage 1: verify on device, keep the last message clear of the native box, keyboard stays after sending | In progress (round 13 generic bars built on 12e, awaiting device check) |
| B | Native menus: +, model, chat "..." as UIMenu filled from claude.ai's options | Next (round 14 only stops the bar clipping claude.ai's menus) |
| C | Native chat list: cached on the phone (instant at launch), search | First version built (13c), awaiting device check |
| D | Message styling: user bubble, serif replies, spacing, reply toolbar, scroll-down button | Planned |
| E | Polish: haptics, edge swipe for the chat list, long-press menus, sheets for artifacts/files | Planned |
| F | Reliability: why WebKit drops the sign-in cookie; alarm when claude.ai renames a label we use | Planned |

Maybe: launch snapshot; background transpile of likely-needed modules; artifact/doc
frames compatibility; read-only offline chat viewer; local notification when a reply
finishes in the background; split ViewController.m / app-tweaks.js.
Not possible / not doing: Anthropic push notifications, liquid glass, official fonts
and icons, the official app's widgets/Siri/Shortcuts.

## Open items

| Item | Status |
|---|---|
| Launch (send button) 7.2 s → 2.1 s | Done in 07c. Next: the 1.2 s main-thread block at start (transpiler + worker source parsed every launch even when nothing needs transpiling?) |
| 4 API calls fail "Load failed" since 07b | Open. Rule out the app first (reply handler, module timing) before blaming claude.ai |
| claude.ai IndexedDB read rejected | Still after the web caches were deleted, so maybe not the quota. TransactionInactiveError suggests transaction timing (async IIFE wrapping / polyfills); investigate |
| Sign-in cookie missing at every launch | App copy restores it each time; find why WebKit drops it |
| claude.ai storage full (log 2) | 07 moves transpiled code out and deletes the web caches; check claude.ai's IndexedDB warning is gone |
| Send button / mic / chats appear late | Same as above (they appear when React hydrates); native chat list would bypass it |
| Sidebar taps sometimes do nothing | 06 tap fix + "taps without a click" counter. Confirm with the log; if misses remain, look at the logged targets |
| Chat switch ~2 s | 06 logs address/data/settled times; decide between API and rendering |
| Bigger controls | 06 page size 110 %. Next: per-control sizing from the "on screen now" list |
| Random sign-outs (high priority) | 06 cookie flush + copy + event log. Check the log after the next sign-out: cookie present when refused → server side; missing → client side |
| Re-login verification opens in Safari | 06 copied-link flow, `claudelegacy://` + Safari bookmarklet; optional Snap tweak redirect later |
| Voice stops when locked / app switched | 06 background audio mode + logging. If the mic is muted while hidden, look at WebKit's capture-interruption settings |
| Memory error, dead Continue | 06 automatic reload |
| Artifact / Doc links "browser not supported" | 06 covers the shell only. Next: inject the compatibility layer into `*.frame.claudeusercontent.com` frames (user scripts with `forMainFrameOnly:NO`, host-guarded; evaluate with `evaluateJavaScript:inFrame:` or in-frame nonce; separate, narrower bridge for those frames) |
| Long-press copy | 06 restores link menu and text selection; confirm on device |

## Sign-in bookmarklet (Safari)

Add a bookmark in Safari, edit it, set its address to:

```
javascript:location.href='claudelegacy://'+location.host+location.pathname+location.search+location.hash
```

When claude.ai's email link opens in Safari and fails, open Bookmarks and tap it:
the app opens and asks before loading the same claude.ai address.

## Docs

- Phone crash logs Logan copies over go in `phone-logs/` (local only, excluded from Git).
- Improvement brief (Logan's requirements, 30 Oct 2026):
  https://claude.ai/artifact/3nmgWJ7EAbMikizsDSEx9Y
