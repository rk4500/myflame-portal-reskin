// Frida agent injected into com.myflame's WebView by the embedded gadget.
//
// DO NOT EDIT .patch-tools/hook.js — it is generated. This file is the
// source; `npm run build` (from the repo root) fuses it with the freshly
// built portal-reskin.user.js, replacing the __USERSCRIPT__ placeholder
// below with that file as a JSON string literal.
//
// Build sequence for an APK, from .patch-tools/:
//   (repo root) npm run build
//   npx --prefix /home/archer frida-compile hook.js -o hook.compiled.js -T none
//   objection patchapk -s flame-merged.apk -a arm64-v8a \
//       -c gadget-config.json -l hook.compiled.js -j 1
//
// The `import` on the next line must stay ES syntax. A CJS require() gets
// frida-compile's interop wrong and hands back the module wrapper instead
// of the bridge, leaving Java.perform undefined with no error — see
// HANDOFF.md, "Android patch — RESOLVED".

import Java from 'frida-java-bridge';

var __nlog = null;
try {
  var __liblog = Process.getModuleByName('liblog.so');
  var __alp = new NativeFunction(__liblog.getExportByName('__android_log_print'), 'int', ['int', 'pointer', 'pointer']);
  var __tagBuf = Memory.allocUtf8String('FlameInjectNative');
  __nlog = function (msg) {
    try {
      var m = Memory.allocUtf8String(String(msg));
      __alp(3, __tagBuf, m);
    } catch (e) {}
  };
} catch (e) {}
if (__nlog) __nlog('CHECKPOINT-A: script executing, Java required OK, typeof Java=' + typeof Java);
if (__nlog) __nlog('CHECKPOINT-A2: typeof Java.perform=' + typeof Java.perform + ', typeof Java.available=' + typeof Java.available);

try {
  if (__nlog) __nlog('CHECKPOINT-A3: about to call Java.available getter');
  var __avail = Java.available;
  if (__nlog) __nlog('CHECKPOINT-A4: Java.available=' + __avail);
} catch (e) {
  if (__nlog) __nlog('CHECKPOINT-A4-ERROR: Java.available getter threw: ' + e + ' | ' + (e && e.stack));
}

try {
  if (__nlog) __nlog('CHECKPOINT-A5: about to call Java.perform()');
  Java.perform(function () {
    if (__nlog) __nlog('CHECKPOINT-B: inside Java.perform callback');
    var TAG = '[flame-inject]';
  var AndroidLog = null;
  try { AndroidLog = Java.use('android.util.Log'); } catch (e) {}
  function log(msg) {
    try { console.log(msg); } catch (e) {}
    try { if (AndroidLog) AndroidLog.d('FlameInject', msg); } catch (e) {}
  }
  var SCRIPT = "__USERSCRIPT__";

  var DARK_BG = 0xFF11131A | 0; // matches reskin's --bg; |0 forces signed 32-bit int (Java's int is signed, this value overflows unsigned)

  function resolveActivity(view) {
    var ctx = view.getContext();
    var Activity = Java.use('android.app.Activity');
    var ContextWrapper = Java.use('android.content.ContextWrapper');
    var activity = null;
    var cur = ctx;
    for (var i = 0; i < 10 && cur; i++) {
      try {
        activity = Java.cast(cur, Activity);
        break;
      } catch (e) {
        try {
          var wrapper = Java.cast(cur, ContextWrapper);
          cur = wrapper.getBaseContext();
        } catch (e2) {
          cur = null;
        }
      }
    }
    return activity;
  }

  // window.setStatusBarColor() is a documented no-op on this device
  // (targetSdk 36, Android enforces edge-to-edge for 35+ with no opt-out) —
  // confirmed via live testing, the call succeeds but paints nothing. Instead
  // of fighting that deprecated API, paint a real opaque View over the status
  // bar's inset area directly, as a sibling in the DecorView. This bypasses
  // the deprecation entirely since it's not a system color API at all — the
  // same technique modern edge-to-edge-aware apps use themselves. Deliberately
  // does NOT touch the navigation bar — that's already the correct color on
  // its own, no need to risk it.
  function paintStatusBarOverlay(activity) {
    Java.scheduleOnMainThread(function () {
      try {
        var window = activity.getWindow();
        var decorView = window.getDecorView();

        var insetsController = decorView.getWindowInsetsController();
        if (insetsController) {
          // 8 = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS; not deprecated, still works
          insetsController.setSystemBarsAppearance(0, 8);
        }

        var View = Java.use('android.view.View');
        var FrameLayout = Java.use('android.widget.FrameLayout');
        var FrameLayoutParams = Java.use('android.widget.FrameLayout$LayoutParams');
        var decorViewGroup = Java.cast(decorView, FrameLayout);

        if (decorViewGroup.findViewWithTag('FLAME_STATUS_BAR_OVERLAY') !== null) {
          return; // already painted, avoid stacking duplicate views
        }

        var statusBarHeight = 0;
        var insets = decorView.getRootWindowInsets();
        if (insets !== null) {
          var WindowInsetsType = Java.use('android.view.WindowInsets$Type');
          var t = WindowInsetsType.statusBars();
          statusBarHeight = insets.getInsets(t).top.value;
        }
        if (statusBarHeight === 0) {
          var res = activity.getResources();
          var resId = res.getIdentifier('status_bar_height', 'dimen', 'android');
          if (resId > 0) statusBarHeight = res.getDimensionPixelSize(resId);
        }

        if (statusBarHeight > 0) {
          var params = FrameLayoutParams.$new(-1, statusBarHeight); // -1 = MATCH_PARENT width
          params.gravity.value = 48; // Gravity.TOP
          var overlay = View.$new(activity.getApplicationContext());
          overlay.setBackgroundColor(DARK_BG);
          overlay.setTag('FLAME_STATUS_BAR_OVERLAY');
          decorViewGroup.addView(overlay, params);
          log(TAG + ' status bar overlay painted, height=' + statusBarHeight);
        } else {
          log(TAG + ' status bar overlay: could not determine height');
        }
      } catch (e) {
        log(TAG + ' paintStatusBarOverlay UI-thread error: ' + e);
      }
    });
  }

  function recolorStatusBar(view) {
    var activity = resolveActivity(view);
    if (!activity) {
      log(TAG + ' recolorStatusBar: could not resolve Activity from WebView context');
      return;
    }
    paintStatusBarOverlay(activity);
  }

  // The reskin's own bottom nav bar (portal-reskin.user.js's .fr-nav) needs
  // enough bottom padding to avoid being overlapped by the system navigation
  // bar under edge-to-edge — env(safe-area-inset-bottom) isn't reliably
  // populated by this WebView, so measure the real inset natively (same
  // technique as the status bar height) and push it into the page as a CSS
  // variable override.
  function pushNavBarInset(view) {
    var activity = resolveActivity(view);
    if (!activity) return;
    // `view` is only valid for the synchronous duration of this hook call —
    // Java.scheduleOnMainThread's callback runs later, after the hook has
    // returned, so the raw hook-argument wrapper would already be disposed
    // by then. Java.retain() makes a long-lived wrapper safe to use async.
    var retainedView = Java.retain(view);
    Java.scheduleOnMainThread(function () {
      try {
        var window = activity.getWindow();
        var decorView = window.getDecorView();
        var navBarHeightPx = 0;
        var insets = decorView.getRootWindowInsets();
        if (insets !== null) {
          var WindowInsetsType = Java.use('android.view.WindowInsets$Type');
          var t = WindowInsetsType.navigationBars();
          navBarHeightPx = insets.getInsets(t).bottom.value;
        }
        if (navBarHeightPx === 0) {
          var res = activity.getResources();
          var resId = res.getIdentifier('navigation_bar_height', 'dimen', 'android');
          if (resId > 0) navBarHeightPx = res.getDimensionPixelSize(resId);
        }
        var js = "document.documentElement.style.setProperty('--flame-navbar-inset', (" +
          navBarHeightPx + " / (window.devicePixelRatio||1)) + 'px');";
        retainedView.evaluateJavascript(js, null);
        log(TAG + ' navbar inset pushed: ' + navBarHeightPx + 'px device');
      } catch (e) {
        log(TAG + ' pushNavBarInset error: ' + e);
      }
    });
  }

  // Boot cover: a plain opaque View laid over everything until the reskin
  // has painted.
  //
  // The three CSS attempts before this all lost the same way. A style
  // injected into the document is only as durable as the document, and
  // during boot there are three of them: the SSO bounce page, the copy of
  // it that rewrites itself to show Salesforce's own "Loading..." card
  // (this is the one that wipes <head>, taking the style with it), and
  // finally /s/. Re-applying on a timer only ever shortens the flash to
  // the length of one tick; it cannot remove it, because the wipe and the
  // repair are always in that order.
  //
  // So do it where setBackgroundColor already works: natively, above the
  // WebView, where no document can reach it. The page underneath loads
  // completely and normally the whole time — nothing is blocked, delayed
  // or suppressed, it simply is not on screen yet. That also keeps the
  // stock UI genuinely available: it is fully loaded behind the cover, so
  // long-pressing Home later shows a live page, not a blank one.
  var COVER_TAG = 'FLAME_BOOT_COVER';
  var ACCENT = 0xFF5B8CFF | 0; // matches the reskin's --accent

  // Absolute backstop. If the reskin never arrives — a hook that silently
  // failed, a login page, a portal outage — the cover must not strand the
  // app behind an opaque view forever.
  var COVER_MAX_MS = 15000;
  var coverShownAt = 0;

  function showBootCover(view) {
    var retained = Java.retain(view);
    Java.scheduleOnMainThread(function () {
      try {
        var activity = resolveActivity(retained);
        if (!activity) {
          log(TAG + ' cover: no activity');
          return;
        }
        var decorView = activity.getWindow().getDecorView();
        var FrameLayout = Java.use('android.widget.FrameLayout');
        var FrameLayoutParams = Java.use('android.widget.FrameLayout$LayoutParams');
        var group = Java.cast(decorView, FrameLayout);
        if (group.findViewWithTag(COVER_TAG) !== null) return;

        var ctx = activity.getApplicationContext();
        var cover = FrameLayout.$new(ctx);
        cover.setBackgroundColor(DARK_BG);
        cover.setTag(COVER_TAG);
        // Swallow touches: the portal is live underneath, and a tap that
        // lands on a control the user cannot see is worse than no tap.
        cover.setClickable(true);
        try {
          // Indeterminate spinner, tinted to the reskin's accent, so the
          // wait reads as this app loading rather than a dark rectangle.
          var ProgressBar = Java.use('android.widget.ProgressBar');
          var ColorStateList = Java.use('android.content.res.ColorStateList');
          var spinner = ProgressBar.$new(ctx);
          spinner.setIndeterminate(true);
          spinner.setIndeterminateTintList(ColorStateList.valueOf(ACCENT));
          var slp = FrameLayoutParams.$new(-2, -2); // WRAP_CONTENT
          slp.gravity.value = 17;                   // Gravity.CENTER
          cover.addView(spinner, slp);
        } catch (e) {
          log(TAG + ' spinner unavailable (cover still shown): ' + e);
        }
        // -1/-1 = MATCH_PARENT: the whole window, including under the
        // system bars, since the app is edge-to-edge.
        group.addView(cover, FrameLayoutParams.$new(-1, -1));
        coverShownAt = Date.now();
        log(TAG + ' boot cover shown');
        setTimeout(function () { hideBootCover(retained, 'timeout'); }, COVER_MAX_MS);
      } catch (e) {
        log(TAG + ' showBootCover error: ' + e);
      }
    });
  }

  function hideBootCover(view, why) {
    var retained = Java.retain(view);
    Java.scheduleOnMainThread(function () {
      try {
        var activity = resolveActivity(retained);
        if (!activity) return;
        var FrameLayout = Java.use('android.widget.FrameLayout');
        var group = Java.cast(activity.getWindow().getDecorView(), FrameLayout);
        var cover = group.findViewWithTag(COVER_TAG);
        if (cover === null) return;
        group.removeView(cover);
        log(TAG + ' boot cover removed (' + why + ', ' + (Date.now() - coverShownAt) + 'ms)');
      } catch (e) {
        log(TAG + ' hideBootCover error: ' + e);
      }
    });
  }

  // Reveal as soon as the reskin's own root is in the document — the shell
  // paints immediately, well before its data arrives, so this is about one
  // frame after injection. A handful of checks, not a polling loop: the
  // cover is already correct, this only decides when to drop it.
  var REVEAL_CHECK_MS = 50;
  var REVEAL_MAX_CHECKS = 40;

  var RevealCallback = null;
  var revealHandler = function () {};
  function revealCallback(onValue) {
    revealHandler = onValue;
    try {
      if (RevealCallback === null) {
        RevealCallback = Java.registerClass({
          name: 'com.flame.inject.RevealCb',
          implements: [Java.use('android.webkit.ValueCallback')],
          methods: {
            onReceiveValue: function (value) {
              try { revealHandler(String(value)); } catch (e) {}
            },
          },
        });
      }
      if (RevealCallback === false) return null;
      return RevealCallback.$new();
    } catch (e) {
      // Silent failure here is what made the cover hang with an empty
      // log — evaluateJavascript(js, null) then reports nothing at all.
      log(TAG + ' reveal callback unavailable: ' + e);
      RevealCallback = false;
      return null;
    }
  }

  // "The root element exists" is not "the root element is on screen", and
  // uncovering on existence alone let one frame of Salesforce white
  // through. The obvious fix — two nested requestAnimationFrames, the
  // standard way to wait for a paint — does not work here and made the
  // cover hang: an opaque native View over the WebView means Android can
  // skip drawing it, so there are no frames, so rAF never fires. The
  // reveal was waiting on a paint the cover itself was preventing.
  //
  // So: existence, plus a fixed grace below. It cannot deadlock, because
  // nothing about it depends on the WebView being drawn.
  var REVEAL_JS =
    "(function(){try{" +
    "if(document.getElementById('flame-reskin-root'))return 'ready';" +
    "if(document.body&&document.body.classList.contains('flame-reskin-off'))return 'stock';" +
    "return 'waiting';" +
    "}catch(e){return 'ready';}})();";

  function revealWhenReskinPaints(view) {
    var retained = Java.retain(view);
    var checks = 0;
    var timer = setInterval(function () {
      checks++;
      if (checks > REVEAL_MAX_CHECKS) {
        clearInterval(timer);
        log(TAG + ' reveal gave up after ' + checks + ' checks');
        hideBootCover(retained, 'gave up');
        return;
      }
      try {
        Java.scheduleOnMainThread(function () {
          try {
            retained.evaluateJavascript(REVEAL_JS, revealCallback(function (status) {
              if (status.indexOf('ready') === -1 && status.indexOf('stock') === -1) return;
              clearInterval(timer);
              hideBootCover(retained, status.replace(/"/g, ''));
            }));
          } catch (e) {}
        });
      } catch (e) {}
    }, REVEAL_CHECK_MS);
  }

  // The reskin goes in as early as the document allows, not at
  // onPageFinished. Measured across three launches, onPageStarted on /s/
  // fires 1.38-1.64s earlier, and the instrumented run showed that
  // document is the final one: a style attached at onPageStarted survived
  // loading -> interactive -> complete without being replaced.
  //
  // Injecting earlier also puts our fetch/XHR hooks in place before Aura
  // makes its own first request (0.297s after the document loads, per the
  // HAR), which is where the aura token comes from — today we arrive
  // after it and have to wait for the next one.
  //
  // Deliberately /s/ only. frontdoor.jsp rewrites its own document, so
  // anything injected there is discarded; it is also the page whose
  // missing viewport meta once produced a desktop-layout flash.
  // Temporary: dumps the page's flame-token-log (see src/aura.js) to a
  // plain file on every page load, so the token-longevity test can be read
  // back with a single `adb pull` after a long idle gap, with no live
  // Frida attach needed — the production gadget runs autostart/script
  // mode, which doesn't listen for one. Drop this whole block once the
  // token question is settled.
  var TokenLogCallback = null;
  var tokenLogHandler = function () {};
  function tokenLogCallback(onValue) {
    tokenLogHandler = onValue;
    try {
      if (TokenLogCallback === null) {
        TokenLogCallback = Java.registerClass({
          name: 'com.flame.inject.TokenLogCb',
          implements: [Java.use('android.webkit.ValueCallback')],
          methods: {
            onReceiveValue: function (value) {
              try { tokenLogHandler(String(value)); } catch (e) {}
            },
          },
        });
      }
      if (TokenLogCallback === false) return null;
      return TokenLogCallback.$new();
    } catch (e) {
      log(TAG + ' tokenlog callback unavailable: ' + e);
      TokenLogCallback = false;
      return null;
    }
  }

  function writeTokenLog(view, jsonStr) {
    try {
      var appCtx = view.getContext().getApplicationContext();
      var dir = appCtx.getExternalFilesDir(null);
      if (dir === null) {
        log(TAG + ' tokenlog: external files dir null');
        return;
      }
      var File = Java.use('java.io.File');
      var FileOutputStream = Java.use('java.io.FileOutputStream');
      var JString = Java.use('java.lang.String');
      var outFile = File.$new(dir, 'flame-token-log.json');
      var fos = FileOutputStream.$new(outFile, false);
      // FileWriter.write(String) errors on overload resolution through the
      // Frida bridge ("argument types do not match any of"); write(byte[])
      // on FileOutputStream has only one overload, so it's unambiguous.
      fos.write(JString.$new(jsonStr).getBytes());
      fos.close();
      log(TAG + ' tokenlog written: ' + outFile.getAbsolutePath() + ' (' + jsonStr.length + ' bytes)');
    } catch (e) {
      log(TAG + ' tokenlog write error: ' + e);
    }
  }

  // Bridges the live Aura session (context/token/userId, from
  // window.__flameAuthSnapshot — see src/aura.js) plus the session cookie
  // into native SharedPreferences, so AutobookReceiver (real compiled Java,
  // no WebView) can make the real Aura call itself when the alarm fires.
  // localStorage isn't readable outside the WebView's own storage engine,
  // and the Frida hook already has full Java access while the app is
  // foregrounded, so this is the whole bridge -- see HANDOFF.md, "Native
  // background autobook": token *access* was never the hard part, only
  // freshness (separate, still-open question) is.
  function bridgeAuthToPrefs(view, authJson) {
    try {
      var auth = JSON.parse(authJson);
      if (!auth || !auth.context || !auth.token || !auth.userId) {
        log(TAG + ' auth bridge: incomplete snapshot, skipping (' + authJson + ')');
        return;
      }
      var appCtx = view.getContext().getApplicationContext();
      var CookieManager = Java.use('android.webkit.CookieManager');
      var cookie = CookieManager.getInstance().getCookie('https://my.flame.edu.in');
      var prefs = appCtx.getSharedPreferences('flame_autobook', 0);
      var editor = prefs.edit();
      editor.putString('aura_context', auth.context);
      editor.putString('aura_token', auth.token);
      editor.putString('aura_user_id', auth.userId);
      if (cookie) editor.putString('cookie', cookie);
      editor.apply();
      log(TAG + ' auth bridged to prefs (userId=' + auth.userId + ', cookie=' + (cookie ? 'yes' : 'no') + ')');
    } catch (e) {
      log(TAG + ' auth bridge error: ' + e);
    }
  }

  // Bridges the current waiting autobook intents (window.__flameIntentsSnapshot,
  // see src/autobook.js) into the same SharedPreferences, so AutobookReceiver
  // knows what to actually try/schedule. Mirrors bridgeAuthToPrefs() exactly.
  function bridgeIntentsToPrefs(view, intentsJson) {
    try {
      var appCtx = view.getContext().getApplicationContext();
      var prefs = appCtx.getSharedPreferences('flame_autobook', 0);
      prefs.edit().putString('pending_intents', intentsJson || '[]').apply();
      log(TAG + ' intents bridged to prefs (' + intentsJson.length + ' bytes)');
    } catch (e) {
      log(TAG + ' intents bridge error: ' + e);
    }
  }

  // Calls AutobookReceiver.scheduleNextWake() (the real scheduling
  // computation lives in Java so it doesn't have to be duplicated in JS
  // over Frida) after a fresh bridge -- a successful page load always means
  // a fresh token *and* cookie just landed, so this is also where the
  // session-dead suspend flag (set by the receiver itself on a dead token
  // or repeated session-shaped failures -- see FAIL_THRESHOLD in
  // AutobookReceiver.java) gets cleared and the alarm chain resumes.
  function scheduleAutobookAlarm(view) {
    try {
      var appCtx = view.getContext().getApplicationContext();
      var prefs = appCtx.getSharedPreferences('flame_autobook', 0);
      prefs.edit().putBoolean('session_dead', false).apply();
      var AutobookReceiver = Java.use('com.flame.autobook.AutobookReceiver');
      AutobookReceiver.scheduleNextWake(appCtx);
      log(TAG + ' autobook alarm (re)armed');
    } catch (e) {
      log(TAG + ' scheduleAutobookAlarm error: ' + e);
    }
  }

  // Reads back whatever AutobookReceiver settled while the app was closed
  // (pending_intents_result / native_updated_at, written by the receiver
  // itself) and, if newer than what's already in localStorage, folds it in
  // BEFORE the main SCRIPT is injected -- so by the time main.js's boot()
  // runs, paintAutoBookBanner() already has the native results to show.
  // One synchronous snippet rather than a second async round-trip, so
  // there's no race against boot.
  function reconcileNativeIntents(view) {
    try {
      var appCtx = view.getContext().getApplicationContext();
      var prefs = appCtx.getSharedPreferences('flame_autobook', 0);
      var updatedAt = prefs.getLong('native_updated_at', 0);
      if (updatedAt <= 0) return;
      var resultJson = prefs.getString('pending_intents_result', null);
      if (!resultJson) return;
      var snippet =
        '(function(){try{' +
        'var prev=Number(localStorage.getItem("flame-auto-book-native-sync")||"0");' +
        'if(' + updatedAt + '>prev){' +
        'localStorage.setItem("flame-auto-book",' + JSON.stringify(resultJson) + ');' +
        'localStorage.setItem("flame-auto-book-native-sync","' + updatedAt + '");' +
        '}' +
        '}catch(e){}})();';
      view.evaluateJavascript(snippet, null);
      log(TAG + ' native intents reconciled (updatedAt=' + updatedAt + ')');
    } catch (e) {
      log(TAG + ' reconcileNativeIntents error: ' + e);
    }
  }

  // AutobookReceiver's notifications carry a flame_open_tab extra on their
  // launch Intent (buildOpenTabIntent()) so tapping one lands on My
  // Bookings specifically, not just a generic app-open. Same
  // before-SCRIPT synchronous-snippet pattern as reconcileNativeIntents,
  // for the same reason -- main.js's boot() needs this in place before it
  // reads it, not racing an async round-trip against it. Only reliable on
  // a genuine cold start: getIntent() reading the *launch* extra is what's
  // targeted here, and whether a still-alive task's Activity re-delivers
  // it via onNewIntent()/setIntent() on a tap while already open is
  // unconfirmed -- the realistic case (a background-alarm notification)
  // only ever fires while the app isn't already open anyway.
  function applyOpenTabExtra(view) {
    try {
      var activity = resolveActivity(view);
      if (!activity) return;
      var tab = activity.getIntent().getStringExtra('flame_open_tab');
      if (!tab) return;
      view.evaluateJavascript(
        '(function(){try{window.__flameOpenTab=' + JSON.stringify(tab) + ';}catch(e){}})();',
        null
      );
      log(TAG + ' open-tab extra applied: ' + tab);
    } catch (e) {
      log(TAG + ' applyOpenTabExtra error: ' + e);
    }
  }

  // A fresh intent from scheduleIntent()/removeIntent() is a plain
  // localStorage write -- no navigation, so it never reaches
  // scheduleTokenLogDump's one-shot per-page-load bridge on its own. Left
  // alone, an intent scheduled and then backgrounded/killed within the same
  // session would never be armed natively at all until the next full app
  // open, which defeats "set it and forget it." This polls the same
  // already-proven evaluateJavascript path every 5s instead of once, so a
  // freshly scheduled intent gets bridged and the alarm re-armed within a
  // few seconds of being created -- not a full fix (Android throttles JS
  // timers the moment the app actually leaves foreground, which is the
  // whole reason native exists at all, so this can't help once you're
  // truly gone), but it closes the gap down to "the last few seconds before
  // backgrounding" instead of "until you happen to reopen the app."
  var intentsPollBusy = false;
  var intentsPollStarted = false;
  function startIntentsPoll(view) {
    if (intentsPollStarted) return; // one loop per process life, not one per onPageFinished(/s/)
    intentsPollStarted = true;
    var retained = Java.retain(view);
    setInterval(function () {
      if (intentsPollBusy) return; // previous tick hasn't resolved yet
      intentsPollBusy = true;
      try {
        Java.scheduleOnMainThread(function () {
          try {
            retained.evaluateJavascript(
              'JSON.stringify(window.__flameIntentsSnapshot?window.__flameIntentsSnapshot():[])',
              tokenLogCallback(function (jsonStr) {
                intentsPollBusy = false;
                try {
                  var intents = JSON.parse(JSON.parse(jsonStr)); // same double-encoding as scheduleTokenLogDump
                  bridgeIntentsToPrefs(retained, JSON.stringify(intents));
                  scheduleAutobookAlarm(retained);
                } catch (e) {
                  log(TAG + ' intents poll parse error: ' + e);
                }
              })
            );
          } catch (e) {
            intentsPollBusy = false;
            log(TAG + ' intents poll eval error: ' + e);
          }
        });
      } catch (e) {
        intentsPollBusy = false;
      }
    }, 5000);
  }

  function scheduleTokenLogDump(view) {
    // setTimeout scheduled from inside a Java callback (onPageFinished is
    // one) is not reliable in this gadget — see HANDOFF.md trap 9, a
    // one-shot setTimeout from inside ValueCallback.onReceiveValue never
    // ran. revealWhenReskinPaints works around the identical problem with
    // setInterval instead, so this copies that pattern: tick every 200ms,
    // fire once after ~4s (20 ticks — gives loadStoredAuth's synchronous
    // entry and any live-traffic store/reject event, which depends on the
    // page's own first request at ~0.3s per HAR, room to land first).
    var retained = Java.retain(view);
    var ticks = 0;
    var timer = setInterval(function () {
      ticks++;
      if (ticks < 20) return;
      clearInterval(timer);
      try {
        Java.scheduleOnMainThread(function () {
          try {
            retained.evaluateJavascript(
              "JSON.stringify({" +
                "log: window.__flameTokenLog?window.__flameTokenLog():[]," +
                "auth: window.__flameAuthSnapshot?window.__flameAuthSnapshot():null," +
                "intents: window.__flameIntentsSnapshot?window.__flameIntentsSnapshot():[]" +
              "})",
              tokenLogCallback(function (jsonStr) {
                log(TAG + ' tokenlog+auth raw: ' + jsonStr);
                try {
                  // evaluateJavascript's ValueCallback wraps a string
                  // result in its own extra layer of JSON encoding (our
                  // evaluated JS returns a JSON.stringify'd string, so the
                  // callback delivers JSON.stringify of THAT string) --
                  // one parse only unwraps back to a plain string, not the
                  // object. Needs unwrapping twice.
                  var parsed = JSON.parse(JSON.parse(jsonStr));
                  writeTokenLog(retained, JSON.stringify(parsed.log || []));
                  bridgeAuthToPrefs(retained, JSON.stringify(parsed.auth));
                  bridgeIntentsToPrefs(retained, JSON.stringify(parsed.intents || []));
                  // Scheduling reads pending_intents, so it has to run after
                  // both bridges above have actually written -- same order
                  // scheduleTestAlarm used to run in, just later now that
                  // there's real data to schedule against instead of a
                  // fixed test delay.
                  scheduleAutobookAlarm(retained);
                } catch (e) {
                  log(TAG + ' tokenlog+auth parse error: ' + e);
                }
              })
            );
          } catch (e) {
            log(TAG + ' tokenlog eval error: ' + e);
          }
        });
      } catch (e) {}
    }, 200);
  }

  // Runtime POST_NOTIFICATIONS request (Android 13+). Declaring it in the
  // manifest is not enough -- confirmed the hard way: the first real alarm
  // fire posted no notification at all, no crash, no log, because
  // NotificationManager.notify() silently no-ops on a denied permission.
  // Fires the real system dialog once per install (Android itself dedupes a
  // second requestPermissions call if the user already answered), gated by
  // Context.checkSelfPermission so it doesn't re-prompt every launch once
  // granted (or once denied-forever, past two refusals).
  var notifPermRequested = false;
  function requestNotificationPermission(view) {
    if (notifPermRequested) return;
    if (!Build || Build.SDK_INT.value < 33) return; // permission doesn't exist pre-33
    notifPermRequested = true;
    try {
      var activity = resolveActivity(view);
      if (!activity) {
        log(TAG + ' notif permission: no activity resolved, skipping');
        return;
      }
      var PERM = 'android.permission.POST_NOTIFICATIONS';
      var granted = activity.checkSelfPermission(PERM) === 0; // PackageManager.PERMISSION_GRANTED
      if (granted) {
        log(TAG + ' notif permission already granted');
        return;
      }
      Java.scheduleOnMainThread(function () {
        try {
          var StringArray = Java.array('java.lang.String', [PERM]);
          activity.requestPermissions(StringArray, 4201);
          log(TAG + ' notif permission requested');
        } catch (e) {
          log(TAG + ' notif permission request error: ' + e);
        }
      });
    } catch (e) {
      log(TAG + ' requestNotificationPermission error: ' + e);
    }
  }

  var Build = null;
  try { Build = Java.use('android.os.Build$VERSION'); } catch (e) {}

  function hookClient(clientObj) {
    try {
      var className = clientObj.$className || clientObj.getClass().getName();
      var ClientClass = Java.use(className);
      if (!ClientClass.onPageFinished) {
        log(TAG + ' no onPageFinished on ' + className);
        return;
      }
      var overloads = ClientClass.onPageFinished.overloads;
      overloads.forEach(function (ov) {
        ov.implementation = function (view, url) {
          var ret = ov.apply(this, arguments);
          try {
            log(TAG + ' onPageFinished ' + url);
            // Was a bare 'my.flame.edu.in' substring check, which also matched
            // the SSO frontdoor.jsp redirect page (fires before the real /s/
            // portal loads) -- injecting there painted the reskin against a
            // not-yet-viewport-settled page (visible as a "desktop-mode" flash),
            // which then got thrown away wholesale by the next navigation to
            // /s/, forcing a second full white-loader-then-reinject cycle.
            // Scoped to /s/ specifically so the reskin only ever paints once.
            if (url && url.indexOf('my.flame.edu.in/s/') !== -1) {
              // Must run before SCRIPT itself, so anything AutobookReceiver
              // settled while the app was closed is already in localStorage
              // by the time main.js's boot() paints the autobook banner.
              reconcileNativeIntents(view);
              applyOpenTabExtra(view);
              log(TAG + ' injecting reskin into ' + url);
              view.evaluateJavascript(SCRIPT, null);
              revealWhenReskinPaints(view);
              scheduleTokenLogDump(view);
              startIntentsPoll(view);
              requestNotificationPermission(view);
              try {
                recolorStatusBar(view);
              } catch (e2) {
                log(TAG + ' statusbar error: ' + e2);
              }
              try {
                pushNavBarInset(view);
              } catch (e3) {
                log(TAG + ' navbar inset error: ' + e3);
              }
            }
          } catch (e) {
            log(TAG + ' inject error: ' + e);
          }
          return ret;
        };
      });
      log(TAG + ' hooked ' + className + '.onPageFinished');
    } catch (e) {
      log(TAG + ' hookClient error: ' + e);
    }
  }

  // Delegates to real compiled Java (AutobookReceiver.notifySettledFromJson/
  // notifyCancelledFromJson) rather than building the notification through
  // Frida's Java bridge directly -- that hit a real "argument types do not
  // match any of" wall (CharSequence-typed params like setContentTitle
  // don't auto-box a raw JS string the way a plain String param does),
  // which real javac-compiled code sidesteps entirely. Fires from inside
  // the app on purpose (booking/cancel results should be visible whether
  // or not the app happens to be open -- the app being open is exactly
  // when this path runs, since it's JS that triggered the signal).
  function notifyFromEvent(view, event) {
    try {
      var appCtx = view.getContext().getApplicationContext();
      var AutobookReceiverClass = Java.use('com.flame.autobook.AutobookReceiver');
      if (event.type === 'settled') {
        AutobookReceiverClass.notifySettledFromJson(appCtx, JSON.stringify(event.intents || []));
      } else if (event.type === 'cancelled') {
        AutobookReceiverClass.notifyCancelledFromJson(appCtx, JSON.stringify(event.intent || {}));
      } else if (event.type === 'scheduled') {
        AutobookReceiverClass.notifyScheduledFromJson(appCtx, JSON.stringify(event.intent || {}));
      }
    } catch (e) {
      log(TAG + ' notifyFromEvent error: ' + e);
    }
  }

  var TITLE_MARKER = 'FLAME_INTENT:';
  function handleTitleSignal(view, title) {
    var t = title ? String(title) : '';
    if (t.indexOf(TITLE_MARKER) !== 0) return;
    var payload = t.slice(TITLE_MARKER.length);
    log(TAG + ' title-hook fired: ' + payload);
    try {
      var parsed = JSON.parse(payload);
      bridgeIntentsToPrefs(view, JSON.stringify(parsed.intents || []));
      scheduleAutobookAlarm(view);
      if (parsed.event) notifyFromEvent(view, parsed.event);
    } catch (e) {
      log(TAG + ' title-hook payload parse error: ' + e);
    }
  }

  function hookChromeClient(clientObj) {
    try {
      var className = clientObj.$className || clientObj.getClass().getName();
      var ClientClass = Java.use(className);
      if (!ClientClass.onReceivedTitle) {
        log(TAG + ' no onReceivedTitle on ' + className);
        return;
      }
      var overloads = ClientClass.onReceivedTitle.overloads;
      overloads.forEach(function (ov) {
        ov.implementation = function (view, title) {
          var ret = ov.apply(this, arguments);
          try {
            handleTitleSignal(view, title);
          } catch (e) {
            log(TAG + ' onReceivedTitle handler error: ' + e);
          }
          return ret;
        };
      });
      log(TAG + ' hooked ' + className + '.onReceivedTitle');
    } catch (e) {
      log(TAG + ' hookChromeClient error: ' + e);
    }
  }

  function installHook() {
    try {
      var WebView = Java.use('android.webkit.WebView');
      WebView.setWebChromeClient.overload('android.webkit.WebChromeClient').implementation = function (client) {
        log(TAG + ' setWebChromeClient called: ' + client.$className);
        hookChromeClient(client);
        return this.setWebChromeClient(client);
      };
      WebView.setWebViewClient.overload('android.webkit.WebViewClient').implementation = function (client) {
        log(TAG + ' setWebViewClient called: ' + client.$className);
        // Android WebView paints solid white until the page's own CSS/background
        // loads -- that white flash was showing through during Aura's own boot,
        // before our SCRIPT injection (which only runs once onPageFinished fires,
        // well after the page has started painting) ever gets a chance to hide
        // it. Painting our dark theme color here happens as early as the WebView
        // itself is wired up, before any navigation/page paint has occurred.
        try {
          this.setBackgroundColor(DARK_BG);
          // Same moment, same reason, one layer up: the background colour
          // only shows where the document is transparent, and Salesforce's
          // boot pages are opaque white. The cover is what the user
          // actually looks at until the reskin is ready.
          showBootCover(this);
        } catch (e) {
          log(TAG + ' setBackgroundColor error: ' + e);
        }
        // Belt-and-suspenders against the desktop-mode flash: useWideViewPort
        // defaults true, which makes WebView assume a ~980px virtual desktop
        // viewport (then scale-to-fit) on any page that doesn't declare its
        // own <meta name="viewport"> -- our @media(max-width:760px) query
        // evaluates against that fake 980px width and loses, rendering
        // desktop layout, on pages like frontdoor.jsp that have no viewport
        // tag. false makes WebView always use the real device width instead,
        // on every page, with or without a viewport tag -- /s/ already
        // declares width=device-width so its real behavior is unchanged;
        // this only removes the wide-viewport guess elsewhere. Genuinely
        // responsive to real device/window width either way (rotation,
        // tablet sizes, split-screen resize all still work) -- this doesn't
        // pin a fixed width, it just stops WebView from lying about it.
        try {
          this.getSettings().setUseWideViewPort(false);
        } catch (e) {
          log(TAG + ' setUseWideViewPort error: ' + e);
        }
        hookClient(client);
        return this.setWebViewClient(client);
      };
      log(TAG + ' hook installed, waiting for WebView...');
    } catch (e) {
      // android.webkit.WebView's real implementation lives in a separate
      // WebView-provider classloader that may not be loaded into the
      // process yet at script-start — Java.use() on it too early causes a
      // native access violation inside Frida's Java bridge (confirmed via
      // live testing, not a guess). Retry after a short delay instead of
      // touching the class before that classloader exists.
      log(TAG + ' WebView class not ready yet (' + e + '), retrying in 1s...');
      setTimeout(installHook, 1000);
    }
  }

    installHook();
  });
  if (__nlog) __nlog('CHECKPOINT-A6: Java.perform() call returned (sync, callback may be async)');
} catch (e) {
  if (__nlog) __nlog('CHECKPOINT-A5-ERROR: Java.perform() threw synchronously: ' + e + ' | ' + (e && e.stack));
}
