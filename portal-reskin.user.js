// ==UserScript==
// @name         FLAME Portal Reskin
// @namespace    kaanav.gathani
// @match        https://my.flame.edu.in/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // Shared mutable state.
  //
  // This is the one thing the single-file version got for free: every
  // `let bookingsCache = null` sat in one closure, so any function could
  // reassign it. ES module bindings are read-only for importers, so the
  // handful of values that genuinely are written from more than one module
  // live here as fields on an object instead — the assignment goes through
  // the object, which every importer shares.
  //
  // Anything only ever written by its own module stays a plain `let` there.
  // Keep this file small; it is a list of exceptions, not a store.

  // The shell's live DOM, built once by buildShell().
  const ui = {
    root: null,          // #flame-reskin-root
    viewportEl: null,    // .fr-content-viewport — stable; hosts one or two .fr-content panes during a tab transition
    contentEl: null,     // .fr-content — the *current* pane; every tab render replaces it wholesale, and a tab-to-tab transition reassigns this pointer to a freshly rendered pane before sliding it in
    bannerHost: null,    // sits outside contentEl so a tab render can't take it
    toggleBtn: null,     // #flame-reskin-toggle, outside root so it survives "off"
    // Bumped by every switchTab(); a render compares its own token against
    // this before touching the DOM, so a slow tab that resolves after you
    // have already navigated away paints nothing.
    activeToken: 0,
  };

  // Fetched once per page load, invalidated only by a mutation that really
  // changes them (a booking or a cancellation).
  const cache = {
    events: null,        // class schedule — doesn't change mid-session
    bookings: null,
  };

  // ---------------------------------------------------------------------
  // 3. Hide original Siteforce chrome, keep it hidden across SPA nav —
  //    except when the user has toggled back to the stock UI (section 5).
  // ---------------------------------------------------------------------


  function injectHideStyle() {
    if (document.getElementById('flame-reskin-hide')) return;
    const style = document.createElement('style');
    style.id = 'flame-reskin-hide';
    style.textContent = `
    body > *:not(#flame-reskin-root):not(#flame-reskin-toggle) { display: none !important; }
    #flame-reskin-root { display: flex !important; }
    /* Stock-UI toggle: flip the reskin off and let the original page show through. */
    /* Must match the :not() exclusion count of the base hide rule above
       (2 ids) plus the .flame-reskin-off class, otherwise the base rule's
       higher specificity keeps winning and "off" never actually reveals
       anything — verified this the hard way against a live toggle click. */
    body.flame-reskin-off > *:not(#flame-reskin-root):not(#flame-reskin-toggle) { display: revert !important; }
    body.flame-reskin-off #flame-reskin-root { display: none !important; }
  `;
    document.head.appendChild(style);
  }

  // The actual risk: Aura re-rendering may replace document.body's contents
  // wholesale, taking #flame-reskin-root (and the toggle button) down with
  // it. Re-append either if so.
  function keepHiding() {
    const observer = new MutationObserver(() => {
      if (!document.getElementById('flame-reskin-root') && ui.root) document.body.appendChild(ui.root);
      if (!document.getElementById('flame-reskin-toggle') && ui.toggleBtn) document.body.appendChild(ui.toggleBtn);
    });
    observer.observe(document.body, { childList: true });
  }

  // ---------------------------------------------------------------------
  // 1. Aura context/token/userId capture
  //
  // Instead of parsing window.Aura.appBootstrap (fragile, format shifts
  // between Aura versions), snoop the page's own outgoing aura requests.
  // The page fires several of these on every load (nav menu, notif tray,
  // etc — confirmed in aura_map.md), so we get a working context+token
  // within the first second, and it self-refreshes if the page rotates
  // the token later.
  // ---------------------------------------------------------------------

  const auraState = {
    context: null,   // raw aura.context string (JSON), reused verbatim
    token: null,     // raw aura.token string
    userId: null,    // Salesforce User Id, sniffed from any params.userId
  };

  // Last session's credentials, so the first request does not have to wait
  // for the page to reveal a token by making one of its own.
  //
  // Measured against a HAR: the page's first tokened request goes out 0.297s
  // after the document loads, but the reskin is only injected at
  // onPageFinished — well after that — so it then waits for the *next* one.
  // The token survives page loads (two separately captured sessions share
  // one), so keeping it is worth a try on the next launch.
  //
  // Purely an optimistic head start. Sniffing still runs, and a rejected
  // token costs one wasted request that callAura retries with the sniffed
  // value — never an error the user sees.
  const AUTH_KEY = 'flame-aura-auth';

  // Temporary: measuring whether the token actually survives a long idle gap
  // (native background autobook hinges on this — console.log doesn't reach
  // logcat on this app's WebView, per HANDOFF, so this logs into localStorage
  // instead, readable later via a Frida -n attach). Fingerprint only (last 8
  // chars), never the raw token. Drop this once the question is settled.
  const TOKEN_LOG_KEY = 'flame-token-log';
  const TOKEN_LOG_MAX = 40;

  function fingerprint(token) {
    return token ? token.slice(-8) : null;
  }

  function logTokenEvent(event, token) {
    try {
      const log = JSON.parse(localStorage.getItem(TOKEN_LOG_KEY) || '[]');
      log.push({ event, ts: Date.now(), tok: fingerprint(token) });
      while (log.length > TOKEN_LOG_MAX) log.shift();
      localStorage.setItem(TOKEN_LOG_KEY, JSON.stringify(log));
    } catch (e) {}
  }
  window.__flameTokenLog = () => {
    try { return JSON.parse(localStorage.getItem(TOKEN_LOG_KEY) || '[]'); } catch (e) { return []; }
  };

  // Native-autobook bridge (temporary, same lifetime as the token log above):
  // the compiled AutobookReceiver has no WebView and can't read localStorage
  // directly, so hook.src.js pulls this via evaluateJavascript and copies it
  // into native SharedPreferences on every page load. Live values only, not
  // persisted here — auraState already is the source of truth.
  window.__flameAuthSnapshot = () => ({
    context: auraState.context,
    token: auraState.token,
    userId: auraState.userId,
  });

  function loadStoredAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || !saved.context || !saved.token) return;
      auraState.context = saved.context;
      auraState.token = saved.token;
      // userId is derived from the account, not the session — safe to reuse
      // even when the token turns out to be stale.
      if (saved.userId) auraState.userId = saved.userId;
      logTokenEvent('load', saved.token);
    } catch (e) {
      // Unreadable or from an older shape: fall back to sniffing, which is
      // exactly the behaviour before any of this existed.
    }
  }

  function storeAuth() {
    try {
      if (!auraState.context || !auraState.token) return;
      localStorage.setItem(AUTH_KEY, JSON.stringify({
        context: auraState.context,
        token: auraState.token,
        userId: auraState.userId,
      }));
      logTokenEvent('store', auraState.token);
    } catch (e) {}
  }

  function forgetStoredAuth() {
    try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
  }

  loadStoredAuth();

  function harvestFromBody(bodyStr) {
    if (!bodyStr || bodyStr.indexOf('aura.context') === -1) return;
    try {
      const params = new URLSearchParams(bodyStr);
      const ctx = params.get('aura.context');
      const tok = params.get('aura.token');
      const changed = ctx !== auraState.context || tok !== auraState.token;
      if (ctx) auraState.context = ctx;
      if (tok) auraState.token = tok;
      if (changed && auraState.context && auraState.token) storeAuth();

      const message = params.get('message');
      if (message) {
        const parsed = JSON.parse(message);
        for (const action of parsed.actions || []) {
          const p = action.params && action.params.params;
          if (p && p.userId && !auraState.userId) {
            auraState.userId = p.userId;
          }
        }
      }
    } catch (e) {
      // best-effort sniffing, ignore malformed bodies
    }
  }

  // fetch()
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && url.indexOf('/s/sfsites/aura') !== -1 && init && init.body) {
        harvestFromBody(init.body);
      }
    } catch (e) {}
    return nativeFetch.apply(this, arguments);
  };

  // XMLHttpRequest
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__reskinUrl = url;
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__reskinUrl && this.__reskinUrl.indexOf('/s/sfsites/aura') !== -1) {
        harvestFromBody(body);
      }
    } catch (e) {}
    return nativeSend.apply(this, arguments);
  };

  function waitFor(predicate, timeoutMs = 15000, intervalMs = 150) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (predicate()) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for aura context'));
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // getCurrentUserContactId returns a Contact Id (003-prefix) — NOT usable
  // here, the Apex methods below want a User Id (005-prefix). The only
  // mapped no-arg call that surfaces the User Id is the AI assistant's
  // thread context string, so scrape it out of there instead. Also carries
  // additionalKnowledgeFileIds, which Gyan's own chat calls need — cache the
  // raw response once and let both consumers share it.
  let assistantContextCache = null;
  async function getAssistantContext() {
    if (!assistantContextCache) {
      assistantContextCache = await callAura('AiAssistantFlameCommunityWrapper', 'getAssistantContext', null, true);
    }
    return assistantContextCache;
  }

  async function resolveUserId() {
    if (auraState.userId) return auraState.userId;
    const ctx = await getAssistantContext();
    const match = /005[A-Za-z0-9]{12,15}/.exec(ctx.threadContext || '');
    if (!match) throw new Error('could not resolve Salesforce User Id from assistant context');
    auraState.userId = match[0];
    return auraState.userId;
  }

  // ---------------------------------------------------------------------
  // 2. callAura() — the RPC helper
  // ---------------------------------------------------------------------

  let actionCounter = 0;

  async function callAura(classname, method, params = null, cacheable = false, namespace = '') {
    try {
      return await sendAura(classname, method, params, cacheable, namespace);
    } catch (e) {
      // One retry, and only for the case this exists to cover: the stored
      // credentials were stale. sendAura has already cleared them, so the
      // wait below blocks until the page's own traffic supplies a live
      // token — which it does within a second of the document loading.
      if (!e || !e.frInvalidToken) throw e;
      // The residual risk this whole optimisation carries: the stored token
      // is dead, so we now need a sniffed one, and sniffing only sees
      // requests made *after* the reskin was injected. The page does keep
      // making them, but on the rare launch where a token has expired this
      // is a wait the old always-sniff path never had. 8s rather than the
      // 15s default so a bad case fails visibly instead of looking hung.
      //
      // Injecting the script at document-start would remove this entirely —
      // the hooks would then be in place before the page's own first
      // request, which a HAR puts at 0.297s after the document loads.
      await waitFor(() => auraState.context && auraState.token, 8000);
      return await sendAura(classname, method, params, cacheable, namespace);
    }
  }

  async function sendAura(classname, method, params = null, cacheable = false, namespace = '') {
    // Preview/dev hook: when a static preview page defines this global,
    // short-circuit the network entirely and resolve canned data. Never
    // set on the real portal, so this is inert in production.
    if (window.__FLAME_RESKIN_PREVIEW__) {
      const key = `${classname}.${method}`;
      const stub = window.__FLAME_RESKIN_PREVIEW__[key];
      if (stub === undefined) throw new Error(`no preview stub for ${key}`);
      // The harness raises this to simulate a slow link, which is the only
      // way to observe what is on screen *while* a request is in flight —
      // the whole point of Home's stale-first paint.
      await new Promise((r) => setTimeout(r, window.__FLAME_RESKIN_PREVIEW_DELAY__ || 80));
      return typeof stub === 'function' ? stub(params) : stub;
    }

    await waitFor(() => auraState.context && auraState.token);

    const id = String(actionCounter++);
    const innerParams = {
      namespace,
      classname,
      method,
      cacheable,
      isContinuation: false,
    };
    // Real requests omit the "params" key entirely for no-arg methods
    // (confirmed against HAR) — sending {} instead trips Apex deserialization.
    if (params) innerParams.params = params;

    const message = {
      actions: [
        {
          id,
          descriptor: 'aura://ApexActionController/ACTION$execute',
          callingDescriptor: 'UNKNOWN',
          params: innerParams,
        },
      ],
    };

    const body = new URLSearchParams({
      message: JSON.stringify(message),
      'aura.context': auraState.context,
      'aura.token': auraState.token,
      'aura.pageURI': location.pathname + location.search,
    });

    const r = Date.now(); // request counter — value doesn't matter, just needs to change (per HANDOFF.md)
    const resp = await nativeFetch(`/s/sfsites/aura?r=${r}&aura.ApexAction.execute=1`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const json = await resp.json();
    const action = (json.actions || []).find((a) => a.id === id) || (json.actions || [])[0];

    if (!action) throw new Error('no matching action in aura response');

    if (action.state === 'SUCCESS') {
      // Aura wraps the Apex return value one level deep:
      // action.returnValue = { returnValue: <actual data>, cacheable: bool }
      // (confirmed against a real HAR response body) — unwrap it here.
      return action.returnValue.returnValue;
    }

    // Token likely rotated — clear it so the next native page request
    // (or a manual reload) repopulates auraState, then surface the error.
    const err = new Error(`aura call failed (${classname}.${method}): ${JSON.stringify(action.error || action)}`);
    if (JSON.stringify(action).indexOf('INVALID_TOKEN') !== -1) {
      logTokenEvent('rejected', auraState.token);
      auraState.token = null;
      // Drop the stored copy too, or every launch would start by spending a
      // request on the same dead token.
      forgetStoredAuth();
      err.frInvalidToken = true;
    }
    throw err;
  }

  // Date and time formatting.
  //
  // All of it is local-time by construction: input[type=date].valueAsDate
  // and toISOString() both work in UTC, which silently shows yesterday near
  // midnight in IST. Nothing here touches either.

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function startOfWeekMonday(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dow = d.getDay(); // 0=Sun..6=Sat
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    return addDays(d, diffToMonday);
  }

  function dayLabel(date) {
    const today = startOfToday();
    const diffDays = Math.round((date - today) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // dayLabel's long weekday ("Wednesday, Sep 10") is right for a page
  // heading but too wide for a booking row, where it shares one line with a
  // time range, a status pill and a button — that overflow is what pushed
  // the closing AM/PM onto a second line and made the box taller.
  function shortDayLabel(date) {
    // Compare date-to-date: a booking carries a time of day, and measuring
    // that against midnight rounded a 4 PM booking tomorrow to 2 days out
    // ("Thu, Sep 3") while a 7 AM one the same day landed on "Tomorrow".
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((day - startOfToday()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // "9:00 AM" + "10:00 AM" -> "9 AM \u2013 10 AM". Only the on-the-hour ":00"
  // goes: a slot tile two-up on a 390px screen has ~130px of text width, and
  // "10:00 AM \u2013 11:00 AM" needs more than that, so its trailing meridiem
  // wrapped to a second line and made that one tile taller than every other
  // tile in the grid (same in a booking row, where the range shares a line
  // with a status pill and a button). Both meridiems always stay — dropping
  // the leading one when the range didn't cross noon fit even better but read
  // as too clipped, and made a range's two ends look unlike each other.
  // A :15/:30 slot keeps its minutes; any format this doesn't recognise is
  // left alone.
  const ZERO_MINUTES_RE = /^(\d{1,2}):00(?=[\s\u00a0\u202f]*[AaPp]|$)/;
  function compactTimeRange(startStr, endStr) {
    const start = String(startStr).replace(ZERO_MINUTES_RE, '$1');
    const end = String(endStr).replace(ZERO_MINUTES_RE, '$1');
    return `${start} \u2013 ${end}`;
  }

  function shortDate(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatTime(date) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // Bookings' dates come back as "31/08/2026, 9:00 AM" (dd/mm/yyyy) strings.
  function parseBookingDateTime(s) {
    const [datePart, timePart] = s.split(', ');
    const [d, m, y] = datePart.split('/').map(Number);
    return new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${timePart}`);
  }

  // A booking spans a single day, so the raw "start – end" strings (each a
  // full date+time) repeat the date for no reason. State it once.
  function formatBookingWhen(booking) {
    const start = parseBookingDateTime(booking.startDateTime);
    const end = parseBookingDateTime(booking.endDateTime);
    return `${shortDayLabel(start)} · ${compactTimeRange(formatTime(start), formatTime(end))}`;
  }

  // resourceName carries the facility's whole operating window as a
  // parenthetical suffix, e.g. "Gym ( 6:00 am to 2:00 pm slot )" — that's
  // the facility's general open hours, not this reservation, and the actual
  // booked time is already shown via formatBookingWhen. Drop the noise.
  function cleanResourceName(name) {
    return (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  // input[type=date].valueAsDate reads/writes in UTC, not local time — near
  // midnight in IST (UTC+5:30) that silently rolls the shown date back by
  // one day. Build the "YYYY-MM-DD" string from local fields everywhere instead.
  function isoDateLocal(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Last-known data, kept across page loads.
  //
  // The in-memory caches in state.js start empty on every launch, so the
  // first thing you saw after the app booted was a spinner, for as long as
  // two aura round-trips took — about a second on the device, on top of the
  // portal's own boot. Everything Home shows is already known from last
  // time, so it can be on screen immediately and corrected a moment later.
  //
  // This is a first-paint hint, never a substitute for fetching: the render
  // path still issues the same requests every time and repaints with the
  // answer. That is what keeps a cancelled booking from surviving here for
  // longer than it takes one request to come back.

  const KEY = 'flame-data-cache';

  // Older than this and it is not worth showing at all — a stale-by-a-day
  // class list is genuinely useful (the timetable is semester-static), a
  // stale-by-a-week one is just noise while the real answer loads.
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function readPersisted() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.savedAt || Date.now() - data.savedAt > MAX_AGE_MS) return null;
      return data;
    } catch (e) {
      // Private mode, disabled storage, or a shape from an older version:
      // fall back to the spinner, which is exactly the old behaviour.
      return null;
    }
  }

  function writePersisted(patch) {
    try {
      const current = (() => {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
      })();
      localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch, savedAt: Date.now() }));
    } catch (e) {
      // Storage full or unavailable — the app works, it just boots cold.
    }
  }

  // Called wherever the in-memory cache is invalidated by a mutation, so a
  // booking you just cancelled cannot come back on the next launch and sit
  // there until the refetch lands.
  function clearPersistedBookings() {
    const data = readPersisted();
    if (!data) return;
    delete data.bookings;
    writePersisted(data);
  }

  // The facility/resource list is its own cache with its own clock. Home's
  // blob expires in a day because a day-old class list is nearly right and
  // a week-old one is noise; the resource list is different in kind — the
  // gym and the classrooms are the same all semester, so a week-old copy is
  // still correct, and expiring it daily would put a round trip in front of
  // the Book Slot tab for no reason. Separate key, because the two have
  // nothing to do with each other beyond both being last-known data.
  const RESOURCES_KEY = 'flame-resources-cache';
  const RESOURCES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

  function readPersistedResources() {
    try {
      const data = JSON.parse(localStorage.getItem(RESOURCES_KEY));
      if (!data || !data.savedAt || Date.now() - data.savedAt > RESOURCES_MAX_AGE_MS) return null;
      return Array.isArray(data.facilities) && data.facilities.length ? data.facilities : null;
    } catch (e) {
      return null;
    }
  }

  function writePersistedResources(facilities) {
    try {
      localStorage.setItem(RESOURCES_KEY, JSON.stringify({ facilities, savedAt: Date.now() }));
    } catch (e) {
      // Same as above: a cache that cannot be written costs a round trip,
      // nothing else.
    }
  }

  // Two aura payloads compared structurally. They are plain JSON from the
  // same serializer, so key order is stable and stringifying is both
  // correct and quicker than walking them. Used to answer "did anything
  // actually change" before tearing down a page that is already right.
  function sameData(a, b) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
      return false;
    }
  }

  // A tiny createElement wrapper. Every attribute goes through
  // setAttribute except `text`, which sets textContent — so a value is never
  // parsed as HTML, and nothing the portal returns can inject markup.

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) node.appendChild(child);
    return node;
  }

  // One shimmering placeholder block, sized in ch because the only thing a
  // caller knows is roughly how long the real text will be. It carries a
  // non-breaking space so it occupies a real line box of whatever type its
  // parent uses — that is what keeps a skeleton row exactly as tall as the
  // row it stands in for. See .fr-skel.
  function skel(widthCh) {
    return el('span', { class: 'fr-skel', style: `width: ${widthCh}ch`, text: ' ' });
  }

  // Animate a container from the height it used to occupy to the height it
  // occupies now. Used where a section's contents are rebuilt and the new
  // shape is a different size than the old one — the skeleton predicted one
  // booking and the day has three — so the section grows into place instead
  // of snapping and shoving the page under the reader's eye.
  //
  // No requestAnimationFrame anywhere in here: this WebView services no
  // frames when it decides it has nothing to paint (see HANDOFF), so a rAF
  // callback is not a dependable place to put the second height. Reading
  // offsetHeight flushes layout synchronously, which is all the transition
  // needs to see a start value. For the same reason transitionend is only
  // the fast path — a timer clears the inline styles regardless, so a
  // dropped transition leaves a correctly sized element rather than one
  // frozen at a stale height.
  function morphHeight(node, fromHeight, duration = 280) {
    const to = node.offsetHeight;
    if (!fromHeight || !to || Math.abs(to - fromHeight) < 2) return;
    node.classList.add('fr-morphing');
    node.style.height = `${fromHeight}px`;
    void node.offsetHeight;
    node.style.height = `${to}px`;
    let done = false;
    const clear = () => {
      if (done) return;
      done = true;
      node.classList.remove('fr-morphing');
      node.style.height = '';
    };
    node.addEventListener('transitionend', clear, { once: true });
    setTimeout(clear, duration + 120);
  }

  // A labelled on/off switch. Returns the row plus a `checked` getter, the
  // same minimal surface buildPicker exposes — callers only ever ask it one
  // question. Lives here rather than in shell.js so toggle.js (the
  // long-press menu) can use it too without shell.js and toggle.js
  // importing each other — shell.js already imports from toggle.js, and
  // this app has one dependency-cycle war story already (see HANDOFF).
  function buildSwitch({ label, hint, checked = false, onChange }) {
    const row = el('div', { class: 'fr-switch-row' });
    const text = el('div', {}, [el('div', { class: 'fr-switch-label', text: label })]);
    if (hint) text.appendChild(el('p', { class: 'fr-switch-hint', text: hint }));
    const btn = el('button', {
      class: 'fr-switch', type: 'button',
      role: 'switch', 'aria-checked': String(checked), 'aria-pressed': String(checked),
      'aria-label': label,
    });
    btn.appendChild(el('span', { class: 'fr-switch-knob' }));
    let on = checked;
    btn.addEventListener('click', () => {
      on = !on;
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-checked', String(on));
      if (onChange) onChange(on);
    });
    row.append(text, btn);
    return { el: row, get checked() { return on; } };
  }

  // ---------------------------------------------------------------------
  // 12. Scheduled auto-booking
  //
  // The portal only lets you book a slot once it is less than 24h away, and
  // the popular gym slots are gone within about five minutes of opening. The
  // original plan for this was native — AlarmManager at T-24h waking a
  // headless WebView — which needs a manifest edit the patch pipeline can't
  // do, plus a session that survives a day idle. None of that is necessary
  // for a first version: the app gets opened several times a day anyway, so
  // an intent parked in localStorage and retried on every launch (and on a
  // timer while the app is open) books anything that isn't contested, with
  // no native code at all. It will lose a five-minute rush unless the app
  // happens to be open — that is the known limit of this version, not an
  // oversight. See HANDOFF.md.
  // ---------------------------------------------------------------------


  const AUTOBOOK_KEY = 'flame-auto-book';
  const SLOT_MEMORY_KEY = 'flame-slot-times';
  const BOOKING_WINDOW_MS = 24 * 60 * 60 * 1000;

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Private mode / storage disabled: scheduling silently stops working,
      // but nothing else should break because of it.
    }
  }

  const loadIntents = () => loadJson(AUTOBOOK_KEY, []);

  // Native-autobook bridge: AutobookReceiver has no WebView and can't read
  // localStorage directly, so hook.src.js pulls this the same way it already
  // pulls window.__flameAuthSnapshot (see src/aura.js) and writes it into
  // SharedPreferences. Only 'waiting' intents matter for scheduling --
  // done/failed ones are history the JS side already owns.
  window.__flameIntentsSnapshot = () => loadIntents().filter((i) => i.state === 'waiting');

  // Signals hook.src.js the instant intents actually change, via
  // document.title -- WebChromeClient.onReceivedTitle is a real Android
  // callback that fires on every title write, old enough to predate
  // addJavascriptInterface, and needs no custom bridge object on our side.
  // Without this, a freshly scheduled intent is invisible to native until the
  // next full page load (onPageFinished is the only other bridge point, and
  // scheduleIntent()/removeIntent() are plain localStorage writes, no
  // navigation). No visible effect: nothing in this app's UI reads or shows
  // document.title.
  // `event` is optional and carries what actually just happened (a booking
  // settling, a watch being cancelled) so hook.src.js can fire the real
  // formatted notification even for a change made from inside the app, not
  // just bridge the snapshot for native scheduling -- the two purposes ride
  // in one signal since both need the same title-change trip either way.
  function signalNativeIntentsChanged(event) {
    try {
      document.title = 'FLAME_INTENT:' + JSON.stringify({ intents: window.__flameIntentsSnapshot(), event });
    } catch (e) {}
  }

  // Every save routes through here so the signal can't be forgotten at a call
  // site -- one choke point instead of four places to remember to call it.
  const saveIntents = (list, event) => {
    saveJson(AUTOBOOK_KEY, list);
    signalNativeIntentsChanged(event);
  };

  // "7:00 AM" -> minutes since midnight. The portal's own slot strings.
  function parseClockMinutes(text) {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(String(text).trim());
    if (!m) return null;
    const hour12 = Number(m[1]) % 12;
    const hour = m[3].toLowerCase() === 'p' ? hour12 + 12 : hour12;
    return hour * 60 + Number(m[2] || 0);
  }

  // Slot times arrive as strings from two places that do not agree on
  // punctuation: the portal's own "6:00 AM", and times we format ourselves.
  // Locales differ on the dayPeriod's case ("am" on en-IN) and on the space
  // before it (ICU 72+ uses U+202F), so two strings for the same instant can
  // compare unequal on one phone and equal on another — which is how the
  // grid ended up drawing every derived slot a second time beside the real
  // one. Compare on the minute, never on the text.
  function slotTimeKey(text) {
    const mins = parseClockMinutes(text);
    return mins === null ? `raw:${String(text).trim().toLowerCase()}` : String(mins);
  }

  function slotStartDate(isoDate, startTime) {
    const [y, mo, d] = isoDate.split('-').map(Number);
    const minutes = parseClockMinutes(startTime);
    if (minutes === null) return null;
    return new Date(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0);
  }

  // A slot is bookable from exactly 24h before it starts until it starts.
  function intentOpensAt(intent) {
    const start = slotStartDate(intent.date, intent.startTime);
    return start ? new Date(start.getTime() - BOOKING_WINDOW_MS) : null;
  }

  // Resources whose name carries their operating window ("Gym ( 6:00 am to
  // 2:00 pm slot )") can have their whole day derived without asking the
  // server, which is what makes it possible to schedule a slot the server
  // won't even list yet. Everything else falls back to the times we have
  // actually seen for that resource, remembered from earlier availability
  // responses.
  const RESOURCE_HOURS_RE = /\(\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\s*to\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i;

  function hoursFromResourceName(name) {
    const m = RESOURCE_HOURS_RE.exec(name || '');
    if (!m) return null;
    const toMinutes = (h, mm, ap) => ((Number(h) % 12) + (ap.toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(mm || 0);
    return { start: toMinutes(m[1], m[2], m[3]), end: toMinutes(m[4], m[5], m[6]) };
  }

  // Built by hand rather than through toLocaleTimeString: these strings are
  // matched against the portal's own ("6:00 AM"), and a locale that writes
  // "6:00 am" or separates the dayPeriod with U+202F makes the same slot
  // look like two. Display is unaffected — this is the format the portal uses.
  function minutesToClock(mins) {
    const hour = Math.floor(mins / 60);
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}:${String(mins % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  }

  function rememberSlotTimes(resourceId, slots) {
    if (!resourceId || !slots.length) return;
    const memory = loadJson(SLOT_MEMORY_KEY, {});
    memory[resourceId] = slots.map((s) => ({ startTime: s.startTime, endTime: s.endTime }));
    saveJson(SLOT_MEMORY_KEY, memory);
  }

  // The full day for a resource: derived from its operating window when the
  // name carries one, otherwise whatever we last saw it offer.
  function knownSlotTimes(resource) {
    const hours = hoursFromResourceName(resource && resource.name);
    if (hours && hours.end > hours.start) {
      const out = [];
      for (let m = hours.start; m + 60 <= hours.end; m += 60) {
        out.push({ startTime: minutesToClock(m), endTime: minutesToClock(m + 60) });
      }
      return out;
    }
    return loadJson(SLOT_MEMORY_KEY, {})[resource && resource.resourceId] || [];
  }

  // The portal allows one booking per resource *class* per calendar day,
  // and a class is the resource without its operating-window suffix — the
  // 6 AM gym and the 3 PM gym are one thing to that rule, despite being
  // two resourceIds. This is the key everything about the rule compares on.
  function resourceClassKey(name) {
    return cleanResourceName(name).toLowerCase();
  }

  // The waiting intent that already claims this class/day, if any.
  //
  // A daily series claims every day from its own date onward, not just that
  // one: it is going to reach them. Without this you could set a daily gym
  // autobook for tomorrow and still be offered Thursday as if it were free,
  // only for the series to arrive and take it.
  function conflictingIntent(resourceName, isoDate, list) {
    const key = resourceClassKey(resourceName);
    return (list || loadIntents()).find((i) => {
      if (i.state !== 'waiting') return false;
      if (resourceClassKey(i.resourceName) !== key) return false;
      if (i.date === isoDate) return true;
      // ISO dates compare correctly as strings.
      return i.repeat === 'daily' && i.date < isoDate;
    }) || null;
  }

  // Finds any future daily series for this resource class starting AFTER isoDate.
  function futureDailyIntents(resourceName, isoDate, list) {
    const key = resourceClassKey(resourceName);
    return (list || loadIntents()).filter((i) => {
      if (i.state !== 'waiting') return false;
      if (resourceClassKey(i.resourceName) !== key) return false;
      return i.repeat === 'daily' && i.date > isoDate;
    });
  }

  // Returns the new intent, or null if the day is already claimed for this
  // resource class. Two intents for one class on one day can only ever
  // produce one booking and one refusal, so the second is refused here,
  // where it can still be explained, rather than at fire time.
  function scheduleIntent({ resource, facilityName, date, startTime, endTime, purpose, coAttendee, repeat }) {
    let list = loadIntents();
    const isoDate = isoDateLocal(date);
    if (conflictingIntent(resource.name, isoDate, list)) return null;

    // A daily series starting today covers every day going forward. Any daily series
    // set for a future date is now superseded and must be replaced to avoid clashes.
    if (repeat === 'daily') {
      const futures = futureDailyIntents(resource.name, isoDate, list);
      if (futures.length > 0) {
        const futureIds = new Set(futures.map((f) => f.id));
        list = list.filter((i) => !futureIds.has(i.id));
      }
    }

    const intent = {
      id: `i${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      resourceId: resource.resourceId,
      resourceName: resource.name,
      facilityName: facilityName || '',
      date: isoDate,
      startTime,
      endTime,
      // Carried through to createReservation, the same two fields the manual
      // booking panel sends. Rooms want them; sports facilities have nothing
      // meaningful to put in either.
      purpose: purpose || '',
      coAttendee: coAttendee || '',
      // 'daily' re-arms for the same time tomorrow once this one is settled;
      // anything falsy is a one-off.
      repeat: repeat || null,
      state: 'waiting',
      message: '',
      createdAt: Date.now(),
    };
    list.push(intent);
    saveIntents(list, { type: 'scheduled', intent });
    return intent;
  }

  // A recurring intent is not a rule that fires forever: each occurrence
  // spawns the next only once it has actually been settled. So stopping a
  // series is just removing the one waiting intent — there is no separate
  // series object to unwind — and a failing intent cannot build a backlog,
  // because nothing is created until something resolves.
  // How far ahead to look for a free day before giving up. A daily series
  // only ever needs to step over days the user has claimed by hand, and
  // seven of those in a row means something else is going on.
  const SERIES_LOOKAHEAD_DAYS = 7;

  // Returns the occurrence it pushed, or null if the whole lookahead is
  // claimed — the caller may have something to say about that.
  function spawnNextOccurrence(intent, list) {
    if (intent.repeat !== 'daily') return null;
    const start = slotStartDate(intent.date, intent.startTime);
    if (!start) return null;
    // Step over any day already claimed for this resource class rather than
    // stopping at it. This used to `return` on the first clash, which killed
    // the series outright: schedule a one-off gym for Friday, then a daily
    // from Tuesday, and the daily would run Tue, Wed, Thu and then silently
    // never again — dying exactly when it met the booking you had made
    // yourself, with nothing to say it had. One booking a day still holds;
    // the series just resumes the day after.
    for (let ahead = 1; ahead <= SERIES_LOOKAHEAD_DAYS; ahead++) {
      const nextDate = isoDateLocal(addDays(start, ahead));
      if (conflictingIntent(intent.resourceName, nextDate, list)) continue;
      const next = {
        ...intent,
        id: `i${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        date: nextDate,
        state: 'waiting',
        message: '',
        seen: false,
        createdAt: Date.now(),
      };
      list.push(next);
      return next;
    }
    return null;
  }

  // A daily series begun from a booking that was made right now, rather than
  // from an intent waiting for its window. The slot for `date` is already
  // booked by the time this is called, so there is no intent for it and
  // nothing to settle — the series starts at the next occurrence, which is
  // exactly what spawnNextOccurrence produces once a day is done with.
  //
  // The rules a series answers to are the same whichever panel started it:
  // a series beginning today supersedes any daily set for a later day, and
  // it steps over days already claimed rather than stopping at the first.
  // Returns the armed occurrence, or null if the lookahead found no free day.
  function startDailySeries({ resource, facilityName, date, startTime, endTime, purpose, coAttendee }) {
    let list = loadIntents();
    const isoDate = isoDateLocal(date);
    const futures = futureDailyIntents(resource.name, isoDate, list);
    if (futures.length > 0) {
      const futureIds = new Set(futures.map((f) => f.id));
      list = list.filter((i) => !futureIds.has(i.id));
    }
    const next = spawnNextOccurrence({
      resourceId: resource.resourceId,
      resourceName: resource.name,
      facilityName: facilityName || '',
      date: isoDate,
      startTime,
      endTime,
      purpose: purpose || '',
      coAttendee: coAttendee || '',
      repeat: 'daily',
      state: 'waiting',
      message: '',
      createdAt: Date.now(),
    }, list);
    // Nothing armed means nothing changed: the future series that would have
    // been replaced is left alone rather than removed in favour of a series
    // that does not exist.
    if (next) saveIntents(list, { type: 'scheduled', intent: next });
    return next;
  }

  function removeIntent(id) {
    const list = loadIntents();
    const removed = list.find((i) => i.id === id);
    saveIntents(list.filter((i) => i.id !== id), removed ? { type: 'cancelled', intent: removed } : undefined);
  }

  // One booking per resource class per calendar day — and "class" is the
  // resource without its operating-window suffix, so the 6 AM gym and the
  // 3 PM gym are the same thing as far as the rule is concerned. Checking
  // first turns a guaranteed refusal into a clear message.
  // The booking already held for this resource class on this date, if any.
  // Exported so the manual booking panel can ask the same question before
  // submitting, rather than sending a request the portal is certain to
  // refuse and showing the refusal as an error.
  async function existingBookingFor(resourceName, isoDate) {
    const userId = await resolveUserId();
    const bookings = cache.bookings || (cache.bookings = await callAura('CustomBookingController', 'getReservations', { userId }));
    const wanted = resourceClassKey(resourceName);
    return bookings.find((b) => {
      if (b.status !== 'Booked') return false;
      const when = parseBookingDateTime(b.startDateTime);
      return isoDateLocal(when) === isoDate && resourceClassKey(b.resourceName) === wanted;
    }) || null;
  }

  async function alreadyBookedThatDay(intent) {
    return !!(await existingBookingFor(intent.resourceName, intent.date));
  }

  // "in 3h 20m" / "in 12m" — a countdown reads better than a wall-clock
  // time here, because what matters is how long the wait is, not when.
  function relativeFuture(ts) {
    const diff = ts - Date.now();
    if (diff <= 0) return 'now';
    const mins = Math.round(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }

  function intentSummary(intent) {
    const when = slotStartDate(intent.date, intent.startTime);
    const day = when ? shortDayLabel(when) : intent.date;
    return `${cleanResourceName(intent.resourceName)} · ${day} · ${compactTimeRange(intent.startTime, intent.endTime || intent.startTime)}`;
  }

  // Same in-row confirm as a real booking's Cancel (see attachCancelConfirm
  // in tabs/bookings.js): the name becomes the question, Yes sits left of
  // No so a double-tap on the old Stop spot can't confirm anything, and
  // only one row across the page asks at a time. Stopping an intent is a
  // synchronous localStorage edit, not a network call, so there's no
  // failure state to hold — Yes always succeeds.
  function buildScheduledRow(intent, onChange) {
    const opensAt = intentOpensAt(intent);
    // A daily repeat is one row, not a queue: the next occurrence is not
    // created until this one has been settled, so the list never grows
    // into a wall of pending days.
    const summary = intent.repeat === 'daily' ? `${intentSummary(intent)} · daily` : intentSummary(intent);
    const noteText = intent.message
      || (opensAt
        ? `Opens ${relativeFuture(opensAt.getTime())} — tries while the app is open.${intent.repeat === 'daily' ? ' Repeats until stopped.' : ''}`
        : '');

    const row = el('div', { class: 'fr-sched-row' });
    const name = el('p', { class: 'fr-sched-name', text: summary, title: summary });
    const note = el('p', { class: 'fr-sched-note', text: noteText, title: noteText });
    const main = el('div', { class: 'fr-sched-main' }, [name, note]);
    row.appendChild(main);

    const wrap = el('div', { class: 'fr-cancel-wrap' });
    row.appendChild(wrap);

    const trigger = el('button', {
      class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Stop', 'aria-expanded': 'false',
      // Removing the one waiting intent ends the series outright, because
      // nothing spawns the next until this one resolves.
      title: intent.repeat === 'daily' ? 'Stops this and the daily repeat' : 'Stops this autobook',
    });
    const yesBtn = el('button', { class: 'fr-btn fr-btn--danger fr-btn--sm', type: 'button', text: 'Yes' });
    const noBtn = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'No' });

    function showIdle() {
      row.classList.remove('is-confirming');
      name.textContent = summary;
      name.title = summary;
      trigger.setAttribute('aria-expanded', 'false');
      wrap.replaceChildren(trigger);
    }
    row.__frCloseConfirm = showIdle;

    trigger.addEventListener('click', (e) => {
      for (const other of ui.contentEl.querySelectorAll('.fr-sched-row.is-confirming')) {
        if (other !== row && other.__frCloseConfirm) other.__frCloseConfirm();
      }
      row.classList.add('is-confirming');
      const asking = `Stop ${summary}?`;
      name.textContent = asking;
      name.title = asking;
      trigger.setAttribute('aria-expanded', 'true');
      wrap.replaceChildren(yesBtn, noBtn);
      if (e.detail === 0) noBtn.focus();
    });

    noBtn.addEventListener('click', () => {
      showIdle();
      trigger.focus();
    });

    row.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && row.classList.contains('is-confirming')) {
        showIdle();
        trigger.focus();
      }
    });

    yesBtn.addEventListener('click', () => {
      removeIntent(intent.id);
      if (onChange) onChange();
      paintAutoBookBanner();
    });

    showIdle();
    return row;
  }

  // The My Bookings variant: a real .fr-row, same 70px rhythm as an actual
  // booking. Dashed instead of solid is the same "not real yet" language
  // .fr-slot--later already carries. Title says what this is ("Autobook ·
  // Gym") and meta says when (day · time), same split a real row makes
  // between its title (what) and its pill (status) — the pill here says
  // "Pending" rather than repeating "Autobook", which the title already
  // said. Cancel prefixes onto the title on confirm ("Cancel Autobook ·
  // Gym?"), same as attachCancelConfirm's `Cancel ${name}?`.
  //
  // The "opens in Xh" status is always visible in meta, not behind a hover
  // or a tap — this is a touch app first (Android WebView), nothing to
  // hover, and Book Slot's own grid already draws "Opens in 6h 17m"
  // directly on a dashed slot tile the same way, no interaction needed.
  // The full "tries while the app is open" sentence is dropped: the
  // dashed border + Pending pill already say "not guaranteed" on their
  // own, so the countdown is the only new fact meta has to carry.
  function pendingIntentText(intent) {
    const name = cleanResourceName(intent.resourceName);
    const when = slotStartDate(intent.date, intent.startTime);
    const day = when ? shortDayLabel(when) : intent.date;
    const timeRange = compactTimeRange(intent.startTime, intent.endTime || intent.startTime);
    const opensAt = intentOpensAt(intent);
    const statusText = intent.message || (opensAt ? `Opens ${relativeFuture(opensAt.getTime())}` : '');
    let whenText = `${day} · ${timeRange}`;
    if (statusText) whenText += ` · ${statusText}`;
    if (intent.repeat === 'daily') whenText += ' · Daily';
    return { label: `Autobook · ${name}`, whenText };
  }

  // Home's glance version: same title/meta/pill as the My Bookings row below,
  // minus the cancel control — Home never offers actions, only My Bookings
  // does, so a pending intent shown there is read-only.
  function buildPendingBookingBadge(intent) {
    const { label, whenText } = pendingIntentText(intent);
    const row = el('div', { class: 'fr-row fr-row--pending' });
    const title = el('p', { class: 'fr-row-title', text: label, title: label });
    const meta = el('p', { class: 'fr-row-meta', text: whenText, title: whenText });
    row.appendChild(el('div', { class: 'fr-row-main' }, [title, meta]));
    row.appendChild(el('div', { class: 'fr-row-actions' }, [el('span', { class: 'fr-badge is-pending', text: 'Pending' })]));
    return row;
  }

  function buildPendingBookingRow(intent, onChange) {
    const { label, whenText } = pendingIntentText(intent);

    const row = el('div', { class: 'fr-row fr-row--pending' });
    const title = el('p', { class: 'fr-row-title', text: label, title: label });
    const meta = el('p', { class: 'fr-row-meta', text: whenText, title: whenText });
    const main = el('div', { class: 'fr-row-main' }, [title, meta]);
    row.appendChild(main);

    const actions = el('div', { class: 'fr-row-actions' });
    actions.appendChild(el('span', { class: 'fr-badge is-pending', text: 'Pending' }));
    const wrap = el('div', { class: 'fr-cancel-wrap' });
    actions.appendChild(wrap);
    row.appendChild(actions);

    const trigger = el('button', {
      class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Cancel', 'aria-expanded': 'false',
      title: intent.repeat === 'daily' ? 'Cancels this and the daily repeat' : 'Cancels this autobook',
    });
    const yesBtn = el('button', { class: 'fr-btn fr-btn--danger fr-btn--sm', type: 'button', text: 'Yes' });
    const noBtn = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'No' });

    function showIdle() {
      row.classList.remove('is-confirming');
      title.textContent = label;
      title.title = label;
      trigger.setAttribute('aria-expanded', 'false');
      wrap.replaceChildren(trigger);
    }
    row.__frCloseConfirm = showIdle;

    trigger.addEventListener('click', (e) => {
      for (const other of ui.contentEl.querySelectorAll('.fr-row.is-confirming')) {
        if (other !== row && other.__frCloseConfirm) other.__frCloseConfirm();
      }
      row.classList.add('is-confirming');
      const asking = `Cancel ${label}?`;
      title.textContent = asking;
      title.title = asking;
      trigger.setAttribute('aria-expanded', 'true');
      wrap.replaceChildren(yesBtn, noBtn);
      if (e.detail === 0) noBtn.focus();
    });

    noBtn.addEventListener('click', () => {
      showIdle();
      trigger.focus();
    });

    row.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && row.classList.contains('is-confirming')) {
        showIdle();
        trigger.focus();
      }
    });

    yesBtn.addEventListener('click', () => {
      removeIntent(intent.id);
      if (onChange) onChange();
      paintAutoBookBanner();
    });

    showIdle();
    return row;
  }

  // The list of what is being watched, shown under the slot grid, and under
  // the relevant day section in My Bookings. Also the only place a
  // scheduled slot can be called off from another tab.
  //
  // `intents` lets a caller hand in an already-filtered subset (My Bookings
  // buckets waiting intents by which day they'd land on) instead of always
  // taking every waiting intent in one lump.
  function buildScheduledList(onChange, intents) {
    const waiting = loadIntents().filter((i) => i.state === 'waiting');
    const wrap = el('div', { class: 'fr-sched' });
    if (!waiting.length) return wrap;
    wrap.appendChild(el('h3', { class: 'fr-sched-title', text: 'Booking automatically' }));
    for (const intent of waiting) wrap.appendChild(buildScheduledRow(intent, onChange));
    return wrap;
  }

  // Results surface wherever you happen to be when they land, since the
  // booking fires while you are doing something else entirely.
  //
  // Painted incrementally rather than rebuilt: replaceChildren() would
  // re-run the entrance animation on every remaining banner each time one
  // was dismissed, which reads as the whole stack flinching. Each banner
  // owns a slot keyed by its intent id, and only genuinely new ones animate
  // in, only genuinely gone ones animate out.

  // Long enough to cover the CSS transitions above, with room to spare. The
  // timer is a fallback, not the mechanism — transitionend does the real
  // work whenever the page is actually rendering.
  const BANNER_EXIT_MS = 400;

  // The banner itself, independent of what raised it. A settled intent is
  // one caller; explaining why a slot is greyed out is another.
  function buildBannerSlot({ tone, title, note, onDismiss }) {
    const slot = el('div', { class: 'fr-banner-slot' });
    const clip = el('div', { class: 'fr-banner-clip' });
    const banner = el('div', { class: `fr-banner ${tone}` });
    banner.appendChild(el('div', { class: 'fr-banner-main' }, [
      el('p', { class: 'fr-banner-title', text: title }),
      el('p', { class: 'fr-banner-note', text: note || '' }),
    ]));
    const ok = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Dismiss' });
    ok.addEventListener('click', () => onDismiss(slot));
    banner.appendChild(ok);
    clip.appendChild(banner);
    slot.appendChild(clip);
    return slot;
  }

  function intentBannerSlot(intent) {
    const slot = buildBannerSlot({
      tone: intent.state === 'done' ? 'is-good' : 'is-bad',
      title: intent.state === 'done' ? `Booked ${intentSummary(intent)}` : `Couldn't book ${intentSummary(intent)}`,
      note: intent.message || '',
      onDismiss: () => {
        const all = loadIntents();
        const found = all.find((i) => i.id === intent.id);
        if (found) found.seen = true;
        saveIntents(all.filter((i) => i.state === 'waiting' || !i.seen));
        // Repaint decides what leaves; the animation lives in one place.
        paintAutoBookBanner();
      },
    });
    slot.dataset.intent = intent.id;
    return slot;
  }

  // A one-off message in the same place booking results appear. Used to
  // answer "why can't I tap this?" on demand, rather than repeating the
  // reason on every greyed tile in the grid.
  const NOTICE_LINGER_MS = 6000;

  function showNotice({ title, note, tone = 'is-bad' }) {
    if (!ui.bannerHost) return;
    const slot = buildBannerSlot({ tone, title, note, onDismiss: closeBannerSlot });
    slot.dataset.notice = '1';
    // Replace any previous notice: tapping four greyed tiles should not
    // stack four identical explanations.
    for (const other of Array.from(ui.bannerHost.children)) {
      if (other.dataset.notice === '1') closeBannerSlot(other);
    }
    ui.bannerHost.appendChild(slot);
    openBannerSlot(slot);
    // Informational and self-inflicted, so it leaves on its own. A booking
    // result never does — that one you have to see.
    setTimeout(() => closeBannerSlot(slot), NOTICE_LINGER_MS);
  }

  function openBannerSlot(slot) {
    // Reading a layout property flushes pending style, so the browser has a
    // "closed" frame to transition *from*. Deliberately not
    // requestAnimationFrame: runAutoBook can land while the Android boot
    // cover is still up, and an obscured WebView may not produce frames at
    // all — rAF would never fire and the banner would stay collapsed. A
    // forced reflow needs no frame.
    void slot.offsetHeight;
    slot.classList.add('is-open');
  }

  function closeBannerSlot(slot) {
    if (slot.dataset.leaving === '1') return;
    slot.dataset.leaving = '1';
    slot.classList.remove('is-open');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      slot.remove();
    };
    // Whichever comes first: the real transition ending, or the fallback for
    // when transitions never run (reduced motion, a tab that is not
    // rendering). Without the fallback a slot could sit at zero height
    // forever, invisible but still in the DOM.
    slot.addEventListener('transitionend', (e) => {
      if (e.target === slot && e.propertyName === 'grid-template-rows') finish();
    });
    setTimeout(finish, BANNER_EXIT_MS);
  }

  function paintAutoBookBanner() {
    if (!ui.bannerHost) return;
    const unseen = loadIntents().filter((i) => (i.state === 'done' || i.state === 'failed') && !i.seen);
    const wanted = new Set(unseen.map((i) => i.id));
    const slots = Array.from(ui.bannerHost.children);

    // Gone: animate out. Already-leaving slots are left alone, and notices
    // are not ours to reconcile — they have their own lifetime.
    for (const slot of slots) {
      if (slot.dataset.notice === '1') continue;
      if (!wanted.has(slot.dataset.intent)) closeBannerSlot(slot);
    }

    // New: append and animate in. A slot on its way out does not count as
    // present, so a result that somehow returns gets a fresh entrance.
    const present = new Set(
      slots.filter((s) => s.dataset.leaving !== '1').map((s) => s.dataset.intent)
    );
    for (const intent of unseen) {
      if (present.has(intent.id)) continue;
      const slot = intentBannerSlot(intent);
      ui.bannerHost.appendChild(slot);
      openBannerSlot(slot);
    }
  }

  let autoBookRunning = false;
  let lastAutoBookRun = 0;

  // Returns true if anything changed, so callers can repaint.
  async function runAutoBook() {
    if (autoBookRunning) return false;
    let list = loadIntents();
    const waiting = list.filter((i) => i.state === 'waiting');
    if (!waiting.length) return false;
    // The preview harness stubs callAura entirely, so it has no token to
    // wait for — but the runner is exactly the thing worth exercising there.
    if (!window.__FLAME_RESKIN_PREVIEW__ && (!auraState.context || !auraState.token)) return false;

    autoBookRunning = true;
    lastAutoBookRun = Date.now();
    let changed = false;
    // Belt and braces for the one-per-class-per-day rule: scheduleIntent
    // refuses a second intent up front, but intents saved before that rule
    // existed are still sitting in localStorage, and a booking made earlier
    // in this same pass is not in cache.bookings's snapshot either.
    const claimed = new Set();
    // Every intent that actually settles (done/failed) this pass, so the
    // save at the end can tell hook.src.js what happened -- not just the
    // current snapshot -- and it can fire the real notification even though
    // this whole run only happens while the app is open (native stands down
    // then, see AutobookReceiver's own foreground check).
    const settledThisPass = [];
    try {
      for (const intent of waiting) {
        const classKey = `${resourceClassKey(intent.resourceName)}|${intent.date}`;
        if (claimed.has(classKey)) {
          intent.state = 'failed';
          intent.message = `Only one ${cleanResourceName(intent.resourceName)} booking a day — another slot was already taken for ${intent.date}.`;
          settledThisPass.push(intent);
          changed = true;
          continue;
        }
        const start = slotStartDate(intent.date, intent.startTime);
        const opensAt = intentOpensAt(intent);
        if (!start || !opensAt) {
          intent.state = 'failed';
          intent.message = 'Could not read that slot time.';
          settledThisPass.push(intent);
          changed = true;
          continue;
        }
        if (Date.now() >= start.getTime()) {
          intent.state = 'failed';
          intent.message = 'The slot started before it could be booked.';
          // Settled, so the series moves on. A morning the app was never
          // opened in must not be the morning the series quietly ends.
          spawnNextOccurrence(intent, list);
          settledThisPass.push(intent);
          changed = true;
          continue;
        }
        // No early margin: the 24h rule is confirmed, not a guess, and a
        // network call is seconds at most -- nothing here benefits from
        // starting 30 minutes before opensAt (matches the native port's own
        // fix, same reasoning).
        if (Date.now() < opensAt.getTime()) continue;

        try {
          if (await alreadyBookedThatDay(intent)) {
            claimed.add(classKey);
            intent.state = 'failed';
            intent.message = `You already have a ${cleanResourceName(intent.resourceName)} booking that day.`;
            // The same death spawnNextOccurrence's lookahead was written to
            // prevent, by the other door: a day claimed by a *booking* rather
            // than by an intent settled this occurrence and spawned nothing,
            // so a series met the first day you had booked by hand and
            // silently never ran again. One booking a day still holds — the
            // series just resumes the day after.
            spawnNextOccurrence(intent, list);
            settledThisPass.push(intent);
            changed = true;
            continue;
          }
          const raw = await callAura('CustomBookingController', 'getResourceAvailability', {
            resourceId: intent.resourceId,
            bookingDate: intent.date,
          });
          let slots = [];
          try {
            slots = (JSON.parse(raw) || {}).availabilitySlots || [];
          } catch (e) {
            slots = [];
          }
          const match = slots.find((sl) => slotTimeKey(sl.startTime) === slotTimeKey(intent.startTime));
          if (!match || match.availableCapacity <= 0) {
            // Stays waiting: capacity can come back when someone cancels,
            // and there is still time on the clock.
            intent.message = match ? 'Full — still watching.' : 'Not listed yet — still watching.';
            changed = true;
            continue;
          }
          const userId = await resolveUserId();
          const result = await callAura('CustomBookingController', 'createReservation', {
            userId,
            resource: intent.resourceId,
            startTime: intent.startTime,
            endTime: intent.endTime,
            dateSelected: intent.date,
            bookingPurpose: intent.purpose || '',
            coAttendee: intent.coAttendee || '',
          });
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          if (/booking id/i.test(text)) {
            intent.state = 'done';
            intent.message = text;
            claimed.add(classKey);
            cache.bookings = null;
            clearPersistedBookings();
            spawnNextOccurrence(intent, list);
            settledThisPass.push(intent);
          } else if (/within\s*1\s*day/i.test(text)) {
            // The portal's own "too early" refusal -- confirmed live
            // (2026-09-11): a premature attempt (from the since-removed
            // 30-min-early bug) got back "...select a slot within 1 day."
            // and was wrongly marked a permanent failure. Not terminal: the
            // window genuinely hasn't opened yet, same as "Full"/"not listed".
            intent.message = 'Not open yet — still watching.';
          } else {
            // createReservation answers refusals with state:SUCCESS and a
            // plain string, so the text is the only signal there is.
            intent.state = 'failed';
            intent.message = text;
            // A refused day says nothing about tomorrow, so a series
            // survives a refusal.
            spawnNextOccurrence(intent, list);
            settledThisPass.push(intent);
          }
          changed = true;
        } catch (e) {
          intent.message = `Attempt failed: ${e.message}`;
          changed = true;
        }
      }
      if (changed) saveIntents(list, settledThisPass.length ? { type: 'settled', intents: settledThisPass } : undefined);
    } finally {
      autoBookRunning = false;
    }
    if (changed) paintAutoBookBanner();
    return changed;
  }

  // While the app is open, tighten the loop as an intent's opening moment
  // approaches — that is the only way this version ever wins a contested
  // slot, and it costs one cheap local check a few times a minute.
  function startAutoBookLoop() {
    setInterval(() => {
      const waiting = loadIntents().filter((i) => i.state === 'waiting');
      if (!waiting.length) return;
      const now = Date.now();
      const soon = waiting.some((i) => {
        const opensAt = intentOpensAt(i);
        return opensAt && now >= opensAt.getTime();
      });
      const interval = soon ? 15000 : 120000;
      if (now - lastAutoBookRun >= interval) runAutoBook();
    }, 5000);
  }

  // ---------------------------------------------------------------------
  // 6. Icons (authored inline SVG, not emoji/unicode)
  // ---------------------------------------------------------------------

  const ICONS = {
    home: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/></svg>',
    calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
    bookings: '<svg viewBox="0 0 24 24"><path d="M6 4h12v16l-6-4-6 4V4z"/></svg>',
    // A stopwatch: circle, hands, crown. It was keyed `book` for the Book Slot
    // tab it was drawn for, which made every other call site read as if it
    // asked for a book and got a clock. The glyph never changed; the name did.
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 3h6"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M12 3c-.8 2.6-3.2 3.7-3.2 6.8a3.2 3.2 0 0 0 6.4 0c0-1-.6-1.6-.9-2.4 1.4.9 2.7 2.6 2.7 4.7a5 5 0 0 1-10 0C7 8.3 9.6 5.6 12 3z"/></svg>',
    spinner: '<svg viewBox="0 0 24 24" class="fr-spinner-svg"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
    utensils: '<svg viewBox="0 0 24 24"><path d="M18 2v20M18 2a4 4 0 0 0-4 4v4h8V6a4 4 0 0 0-4-4zM6 2v7a3 3 0 0 0 6 0V2M9 2v18"/></svg>',
  };

  function icon(name, extraClass) {
    const span = document.createElement('span');
    span.className = extraClass ? `icon ${extraClass}` : 'icon';
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  // ---------------------------------------------------------------------
  // Settings — small, persisted, user-facing toggles. No settings screen
  // yet; this is the stub a future one swaps into. `settings` is read
  // directly wherever a toggle matters (same shared-mutable-object
  // convention as `ui`/`cache` in state.js); `setSetting()` is the one
  // write path, so anything that changes a setting also persists it.
  // ---------------------------------------------------------------------

  const STORAGE_KEY = 'flame-settings';

  const defaults = {
    // Nav-pill slide, swipe drag-follow, tab crossfades — everything
    // `reduceMotion()` in shell.js gates. Off collapses all of it to an
    // instant cut, same as the OS-level prefers-reduced-motion already
    // does; this is a user override on top of that, not a replacement.
    motion: true,
  };

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved ? { ...defaults, ...saved } : { ...defaults };
    } catch (e) {
      return { ...defaults };
    }
  }

  const settings = load();

  function setSetting(key, value) {
    settings[key] = value;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // 5. Stock-UI toggle + the long-press menu that reaches it on mobile
  // ---------------------------------------------------------------------


  function setReskinOff(nextOff) {
    document.body.classList.toggle('flame-reskin-off', nextOff);
    localStorage.setItem('flame-reskin-enabled', nextOff ? 'false' : 'true');
  }

  // Desktop top-bar button — only needs to switch *off* (it lives inside
  // #flame-reskin-root, so it vanishes along with everything else the
  // instant it's hidden; nothing needs to re-paint it afterward). Hidden
  // entirely on mobile — see attachHomeLongPress() for the mobile switch.
  function buildStockToggle(className) {
    const btn = el('button', { class: className, type: 'button', text: 'Stock UI', title: 'Show the original portal UI' });
    btn.addEventListener('click', () => setReskinOff(true));
    return btn;
  }

  // The long-press menu itself: two rows ("Original UI", "Settings"), the
  // second swapping the same panel's content to a settings view rather than
  // opening a second layer — there's no router here, and a whole extra
  // overlay for one switch would be more chrome than the setting is worth.
  // Built once, reused for every long-press (a fresh node per press would
  // just be repeated work for something that already resets its own view
  // on open).
  //
  // Positioned via the anchor button's own getBoundingClientRect() at open
  // time rather than a CSS anchor: the panel can't be a DOM child of the
  // nav button itself (nested <button>s are invalid HTML and unreliable to
  // click), so it's appended to ui.root as a sibling and placed with fixed
  // coordinates instead — the standard way to anchor a popover to a
  // trigger that isn't its own positioning context.
  let menuEl = null;
  let menuView = 'root'; // 'root' | 'settings'
  // The click that releases the long-press (finger lifting after the
  // hold) still fires a real trailing `click`, arriving *after* openMenu()
  // has already registered the outside-click listener below — document's
  // own capture-phase listener runs before the target's, structurally, so
  // the existing firedLongPress/stopImmediatePropagation guard on the
  // button (below) can't reach back and stop it from being seen here first.
  // Rather than fight event-phase ordering, the very next document click
  // after an open is just never treated as a dismiss — it can only be that
  // trailing click, since the user's finger can't produce a second one
  // without lifting first.
  let suppressNextDocClick = false;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.classList.remove('is-open');
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeydown, true);
  }
  function onDocClick(e) {
    if (suppressNextDocClick) {
      suppressNextDocClick = false;
      return;
    }
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') closeMenu();
  }

  function paintMenu() {
    menuEl.replaceChildren();
    if (menuView === 'root') {
      const original = el('button', { class: 'fr-picker-option', type: 'button', role: 'menuitem', text: 'Original UI' });
      original.addEventListener('click', () => {
        closeMenu();
        setReskinOff(true);
      });
      const settingsBtn = el('button', { class: 'fr-picker-option', type: 'button', role: 'menuitem', text: 'Settings' });
      settingsBtn.addEventListener('click', () => {
        menuView = 'settings';
        paintMenu();
      });
      menuEl.append(original, settingsBtn);
    } else {
      const sw = buildSwitch({
        label: 'Swipe animations',
        hint: 'Sliding tab transitions and drag-to-swipe. Off switches tabs instantly, no sideways motion.',
        checked: settings.motion,
        onChange: (on) => setSetting('motion', on),
      });
      sw.el.classList.add('fr-navmenu-setting');
      menuEl.append(sw.el);
    }
  }

  function openMenu(anchorBtn) {
    if (!menuEl) {
      menuEl = el('div', { class: 'fr-navmenu-panel', role: 'menu' });
      ui.root.appendChild(menuEl);
    }
    menuView = 'root';
    paintMenu();
    const r = anchorBtn.getBoundingClientRect();
    // Gap is measured from the nav bar itself, not the button — the bar
    // has its own padding above the button (~8px), so anchoring off the
    // button's own top edge ate that padding as part of the "gap" and the
    // panel ended up sitting flush against the bar with nothing visible
    // between them.
    const navRect = (anchorBtn.closest('.fr-nav') || anchorBtn).getBoundingClientRect();
    menuEl.style.left = `${Math.round(r.left)}px`;
    menuEl.style.bottom = `${Math.round(window.innerHeight - navRect.top + 12)}px`;
    // Flush the closed/unpositioned state before adding is-open, or the
    // browser can coalesce "just created" and "open" into one paint and
    // the entrance transition never plays — same belt-and-braces as every
    // other inline-transform animation in this app.
    void menuEl.offsetWidth;
    suppressNextDocClick = true;
    menuEl.classList.add('is-open');
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeydown, true);
  }

  // Mobile has no spare chrome for a Stock-UI control: the bottom tab bar
  // is full, and every fixed/floating overlay tried so far ended up
  // sitting on top of some tab's own content sooner or later. A long-press
  // on the Home tab needs none — it's the one tab guaranteed present in
  // every layout, and long-press-for-a-secondary-action is an established
  // mobile convention (app icons, list rows) rather than an invented one.
  // Only fires below the mobile breakpoint; on desktop this is a no-op and
  // the explicit top-bar button (above) is the real control.
  //
  // The hold used to switch straight to the stock UI; it now opens the
  // small menu above instead, with "Original UI" as the first of its two
  // rows — same destination, one tap further, in exchange for a path to
  // Settings that didn't otherwise have anywhere to live on mobile.
  function attachHomeLongPress(btn) {
    const HOLD_MS = 550;
    let timer = null;
    let firedLongPress = false;
    const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
    const start = () => {
      if (!isMobile()) return;
      firedLongPress = false;
      btn.classList.add('is-pressing');
      timer = setTimeout(() => {
        firedLongPress = true;
        btn.classList.remove('is-pressing');
        if (navigator.vibrate) navigator.vibrate(15);
        openMenu(btn);
      }, HOLD_MS);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      btn.classList.remove('is-pressing');
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    // Suppress the tap-to-navigate that would otherwise also fire right
    // after a long-press release: without this, releasing on Home re-runs
    // Home's own click-to-switchTab handler an instant after the menu
    // opens, which is a no-op if Home was already the open tab but a real,
    // unwanted navigation away from whatever tab the long-press was
    // actually performed from.
    btn.addEventListener(
      'click',
      (e) => {
        if (firedLongPress) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true
    );
  }

  // The one control that has to live outside #flame-reskin-root: switching
  // back *on* has to work from the stock page, which has none of our DOM.
  // Only ever visible while off (CSS-gated, see body.flame-reskin-off
  // #flame-reskin-toggle) — at that point #flame-reskin-root is hidden
  // entirely, so unlike the in-shell buttons above, this one can never
  // collide with anything of ours regardless of which tab was last open.
  function buildToggleButton() {
    const stored = localStorage.getItem('flame-reskin-enabled');
    document.body.classList.toggle('flame-reskin-off', stored === 'false');

    ui.toggleBtn = el('button', {
      id: 'flame-reskin-toggle', type: 'button', text: 'Custom UI', title: 'Switch back to the reskinned portal',
    });
    ui.toggleBtn.addEventListener('click', () => setReskinOff(false));
    document.body.appendChild(ui.toggleBtn);
  }

  // ---------------------------------------------------------------------
  // 8. Shell + tab switching
  // ---------------------------------------------------------------------


  const TABS = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { id: 'bookings', label: 'My Bookings', icon: 'bookings' },
    { id: 'book-slot', label: 'Book Slot', icon: 'clock' },
    { id: 'gyan', label: 'Gyan', icon: 'sparkle' },
  ];

  function renderLoading() {
    ui.contentEl.replaceChildren(el('div', { class: 'fr-loading' }, [el('div', { class: 'fr-spinner' }), el('span', { text: 'Loading…' })]));
  }

  function renderErrorPanel(message, retry) {
    const box = el('div', { class: 'fr-empty fr-empty--error' });
    box.append(
      el('p', { class: 'fr-empty-title', text: 'Something went wrong' }),
      el('p', { class: 'fr-empty-text', text: message })
    );
    const btn = el('button', { class: 'fr-btn fr-btn--ghost', type: 'button', text: 'Retry' });
    btn.addEventListener('click', retry);
    box.appendChild(btn);
    ui.contentEl.replaceChildren(box);
  }

  function renderEmpty(iconName, title, text, extraClass, action) {
    const box = el('div', { class: extraClass ? `fr-empty ${extraClass}` : 'fr-empty' });
    box.appendChild(icon(iconName, 'fr-empty-icon'));
    box.appendChild(el('p', { class: 'fr-empty-title', text: title }));
    if (text) box.appendChild(el('p', { class: 'fr-empty-text', text }));
    // An empty state that can be acted on says so. Optional, because most
    // of them (no classes today) have nothing to offer but the fact.
    if (action) {
      const btn = el('button', { class: 'fr-btn fr-btn--ghost fr-empty-action', type: 'button', text: action.label });
      btn.addEventListener('click', action.onClick);
      box.appendChild(btn);
    }
    return box;
  }

  // Filled by main.js. Deliberately not `{ home: renderHome, ... }` here:
  // naming the tab modules from the shell would make the dependency circular
  // (every tab imports switchTab/renderEmpty back out of this file), and a
  // cycle whose modules read each other's values at import time is exactly
  // the kind that breaks on a bundler setting nobody remembers changing.
  const RENDERERS = {};

  function registerRenderers(map) {
    Object.assign(RENDERERS, map);
  }

  // Guards against a slower response landing after a faster one: if the
  // user switches tabs again before the first tab's data has finished
  // loading, only the render whose token still matches is allowed to touch
  // ui.contentEl. Each render function checks `token === ui.activeToken` right
  // before its final ui.contentEl.replaceChildren(...) call.
  let currentTab = null;
  let navPill = null;
  let navPillPositioned = false;

  // Slides the shared highlight under whichever button is now .is-active.
  // `animate: false` is for the two moments a jump would read as a bug
  // rather than a state change: the very first paint (nothing to slide
  // from) and a breakpoint flip (the bar itself just became a different
  // shape, top bar to bottom bar or back — sliding across that jump reads
  // as a glitch, not a transition).
  function positionNavPill(animate = true) {
    if (!navPill) return;
    const activeBtn = navPill.parentElement && navPill.parentElement.querySelector('.fr-nav-btn.is-active');
    if (!activeBtn) return;
    if (!animate || !navPillPositioned) {
      navPill.style.transition = 'none';
    }
    navPill.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    navPill.style.width = `${activeBtn.offsetWidth}px`;
    if (!animate || !navPillPositioned) {
      void navPill.offsetHeight; // flush before handing the transition back
      navPill.style.transition = '';
      navPillPositioned = true;
    }
  }

  // Everything about a tab switch that isn't rendering: which nav button is
  // lit, where the pill sits, and clearing a stale focus ring. Split out of
  // switchTab so crossfadeToTab (a real tab-to-tab transition) can do this
  // immediately, in sync with the slide starting, without going through
  // switchTab's own loading-spinner-then-render sequence.
  function activateNavChrome(id) {
    currentTab = id;
    const token = ++ui.activeToken;
    ui.root.querySelectorAll('.fr-nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === id));
    // A tapped button keeps focus — and with it the accent *:focus-visible
    // ring — long after the pill has moved on. Harmless while every switch
    // came from a tap on the very button that's now active (focus and the
    // pill were always the same button), but a swipe changes tabs without
    // ever touching a nav button at all, so the ring stays stuck on
    // whichever button was tapped last while the pill correctly slides to
    // wherever you actually are — two different buttons visibly lit at
    // once. The pill and the label colour already say which tab is
    // current; a focus ring left over from a tap two tabs ago doesn't need
    // to keep saying it too.
    const focused = document.activeElement;
    if (focused && focused.classList && focused.classList.contains('fr-nav-btn')) focused.blur();
    positionNavPill();
    return token;
  }

  // Same-pane refresh: re-renders the tab that's already open (a cancel
  // confirm, a retry, the calendar's breakpoint rebuild) in place, with the
  // existing loading-spinner-then-render sequence. Never used for a
  // tab-to-tab move — that's crossfadeToTab, which needs the pane it's
  // rendering into to still exist in isolation (not yet swapped into
  // ui.contentEl's slot) so it can render before it starts sliding.
  async function switchTab(id) {
    const token = activateNavChrome(id);
    if (ui.contentEl) ui.contentEl.classList.toggle('fr-content--gyan', id === 'gyan');
    renderLoading();
    try {
      await RENDERERS[id](token);
    } catch (e) {
      if (token === ui.activeToken) {
        renderErrorPanel(e.message, () => switchTab(id));
      }
      console.error('[flame-reskin]', e);
    }
  }

  // Calendar's header structure (date-strip vs. simple day-nav) depends on
  // the mobile breakpoint, not just CSS — rotating the phone across it
  // while already on that tab needs a real re-render, not just reflow.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentTab === 'calendar') switchTab('calendar');
      // The bar's own shape may have just changed (desktop top bar <->
      // mobile bottom bar) — reposition without a slide, since there is no
      // meaningful "from" across a layout that just became a different bar.
      positionNavPill(false);
    }, 200);
  });

  function reduceMotion() {
    return !settings.motion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Swipe left/right on the content pane to step to the next/previous tab,
  // touch (and pen) only — a mouse drag is left alone, since desktop already
  // has the top bar one click away and a hijacked mouse-drag would fight
  // text selection. Direction-locked against a 10px move so a vertical
  // scroll on .fr-content (which is itself the scrolling element) is never
  // mistaken for a swipe, and a touch starting inside a genuinely
  // horizontally-scrollable child — only Calendar's week-view .fr-cal-scroll
  // — is ignored entirely so that element keeps its own native panning.
  const SWIPE_DIRECTION_LOCK = 14; // was 10 — a slow drag's first few px are noisier than a flick's, give the sample a little more room before deciding
  const SWIPE_COMMIT_PX = 72;
  const SWIPE_COMMIT_VELOCITY = 0.5; // px/ms
  const SWIPE_EDGE_RESISTANCE = 0.35; // dampens the drag past the first/last tab instead of just stopping dead
  // The axis lock's dx-vs-dy comparison (below) is an even fight by default,
  // and a slow, deliberate drag's first several px naturally carries more
  // incidental vertical wobble than a fast flick's — a fast flick's start is
  // a clean, committed, nearly-straight line, so dx wins easily; a slow one
  // is closer to a coin flip, and losing it locks the *whole* gesture to 'y'
  // with nothing to show for it (no spring-back either — axis === 'x' gates
  // everything past the lock, preventDefault included), which reads as "the
  // swipe just didn't do anything" — confirmed on a real device recording:
  // every transition that actually landed did so in well under 350ms (a
  // flick), and the gaps in between where a slow drag was attempted show no
  // partial motion at all, not even a vertical rubber-band, which is what
  // losing this coin flip looks like rather than losing a native-scroll
  // race. This pane's own vertical scroll is the fallback gesture here, the
  // horizontal swipe is the primary one, so the lock is biased hard toward
  // it: dx only needs to clear 45% of dy, not beat it outright — horizontal
  // wins any drag within ~66° of level, real vertical scrolling still wins
  // anything steeper. (First cut of this fix used 0.7/~55° and only
  // partially helped — still not proven sufficient on-device.)
  const SWIPE_AXIS_BIAS = 0.45;

  // Animates content's transform to its resolution, then always ends the
  // same way regardless of why it was called — cleared inline styles and
  // the dragging class off — running `after` only when given one (a spring
  // -back has none; a committed exit does). transitionend is the fast
  // path; the timeout is what actually fires under reduced motion
  // (duration 0 means no transition ever starts) and is the fallback
  // everywhere else, same belt-and-braces as morphHeight.
  function animateContentTo(content, px, duration, after) {
    content.style.transition = reduceMotion() ? 'none' : `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    content.style.transform = `translateX(${px}px)`;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      content.classList.remove('fr-content--dragging');
      content.style.transition = '';
      content.style.transform = '';
      if (after) after();
    };
    content.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, reduceMotion() ? 0 : duration + 60);
  }

  // The one motion both a nav tap and a committed swipe end in: the outgoing
  // pane and a freshly rendered incoming pane slide past each other in a
  // single continuous motion — no point where the screen shows neither.
  // Earlier this was exit-then-snap-then-enter on one shared element: the
  // current page slid fully off (200ms), the container was snapped to the
  // opposite edge, *then* the next tab rendered and slid back in (220ms) —
  // two sequential animations with a blank, fully-off-screen pane sitting
  // between them while the render ran. That blank gap and the doubled
  // duration were the same root cause: rendering only started after the old
  // page was already gone.
  //
  // This awaits the render before sliding anything — not every renderer
  // paints synchronously before its first internal `await` the way Home's
  // does (My Bookings, for one, awaits resolveUserId()/getReservations
  // before touching the DOM at all), so starting the slide without waiting
  // showed an empty, backgroundless pane sliding into place and only
  // getting real content afterwards, with no animation on that part. The
  // await is nearly always cheap: userId and the tab's own cache are
  // already warm by the time a second tab is opened (see "Loading, caching
  // and motion" in HANDOFF), so this only actually waits on the network in
  // the genuinely-uncached case, which is exactly when waiting is honest.
  // `await` here also fixed a real crash on its own: renderGyan used to be
  // the one renderer that wasn't `async`, and the previous version of this
  // function called `.catch()` straight on its return value — `undefined`
  // for renderGyan — throwing synchronously and aborting before the
  // slide-in ever ran, which is why Gyan never appeared at all. renderGyan
  // is `async` now too, for the same reason every renderer is: so nothing
  // here has to know or care which ones actually do async work.
  async function crossfadeToTab(nextId, exitBy) {
    const outgoing = ui.contentEl;
    const incoming = el('main', { class: 'fr-content' });
    incoming.style.transition = 'none';
    incoming.style.transform = `translateX(${-exitBy}px)`;
    ui.viewportEl.appendChild(incoming);
    ui.contentEl = incoming;

    const token = activateNavChrome(nextId);
    incoming.classList.toggle('fr-content--gyan', nextId === 'gyan');

    try {
      await RENDERERS[nextId](token);
    } catch (e) {
      if (token === ui.activeToken) renderErrorPanel(e.message, () => switchTab(nextId));
      console.error('[flame-reskin]', e);
    }

    if (token !== ui.activeToken) {
      // Superseded while this was loading — whatever navigated next already
      // owns ui.contentEl (and, if it's still mid-flight itself, may still
      // be holding a reference to this very pane as *its* outgoing; leaving
      // removal to it is what the token guard is for everywhere else).
      incoming.remove();
      return;
    }

    settlePanes(outgoing, incoming, exitBy, token);
  }

  // Slides `outgoing` the rest of the way off and `incoming` the rest of
  // the way in, together, from whatever their current inline transforms
  // already are — a continuation, not a fresh start, so a pane already
  // mid-drag doesn't jump before settling. Shared by a full crossfade
  // (incoming starts fully off-screen, never having been seen) and a swipe
  // commit (both panes already mid-drag, however far the finger had
  // gotten).
  //
  // `token` is the commit's own, from activateNavChrome — captured so
  // `finish()`, whenever it actually runs, can tell whether it's still the
  // most recent thing that touched `incoming`. Switching tabs again fast
  // enough (well within this transition's ~220ms) reuses `incoming` as the
  // *next* gesture's own pane — its pointermove writes transform/transition
  // directly, live, same as any drag — and this transition's own cleanup
  // can still fire after that, either from a `transitionend` cut short by
  // the new gesture overwriting `transition` (which cancels it without
  // firing that event) falling through to the `setTimeout` fallback, or
  // from timing out on its own regardless. Without the guard, that stale
  // fallback clears `incoming`'s transform out from under a drag actively
  // in progress — a visible snap to nothing, mid-swipe. `outgoing.remove()`
  // stays unconditional either way: it's a different, older pane than
  // whatever's current now, safe to discard regardless of what's happened
  // to `incoming` since.
  function settlePanes(outgoing, incoming, exitBy, token) {
    const duration = reduceMotion() ? 0 : 220;
    void incoming.offsetWidth; // flush its current position before animating
    const transition = duration ? `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)` : 'none';
    outgoing.style.transition = transition;
    incoming.style.transition = transition;
    outgoing.style.transform = `translateX(${exitBy}px)`;
    incoming.style.transform = 'translateX(0)';

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      outgoing.remove();
      if (token === ui.activeToken) {
        incoming.style.transition = '';
        incoming.style.transform = '';
      }
    };
    incoming.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, duration + 60);
  }

  // The swipe-commit twin of crossfadeToTab: `neighborEl` already exists
  // and has been sliding along 1:1 with the finger since the drag started
  // (attachSwipeNav's buildNeighbor, below), so this doesn't build or
  // position a pane — only turns an already-visible preview into the real
  // current one. It re-renders with a *fresh* token regardless of whether
  // the drag-start build already finished: if it did, this is a cheap
  // repaint off the same warm cache the preview just used; if it didn't,
  // this is what actually paints it, and the preview's own late write is
  // safely dropped by its own `token === ui.activeToken` check once this
  // call bumps the token out from under it.
  async function commitToNeighbor(outgoing, neighborEl, nextId, exitBy) {
    ui.contentEl = neighborEl;
    const token = activateNavChrome(nextId);
    neighborEl.classList.remove('fr-content--frozen');

    try {
      await RENDERERS[nextId](token);
    } catch (e) {
      if (token === ui.activeToken) renderErrorPanel(e.message, () => switchTab(nextId));
      console.error('[flame-reskin]', e);
    }

    if (token !== ui.activeToken) {
      neighborEl.remove();
      return;
    }

    settlePanes(outgoing, neighborEl, exitBy, token);
  }

  // Same directional language a swipe uses (exit toward the side you'd
  // have swiped from), driven off tab order instead of a finger: moving to
  // a later tab exits left, an earlier one exits right. Tapping the tab
  // already open is a no-op transition — switchTab still runs (it's what
  // re-fetches), there's just nothing to slide.
  function transitionToTab(nextId) {
    // settings.motion off means genuinely reverting to how this worked
    // before the crossfade rewrite, not just a zero-duration version of
    // it: plain switchTab(), one pane, no second pane ever created. The
    // only motion left is .fr-page's own fade-in — not gated on this
    // setting, since it's not the sliding transition being turned off.
    if (!settings.motion) {
      switchTab(nextId);
      return;
    }
    const fromIdx = TABS.findIndex((t) => t.id === currentTab);
    const toIdx = TABS.findIndex((t) => t.id === nextId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
      switchTab(nextId);
      return;
    }
    const direction = toIdx > fromIdx ? -1 : 1;
    crossfadeToTab(nextId, direction * ui.viewportEl.clientWidth);
  }

  // Listens on the stable viewport (never torn down or replaced), but drags
  // whichever pane is actually current — `pane` is captured once per
  // gesture, at pointerdown. ui.contentEl can change *during* a gesture too
  // now (briefly, while a neighbour preview's render is in flight — see
  // buildNeighbor), not only between gestures, but always back to `pane`
  // unless that preview goes on to be promoted by a real commit.
  function attachSwipeNav(viewport) {
    let pointerId = null;
    let pane = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let axis = null; // 'x' | 'y', decided once the move clears SWIPE_DIRECTION_LOCK
    let dragging = false;
    let translate = 0;
    let toNext = false; // which neighbour a commit would land on, fixed at axis-lock
    let neighbor = null; // { el, id, width, promote() } — the live preview of that neighbour, or null past an edge

    const tabIndex = () => TABS.findIndex((t) => t.id === currentTab);

    // Renders `id` into a fresh, frozen (`.fr-content--frozen`, pointer-
    // events:none) pane positioned just off the correct edge and appends
    // it to the viewport: the live "you're about to see this" preview a
    // drag reveals as it happens, built the moment direction is known
    // rather than waiting for a commit — so there's something real to
    // drag into view instead of a flick-then-fixed-animation to a page
    // nobody watched arrive.
    //
    // Rendered with the *current* token, unchanged: building a preview is
    // not a navigation — currentTab, activeToken and the nav pill are all
    // untouched — so it must not race a real render for the same guard
    // every renderer already does (`token === ui.activeToken`). If the
    // drag is abandoned, nothing here removes the pane itself (endDrag's
    // spring-back does that once it decides to discard) — this only
    // guards where a *late-arriving* write goes: back to the real current
    // pane if this preview was never promoted, or nowhere (silently
    // dropped by the renderer's own guard) if a commit has since bumped
    // the token out from under it.
    //
    // Known, accepted gap: reversing direction hard enough mid-drag to
    // want the *other* neighbour isn't supported — only one preview is
    // built per gesture, fixed at axis-lock, and a commit attempt past
    // that point just fails closed (no `neighbor`, so `endDrag` treats it
    // as a non-commit and springs back). Same reasoning for two rapid,
    // opposite-direction gestures back to back before the first preview's
    // render has resolved: rare, and any stray wrong content it could
    // flash mid-drag is overwritten the moment a real commit's own
    // authoritative render runs — not worth the cost of real cancellation
    // for how narrow and self-correcting it is.
    function buildNeighbor(id, width, offsetPx) {
      const paneEl = el('main', { class: 'fr-content fr-content--frozen' });
      paneEl.classList.toggle('fr-content--gyan', id === 'gyan');
      paneEl.style.transition = 'none';
      paneEl.style.transform = `translateX(${offsetPx}px)`;
      ui.viewportEl.appendChild(paneEl);

      const savedContentEl = ui.contentEl;
      const tok = ui.activeToken;
      let promoted = false;
      ui.contentEl = paneEl;
      (async () => {
        try {
          await RENDERERS[id](tok);
        } catch (err) {
          console.error('[flame-reskin]', err);
        } finally {
          if (!promoted && ui.contentEl === paneEl) ui.contentEl = savedContentEl;
        }
      })();

      return { el: paneEl, id, width, promote: () => { promoted = true; } };
    }

    viewport.addEventListener('pointerdown', (e) => {
      // settings.motion off reverts the whole gesture, not just its
      // animation: no drag-tracking, no neighbour preview, nothing —
      // matching how this app behaved before swipe-to-switch-tabs existed
      // at all, where the only way to change tabs was a nav tap.
      if (!settings.motion) return;
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      if (e.target.closest('.fr-cal-scroll, input, textarea')) {
        // Left at auto: this gesture belongs to a real horizontal scroller
        // (Calendar's week view) or a text field, and touch-action is a
        // per-gesture decision the browser locks in from this same event,
        // so it must not be left at pan-y (below) from a previous swipe.
        viewport.style.touchAction = '';
        return;
      }
      // Set *before* any move is seen, not after axis-locking on one: the
      // browser commits to its own default action (here, a plain vertical
      // scroll, since the pane is itself the scrolling element) within
      // the first touchmove or two, and a preventDefault() called later —
      // which is what axis-locking necessarily does — arrives too late to
      // cancel a scroll the browser already started. That race is what
      // made a deliberate, slow swipe feel like it was fighting the finger
      // (a fast flick won it by accident, just by finishing before the
      // browser's own decision landed) and, worse, could leave the pane
      // mid-overscroll when a vertical-looking drag got preventDefault'd
      // out from under it partway — which is what was pushing the page
      // title up above the frame. pan-y tells the browser up front that
      // horizontal panning here is never its call, so real vertical
      // scrolling still runs natively (untouched, no JS involvement) while
      // horizontal is ours alone from the first pixel, no race either way.
      viewport.style.touchAction = 'pan-y';
      pointerId = e.pointerId;
      pane = ui.contentEl;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastT = performance.now();
      velocity = 0;
      axis = null;
      dragging = false;
      translate = 0;
      neighbor = null;
    }, { passive: true });

    viewport.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (axis === null) {
        if (Math.abs(dx) < SWIPE_DIRECTION_LOCK && Math.abs(dy) < SWIPE_DIRECTION_LOCK) return;
        axis = Math.abs(dx) > Math.abs(dy) * SWIPE_AXIS_BIAS ? 'x' : 'y';
        if (axis === 'x') {
          dragging = true;
          pane.classList.add('fr-content--dragging');
          // Pins every further event for this pointer to `viewport` itself,
          // regardless of hit-testing — without it, the pointer-events:none
          // that .fr-content--dragging applies to the pane (to stop a row
          // underneath from taking a stray tap) would also make the
          // viewport invisible to hit-testing for its *own* subsequent
          // move/up events once the finger drags over some other element.
          try { viewport.setPointerCapture(e.pointerId); } catch (err) {}

          // Direction is knowable this early from dx's sign alone — no
          // need to wait for a commit to know which tab a drag is headed
          // toward. Same bounds check the edge-resistance logic below
          // makes independently: no neighbour past the first/last tab.
          const idx = tabIndex();
          toNext = dx < 0;
          const neighborIdx = idx + (toNext ? 1 : -1);
          if (neighborIdx >= 0 && neighborIdx < TABS.length) {
            const width = pane.clientWidth;
            neighbor = buildNeighbor(TABS[neighborIdx].id, width, toNext ? width : -width);
          }
        }
      }
      if (axis !== 'x') return;
      e.preventDefault();
      const now = performance.now();
      const dt = now - lastT || 1;
      velocity = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = now;

      const idx = tabIndex();
      const atStart = idx <= 0 && dx > 0;
      const atEnd = idx >= TABS.length - 1 && dx < 0;
      translate = atStart || atEnd ? dx * SWIPE_EDGE_RESISTANCE : dx;
      pane.style.transition = 'none';
      pane.style.transform = `translateX(${translate}px)`;
      // The neighbour rides along 1:1 with the pane, always exactly one
      // width away on the side it's coming from — pane going 0 -> -width
      // (toNext) pairs with the neighbour going +width -> 0, and the
      // mirror image for the other direction. Constant offset, so this is
      // the same arithmetic every frame regardless of how far translate
      // has moved.
      if (neighbor) {
        const off = toNext ? neighbor.width : -neighbor.width;
        neighbor.el.style.transition = 'none';
        neighbor.el.style.transform = `translateX(${translate + off}px)`;
      }
    }, { passive: false });

    function endDrag(e) {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      viewport.style.touchAction = '';
      if (!dragging) return;
      dragging = false;

      const distance = Math.abs(translate);
      const fast = Math.abs(velocity) > SWIPE_COMMIT_VELOCITY;
      // A neighbour existing at all already encodes the bounds check (none
      // was built past the first/last tab, or if direction reversed past
      // what it was built for — see buildNeighbor's known-gap note).
      const commit = (distance > SWIPE_COMMIT_PX || fast) && neighbor;

      if (!commit) {
        animateContentTo(pane, 0, 220);
        if (neighbor) {
          const off = toNext ? neighbor.width : -neighbor.width;
          const discarded = neighbor.el;
          animateContentTo(discarded, off, 220, () => discarded.remove());
        }
        neighbor = null;
        return;
      }

      const exitBy = toNext ? -neighbor.width : neighbor.width;
      neighbor.promote();
      commitToNeighbor(pane, neighbor.el, neighbor.id, exitBy);
      neighbor = null;
    }

    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
  }

  function buildShell() {
    ui.root = el('div', { id: 'flame-reskin-root' });

    // Top bar on desktop, bottom tab bar on mobile (media query repositions
    // this same markup — see .fr-nav's mobile override). A brand mark in
    // the corner of a *vertical sidebar* reads like an account switcher
    // (colored initial square + name, stacked top-left — the exact shape of
    // every app's profile menu); in a horizontal top bar the same position
    // just reads as a logo, which is what it actually is.
    const nav = el('nav', { class: 'fr-nav' });
    const brand = el('div', { class: 'fr-brand' }, [
      icon('flame', 'fr-brand-mark'),
      el('span', { class: 'fr-brand-name', text: 'FLAME' }),
    ]);
    const navList = el('div', { class: 'fr-nav-list' });
    // Appended before any button so it paints behind them (see .fr-nav-pill).
    navPill = el('div', { class: 'fr-nav-pill', 'aria-hidden': 'true' });
    navList.appendChild(navPill);
    for (const tab of TABS) {
      const btn = el('button', { class: 'fr-nav-btn', type: 'button', 'data-tab': tab.id });
      btn.appendChild(icon(tab.icon));
      btn.appendChild(el('span', { class: 'fr-nav-label', text: tab.label }));
      btn.addEventListener('click', () => transitionToTab(tab.id));
      // Mobile-only escape hatch: the bottom tab bar has no spare room for
      // a 6th icon, and every attempt at a floating/fixed toggle control so
      // far has ended up sitting on top of some tab's own content (a pill
      // collided with Gyan's composer; a dedicated top strip worked but was
      // extra permanent chrome eating vertical space on every single tab,
      // which is worse). A long-press on Home needs zero chrome of its own.
      if (tab.id === 'home') attachHomeLongPress(btn);
      navList.appendChild(btn);
    }
    // Desktop only: sits at the far right of the bar (mirrors the top-right
    // "settings" convention, as far as possible from the brand mark so it
    // reads as a utility action, not part of identity). Hidden on mobile,
    // where the bar is the bottom tab row and long-pressing Home (above)
    // is the switch instead.
    const desktopToggle = buildStockToggle('fr-nav-toggle');
    nav.append(brand, navList, desktopToggle);

    // viewportEl is the stable, never-replaced element: fixed in the flex
    // layout, overflow-x hidden, and the sole thing swipe listeners bind to.
    // ui.contentEl is the pane inside it that tab renderers actually touch —
    // stable across a same-tab refresh, but reassigned to a fresh pane by
    // crossfadeToTab for every tab-to-tab move (see there for why).
    ui.viewportEl = el('div', { class: 'fr-content-viewport' });
    ui.contentEl = el('main', { class: 'fr-content' });
    ui.viewportEl.appendChild(ui.contentEl);
    // Outside ui.contentEl on purpose: every tab render calls
    // ui.contentEl.replaceChildren(), which would take the banner with it.
    ui.bannerHost = el('div', { class: 'fr-banner-host' });
    attachSwipeNav(ui.viewportEl);

    ui.root.append(nav, ui.bannerHost, ui.viewportEl);
    document.body.appendChild(ui.root);
    // Preview/dev only: let the harness pick which tab to boot straight
    // into, instead of racing a separate switchTab() call against this one
    // after the fact (two switchTab calls in flight at once is exactly the
    // out-of-order scenario the token guard exists for).
    switchTab((window.__FLAME_RESKIN_PREVIEW__ && window.__FLAME_RESKIN_INITIAL_TAB__) || 'home');
    paintAutoBookBanner();

    // Scheduled bookings ride on the same session the UI uses, so wait for a
    // token rather than racing the first render for it. A failure here is
    // not fatal: the next launch tries again, which is the whole design.
    (async () => {
      try {
        if (!window.__FLAME_RESKIN_PREVIEW__) await waitFor(() => auraState.context && auraState.token, 30000);
        await runAutoBook();
      } catch (e) {
        console.log('[flame-reskin] auto-book skipped this launch:', e.message);
      }
      startAutoBookLoop();
    })();
  }

  // Small reusable day-navigator: prev/next/today + a label, used by both
  // the Calendar grid and the Book Slot date field (no native date picker).
  function buildDayNav({ label, onPrev, onNext, onToday, prevDisabled }) {
    const wrap = el('div', { class: 'fr-daynav' });
    const prevBtn = el('button', { class: 'fr-daynav-btn', type: 'button', 'aria-label': 'Previous day' });
    prevBtn.appendChild(icon('chevronLeft'));
    if (prevDisabled) prevBtn.disabled = true;
    prevBtn.addEventListener('click', onPrev);

    const nextBtn = el('button', { class: 'fr-daynav-btn', type: 'button', 'aria-label': 'Next' });
    nextBtn.appendChild(icon('chevronRight'));
    nextBtn.addEventListener('click', onNext);

    const todayBtn = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Today' });
    todayBtn.addEventListener('click', onToday);

    const labelEl = el('span', { class: 'fr-daynav-label', text: label });

    wrap.append(prevBtn, labelEl, nextBtn, todayBtn);
    return wrap;
  }

  // Reusable week-strip date picker (Home always; Calendar's mobile day
  // view — see renderCalendar). Paging (prev/next week) and selecting a
  // day are separate concerns: paging just changes which week is shown,
  // selecting a day is the caller's responsibility (onSelect).
  function buildDateStrip({ weekStart, selected, hasEvents, onSelect, onPrevWeek, onNextWeek }) {
    const strip = el('div', { class: 'fr-datestrip' });
    const prevBtn = el('button', { class: 'fr-daynav-btn', type: 'button', 'aria-label': 'Previous week' });
    prevBtn.appendChild(icon('chevronLeft'));
    prevBtn.addEventListener('click', onPrevWeek);

    const cells = el('div', { class: 'fr-datestrip-cells' });
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      const isToday = sameDay(day, startOfToday());
      const isSelected = sameDay(day, selected);
      const hasClasses = hasEvents(day);
      const cell = el('button', {
        class: `fr-datestrip-cell${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`,
        type: 'button',
      });
      cell.append(
        el('span', { class: 'fr-datestrip-weekday', text: day.toLocaleDateString(undefined, { weekday: 'short' }) }),
        el('span', { class: 'fr-datestrip-daynum', text: String(day.getDate()) }),
        el('span', { class: `fr-datestrip-dot${hasClasses ? '' : ' is-empty'}` })
      );
      cell.addEventListener('click', () => onSelect(day));
      cells.appendChild(cell);
    }

    const nextBtn = el('button', { class: 'fr-daynav-btn', type: 'button', 'aria-label': 'Next week' });
    nextBtn.appendChild(icon('chevronRight'));
    nextBtn.addEventListener('click', onNextWeek);

    // No separate "Today" button: today's own cell carries a distinct
    // fill (see .is-today CSS) and is always one tap away since paging
    // is only ever ±7 days.
    strip.append(prevBtn, cells, nextBtn);
    return strip;
  }

  // Custom dropdown — replaces a native <select> (used for Book Slot's
  // Resource picker), which renders as the platform's own picker UI (a
  // full-screen wheel on Android WebView) with none of the reskin's
  // styling. Exposes a small value/setOptions surface rather than trying
  // to imitate <select>'s full DOM API, since only that much is ever used.
  function buildPicker({ ariaLabel, onChange }) {
    const wrap = el('div', { class: 'fr-picker' });
    const btn = el('button', {
      class: 'fr-picker-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': ariaLabel,
    });
    const btnLabel = el('span', { class: 'fr-picker-btn-label' });
    // The note is its own element rather than text appended to the label,
    // because the label ellipsises: concatenated, the status would be the
    // first thing a long resource name truncated away.
    const btnNote = el('span', { class: 'fr-picker-btn-note' });
    btn.append(btnLabel, btnNote, icon('chevronDown'));
    const panel = el('div', { class: 'fr-picker-panel' });
    const list = el('div', { class: 'fr-picker-list', role: 'listbox' });
    panel.appendChild(list);
    wrap.append(btn, panel);

    let options = [];
    let value = null;

    // An option's `note` is a status the caller already knows and the user
    // would otherwise have to discover by selecting the option and reading an
    // empty result — a gym window that is over for the chosen day, say. It
    // annotates, it never disables: the option stays selectable, because the
    // status belongs to the option *and the current date*, and the date is one
    // tap away.
    function paintButton(opt) {
      btnLabel.textContent = opt ? opt.text : '';
      btnNote.textContent = opt && opt.note ? opt.note : '';
      btnNote.hidden = !(opt && opt.note);
    }

    function paintPanel() {
      list.replaceChildren();
      for (const opt of options) {
        const item = el('button', {
          class: `fr-picker-option${opt.value === value ? ' is-selected' : ''}`,
          type: 'button', role: 'option', 'aria-selected': String(opt.value === value),
        });
        item.append(el('span', { class: 'fr-picker-option-label', text: opt.text }));
        if (opt.note) item.append(el('span', { class: 'fr-picker-option-note', text: opt.note }));
        item.addEventListener('click', () => {
          value = opt.value;
          paintButton(opt);
          // Repaint before closing: the highlight is painted from `value` at
          // paint time, so without this the panel keeps showing the previous
          // option as selected the next time it opens.
          paintPanel();
          closePanel();
          if (onChange) onChange(value);
        });
        list.appendChild(item);
      }
    }

    function onDocClick(e) {
      if (!wrap.contains(e.target)) closePanel();
    }
    function openPanel() {
      wrap.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      // The list scrolls past 280px, so with a long resource list the
      // selected option can open off-screen. Put it in view without
      // animating — the panel is appearing in the same frame anyway.
      const selected = list.querySelector('.fr-picker-option.is-selected');
      if (selected) list.scrollTop = Math.max(0, selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2);
      document.addEventListener('click', onDocClick, true);
    }
    function closePanel() {
      wrap.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
    }
    btn.addEventListener('click', () => (wrap.classList.contains('is-open') ? closePanel() : openPanel()));
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePanel();
    });

    return {
      el: wrap,
      get value() {
        return value;
      },
      set value(v) {
        value = v;
        paintButton(options.find((o) => o.value === v) || null);
        paintPanel();
      },
      setOptions(newOptions) {
        options = newOptions;
        // Re-resolve the collapsed label against the new list: setOptions is
        // called on a date step purely to refresh the notes, and without this
        // the button keeps the stale note while the panel shows the new one.
        const found = options.find((o) => o.value === value);
        if (found) paintButton(found);
        paintPanel();
      },
    };
  }

  const STYLE_CSS = "#flame-reskin-root, #flame-reskin-root * { box-sizing: border-box; }\n/* An author rule setting display: (e.g. .fr-confirm-panel { display: flex }) beats\n   the UA [hidden]{display:none} rule at equal specificity — restore it explicitly,\n   otherwise setting .hidden = true silently does nothing on any styled element. */\n#flame-reskin-root [hidden] { display: none !important; }\n\n#flame-reskin-root {\n  /* Default via CSS env() for browsers/PWAs that populate it (0 elsewhere,\n     e.g. desktop). The Android app's native hook overrides this at runtime\n     with a precisely-measured value, since this WebView doesn't reliably\n     populate env(safe-area-inset-bottom) on its own. */\n  --flame-navbar-inset: env(safe-area-inset-bottom, 0px);\n  --bg: #11131a;\n  --bg-elevated: #1a1e28;\n  --bg-elevated-2: #232838;\n  --border: #2b3040;\n  --text: #eef0f6;\n  --text-secondary: #96a0b8;\n  --accent: #5b8cff;\n  --accent-hover: #71a0ff;\n  --accent-text: #0d1220;\n  --danger: #e0836f;\n  --danger-bg: #3a241f;\n  --success: #7fc98a;\n  --success-bg: #1c2f22;\n\n  position: fixed;\n  inset: 0;\n  z-index: 2147483000;\n  display: flex;\n  flex-direction: column;\n  background: var(--bg);\n  color: var(--text);\n  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif;\n  font-size: 15px;\n  line-height: 1.5;\n  -webkit-font-smoothing: antialiased;\n  color-scheme: dark;\n}\n\n#flame-reskin-root a { color: var(--accent); }\n#flame-reskin-root ::selection { background: var(--accent); color: var(--accent-text); }\n#flame-reskin-root *:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }\n\n#flame-reskin-root ::-webkit-scrollbar { width: 10px; height: 10px; }\n#flame-reskin-root ::-webkit-scrollbar-track { background: transparent; }\n#flame-reskin-root ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }\n#flame-reskin-root ::-webkit-scrollbar-thumb:hover { background: var(--bg-elevated-2); }\n#flame-reskin-root * { scrollbar-color: var(--border) transparent; scrollbar-width: thin; }\n\n/* Top bar on desktop (mobile repositions this same markup into a bottom\n   tab bar — see the media query). A vertical sidebar with a colored-square\n   \"FL\" mark stacked over a name in the top-left corner is, structurally,\n   the exact shape of every app's account switcher; the same mark inline in\n   a horizontal bar just reads as a logo. */\n.fr-nav {\n  flex-shrink: 0;\n  border-bottom: 1px solid var(--border);\n  padding: 0 48px; /* matches .fr-content's left/right padding, so the bar's edges line up with the page content below it */\n  height: 60px;\n  display: flex;\n  align-items: center;\n  gap: 8px;\n}\n.fr-brand { display: flex; align-items: center; gap: 8px; padding-right: 20px; margin-right: 4px; border-right: 1px solid var(--border); }\n.fr-brand-mark { color: var(--accent); width: 22px; height: 22px; }\n.fr-brand-name { font-weight: 700; font-size: 14px; letter-spacing: 0.02em; }\n.fr-nav-list { display: flex; align-items: center; gap: 4px; position: relative; }\n/* One shared highlight that slides to the active tab instead of each\n   button owning its own background — the same element on desktop's top\n   bar and mobile's bottom bar, since both share this markup. Inserted\n   before the buttons in DOM order so it paints behind them without a\n   z-index: an absolutely positioned box would otherwise sit above static\n   siblings regardless of source order, which is why the buttons also\n   need `position: relative` below (same auto stacking level, so DOM\n   order decides, exactly what we want). positionNavPill() in shell.js\n   drives its transform/width from the active button's own geometry. */\n.fr-nav-pill {\n  position: absolute; top: 0; left: 0; height: 100%; width: 0;\n  background: var(--bg-elevated-2); border-radius: 8px;\n  transform: translateX(0);\n  transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1), width 260ms cubic-bezier(0.16, 1, 0.3, 1);\n  pointer-events: none;\n}\n@media (prefers-reduced-motion: reduce) { .fr-nav-pill { transition: none; } }\n.fr-nav-btn {\n  position: relative;\n  display: flex; align-items: center; gap: 8px;\n  padding: 8px 12px; border-radius: 8px;\n  background: transparent; border: none;\n  color: var(--text-secondary); font: inherit; font-weight: 500; font-size: 0.875rem;\n  cursor: pointer; text-align: left;\n  transition: background-color 120ms ease, color 120ms ease;\n  /* A held touch on Home (see attachHomeLongPress) could win the OS's own\n     text-selection gesture instead — same hold duration, competing\n     interpretations of the same press. Nav labels are never meant to be\n     copy-selected anyway, on any button here, so this just removes the\n     ambiguity rather than racing it. */\n  user-select: none; -webkit-user-select: none;\n}\n/* :hover on a touch device applies on tap and has no real way to clear —\n   there's no pointer to \"leave\" the element, so it sticks until something\n   else happens to repaint over it. On this app that showed up as two\n   nav buttons visibly highlighted at once: whichever was last tapped\n   (stuck :hover) plus the real current tab (.is-active + the pill),\n   coexisting since a swipe changes tabs without tapping the nav bar at\n   all to clear the old one. `hover: hover` is true only for a device\n   with a real pointer that can actually leave an element (a mouse) —\n   false for touch, so every :hover rule in this file is gated behind it\n   rather than fixing this one component and leaving the same bug latent\n   everywhere else hover is used. Desktop (Tampermonkey) is unaffected. */\n@media (hover: hover) {\n  .fr-nav-btn:hover { background: var(--bg-elevated); color: var(--text); }\n}\n.fr-nav-btn.is-active { color: var(--text); }\n.fr-nav-btn.is-active .icon { color: var(--accent); }\n/* Mobile-only long-press-to-switch-to-stock feedback on the Home tab (see\n   attachHomeLongPress()) — a slow fill exactly matching the hold duration,\n   so releasing early visibly \"un-fills\" instead of just snapping off.\n   Harmless if ever triggered on desktop by a mouse-down; nothing reads it. */\n.fr-nav-btn.is-pressing { background: var(--bg-elevated-2); transition: background-color 550ms ease; }\n/* The one action in the bar that isn't navigation — pushed to the far\n   opposite end from the brand mark so it reads as a utility, not a tab.\n   Desktop only; mobile switches via a Home long-press instead (no room\n   for a 6th icon in the bottom tab bar). */\n.fr-nav-toggle {\n  margin-left: auto; flex-shrink: 0;\n  background: transparent; border: 1px solid var(--border); border-radius: 8px;\n  color: var(--text-secondary); font: inherit; font-weight: 500; font-size: 0.8125rem;\n  padding: 7px 12px; cursor: pointer; transition: border-color 120ms ease, color 120ms ease;\n}\n@media (hover: hover) {\n  .fr-nav-toggle:hover { color: var(--text); border-color: var(--text-secondary); }\n}\n\n/* Long-press menu (mobile Home tab — attachHomeLongPress/openMenu in\n   toggle.js): fixed-positioned via the trigger's own getBoundingClientRect\n   at open time rather than a CSS anchor, since it can't be a DOM child of\n   the nav button itself. Same surface language as .fr-picker-panel — an\n   elevated, bordered, shadowed popover — reused rather than invented,\n   just anchored upward from a fixed point instead of relative-positioned\n   below a form field. Entrance is a small scale-from-the-corner-it-came-\n   from, not a slide: the corner nearest the button is the transform\n   origin, so it reads as growing out of the tap rather than arriving\n   from a direction. */\n.fr-navmenu-panel {\n  position: fixed; z-index: 30; min-width: 180px;\n  background: var(--bg-elevated-2); border: 1px solid var(--border); border-radius: 10px;\n  box-shadow: 0 12px 28px rgba(0,0,0,0.5);\n  padding: 4px;\n  transform-origin: left bottom;\n  transform: scale(0.92); opacity: 0; pointer-events: none;\n  transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), opacity 140ms ease-out;\n}\n.fr-navmenu-panel.is-open { transform: scale(1); opacity: 1; pointer-events: auto; }\n@media (prefers-reduced-motion: reduce) { .fr-navmenu-panel { transition: none; } }\n.fr-navmenu-panel .fr-navmenu-setting { padding: 10px 10px 6px; }\n.fr-navmenu-panel .fr-switch-hint { max-width: 220px; }\n\n/* The stable element: sized by flex like .fr-content used to be, and the\n   only thing attachSwipeNav's listeners bind to. One or two .fr-content\n   panes live inside it, absolutely stacked, so a tab-to-tab transition can\n   have the outgoing and incoming pane on screen at once (sliding past each\n   other) instead of a single pane being torn down and rebuilt mid-gesture. */\n.fr-content-viewport { flex: 1; position: relative; overflow: hidden; }\n.fr-content { position: absolute; inset: 0; overflow-y: auto; padding: 40px 48px 80px; display: flex; justify-content: center; align-items: flex-start; }\n/* Swipe-to-switch-tabs (see attachSwipeNav in shell.js): the active pane\n   translates with the finger, so pointer events are switched off mid-drag\n   to stop a moving row's tap/click from firing under the finger. The\n   transform itself is inline, set and cleared by the gesture handler\n   directly — same convention as morphHeight's own inline height writes. */\n.fr-content.fr-content--dragging { pointer-events: none; }\n/* A neighbour pane built ahead of a commit (see attachSwipeNav's live drag\n   in shell.js) is riding along as a passenger, not something the user has\n   actually navigated to yet — no tap should land on it until it's the\n   real current pane. Same property as --dragging, different element and a\n   different reason, so it stays its own class rather than overloading\n   that one's name. */\n.fr-content.fr-content--frozen { pointer-events: none; }\n.fr-page { max-width: 1320px; width: 100%; animation: fr-fade-in 180ms ease-out; }\n@keyframes fr-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }\n.fr-page-title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 24px; }\n\n.icon { width: 20px; height: 20px; display: inline-flex; flex-shrink: 0; }\n.icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }\n\n.fr-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 96px 0; color: var(--text-secondary); }\n.fr-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: fr-spin 700ms linear infinite; }\n@keyframes fr-spin { to { transform: rotate(360deg); } }\n\n/* Skeletons.\n   A skeleton is the real element with its unknown text swapped for a\n   shimmering block of the same metrics — never a lookalike built out of\n   bare divs, which is how a placeholder ends up a different height than\n   the thing it stands in for and the page jumps when data lands. The\n   block is an inline-block holding a non-breaking space, so its line box\n   is exactly one line of the parent's own type: same font, same\n   line-height, same baseline, whatever the parent happens to be.\n   Width is the only thing a caller sets, in ch, and it is a guess about\n   content length — nothing about the layout depends on it being right. */\n.fr-skel {\n  display: inline-block; vertical-align: baseline;\n  border-radius: 5px; color: transparent; user-select: none;\n  background-color: var(--bg-elevated-2);\n  background-image: linear-gradient(\n    90deg,\n    transparent 0%,\n    color-mix(in srgb, var(--text-secondary) 16%, transparent) 45%,\n    color-mix(in srgb, var(--text-secondary) 16%, transparent) 55%,\n    transparent 100%\n  );\n  background-size: 220% 100%;\n  background-repeat: no-repeat;\n  animation: fr-shimmer 1400ms linear infinite;\n}\n/* Sweeps left to right. The travel is wider than the element so the band\n   spends time off both edges rather than bouncing at the boundaries. */\n@keyframes fr-shimmer {\n  from { background-position: 160% 0; }\n  to { background-position: -60% 0; }\n}\n/* A card whose contents are still unknown. It is genuinely disabled, so\n   it cannot be tapped or focused — but the 0.4 opacity that :disabled\n   carries here means \"blocked\" and would also dim the one thing on the\n   card that is already true, its time. Full strength, no pointer. */\n.fr-slot--skeleton { cursor: default; }\n.fr-slot--skeleton:disabled { opacity: 1; }\n@media (hover: hover) {\n  .fr-slot--skeleton:hover { border-color: var(--border); }\n}\n@media (prefers-reduced-motion: reduce) {\n  .fr-skel { animation: none; background-image: none; }\n}\n\n.fr-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 64px 24px; color: var(--text-secondary); }\n.fr-empty-icon { width: 32px; height: 32px; color: var(--text-secondary); opacity: 0.6; margin-bottom: 4px; }\n.fr-empty-title { font-weight: 600; color: var(--text); margin: 0; }\n.fr-empty-text { margin: 0; font-size: 0.875rem; }\n.fr-empty--error { color: var(--danger); }\n.fr-empty--error .fr-empty-title { color: var(--danger); }\n.fr-empty--inline { padding: 32px 16px; }\n/* Sits under the empty state's own text, spaced from it rather than\n   crowding it — the offer is a next step, not part of the sentence. */\n.fr-empty-action { margin-top: 8px; }\n\n/* An empty state that lives inside a list, not on a page of its own.\n   .fr-empty is built for a whole empty tab — 64px of padding, a 32px\n   icon, three stacked lines — and putting that where one row belongs\n   made the section three rows tall, so the page jumped by ~130px the\n   moment a one-booking day resolved into no bookings at all. This\n   occupies exactly one .fr-row: same padding once its border is counted,\n   same two line boxes, so the skeleton row, a real booking and \"nothing\n   booked\" are all the same height and nothing below them moves.\n   It must not be mistaken for a booking, though, so it inverts the row's\n   material: hairline dashed instead of filled, secondary title. */\n.fr-nothing {\n  display: flex; align-items: center; gap: 12px;\n  padding: 13px 15px; border-radius: 12px;\n  border: 1px dashed var(--border); background: transparent;\n}\n.fr-nothing .fr-row-title { color: var(--text-secondary); }\n.fr-nothing-icon { width: 18px; height: 18px; color: var(--text-secondary); opacity: 0.55; }\n.fr-nothing .fr-link-btn { flex-shrink: 0; }\n\n/* A section that is being remeasured after its contents changed shape.\n   Set by morphHeight, which writes the two heights around it — the\n   transition is here so it is themed with everything else, and so\n   prefers-reduced-motion can take it away. */\n.fr-morphing { overflow: hidden; transition: height 280ms cubic-bezier(0.22, 0.61, 0.36, 1); }\n@media (prefers-reduced-motion: reduce) { .fr-morphing { transition: none; } }\n\n.fr-day-group { margin-bottom: 32px; }\n.fr-group-heading {\n  font-size: 0.8125rem; font-weight: 600; text-transform: uppercase;\n  letter-spacing: 0.04em; color: var(--text-secondary); margin: 0 0 12px;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n.fr-group-heading-row { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 12px; flex-shrink: 0; }\n.fr-link-btn {\n  font: inherit; font-size: 0.8125rem; font-weight: 600; color: var(--accent);\n  background: none; border: none; padding: 0; cursor: pointer;\n}\n\n.fr-list { display: flex; flex-direction: column; gap: 8px; }\n.fr-row {\n  display: flex; align-items: center; justify-content: space-between; gap: 16px;\n  background: var(--bg-elevated); border-radius: 12px; padding: 14px 16px;\n}\n/* Every row in a list has to be the same height. A long class title, or a\n   \"Wednesday, Sep 10 - 10:00 AM - 11:00 AM\" meta line, used to wrap onto a\n   second line and grow its own box, which reads as \"this class runs\n   longer\" when it only means \"this name is longer\". Both lines are single\n   line + ellipsis now, and .fr-row-main shrinks (min-width:0) rather than\n   shoving the pill/button off the edge. */\n.fr-row-main { flex: 1; min-width: 0; }\n.fr-row-title { margin: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.fr-row-meta {\n  margin: 4px 0 0; font-size: 0.8125rem; color: var(--text-secondary);\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n/* A class row with no room/faculty still has to reserve the meta line's\n   height, or it sits shorter than its neighbours. */\n.fr-row-meta:empty::before { content: '\\00a0'; }\n.fr-row-time { font-weight: 600; font-variant-numeric: tabular-nums; flex-shrink: 0; min-width: 78px; white-space: nowrap; }\n/* Status pill + cancel button share one right-hand column, so mobile can\n   collapse them together. */\n.fr-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }\n\n.fr-badge { flex-shrink: 0; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }\n.fr-badge.is-booked { background: var(--success-bg); color: var(--success); }\n.fr-badge.is-cancelled { background: var(--bg-elevated-2); color: var(--text-secondary); }\n\n/* A cancelled row still carries its real time and name — it just has to\n   lose next to a live booking at a glance, not on a second read of the\n   badge. Opacity on the whole row (not a recolour) is what a disabled\n   slot already uses elsewhere, so \"this isn't active\" reads as one\n   consistent visual idea across the app. */\n.fr-row.is-cancelled { opacity: 0.55; }\n\n.fr-cancel-wrap { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }\n\n/* Cancel confirmation. Three earlier attempts all failed the same way —\n   they added something to the row (a question string, an overlay, a drawer)\n   and then had to find room for it. This one adds nothing: the row's own\n   title becomes the question (\"Gym\" -> \"Cancel Gym?\"), so the object being\n   cancelled is named exactly once, in the place already reading as its\n   name, and the only new pixels are one extra button. Nothing expands,\n   nothing is covered, every row in the list keeps the same height. */\n.fr-row.is-confirming {\n  background: color-mix(in srgb, var(--danger) 12%, var(--bg-elevated));\n}\n.fr-row.is-confirming .fr-row-title { color: var(--danger); }\n.fr-row, .fr-row-title { transition: background-color 140ms ease, color 140ms ease; }\n\n.fr-btn {\n  font: inherit; font-weight: 600; border-radius: 9px; padding: 9px 16px;\n  border: 1px solid transparent; cursor: pointer; white-space: nowrap;\n  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;\n}\n.fr-btn:disabled { opacity: 0.5; cursor: default; }\n.fr-btn--primary { background: var(--accent); color: var(--accent-text); }\n@media (hover: hover) { .fr-btn--primary:hover:not(:disabled) { background: var(--accent-hover); } }\n.fr-btn--secondary { background: var(--bg-elevated-2); color: var(--text); }\n@media (hover: hover) { .fr-btn--secondary:hover:not(:disabled) { background: #2b3143; } }\n.fr-btn--ghost { background: transparent; color: var(--text-secondary); border-color: var(--border); }\n@media (hover: hover) { .fr-btn--ghost:hover:not(:disabled) { color: var(--text); border-color: var(--text-secondary); } }\n.fr-btn--danger { background: var(--danger); color: #241512; }\n.fr-btn--sm { padding: 6px 12px; font-size: 0.8125rem; }\n.fr-btn--icon { padding: 8px; line-height: 0; }\n\n.fr-input, .fr-select {\n  font: inherit; color: var(--text); background: var(--bg-elevated);\n  border: 1px solid var(--border); border-radius: 9px; padding: 9px 12px; width: 100%;\n}\n.fr-input:focus, .fr-select:focus { border-color: var(--accent); }\n/* No rule here previously meant placeholders fell back to the browser's\n   default (near-black) placeholder color on this dark input background —\n   effectively invisible. */\n.fr-input::placeholder { color: var(--text-secondary); opacity: 1; }\n\n/* Custom picker — replaces a native <select> (the Resource dropdown),\n   which renders as the platform's own picker UI (a full-screen wheel on\n   Android WebView) with none of the reskin's styling. */\n.fr-picker { position: relative; }\n.fr-picker-btn {\n  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;\n  font: inherit; color: var(--text); background: var(--bg-elevated);\n  border: 1px solid var(--border); border-radius: 9px; padding: 9px 12px;\n  cursor: pointer; text-align: left; transition: border-color 120ms ease;\n}\n@media (hover: hover) { .fr-picker-btn:hover { border-color: var(--text-secondary); } }\n.fr-picker.is-open .fr-picker-btn { border-color: var(--accent); }\n.fr-picker-btn-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.fr-picker-btn .icon { flex-shrink: 0; width: 16px; height: 16px; color: var(--text-secondary); transition: transform 120ms ease; }\n.fr-picker.is-open .fr-picker-btn .icon { transform: rotate(180deg); }\n/* Split into an outer frame (owns the border/radius/shadow, clips via\n   overflow:hidden) and an inner scroll list (owns overflow-y:auto) rather\n   than putting both the radius and the scrolling on one element — a\n   scrolling element's own border-radius isn't reliably clipped against its\n   scrollbar on every renderer (confirmed broken on Android WebView: the\n   right corners squared off under the native scrollbar track, invisible\n   in desktop testing since desktop's custom-styled scrollbar doesn't\n   expose the same gap). overflow:hidden on a non-scrolling ancestor clips\n   unconditionally regardless of how the descendant's own scrollbar renders. */\n.fr-picker-panel {\n  position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 20;\n  background: var(--bg-elevated-2); border: 1px solid var(--border); border-radius: 10px;\n  overflow: hidden;\n  box-shadow: 0 12px 28px rgba(0,0,0,0.5);\n  display: none;\n}\n.fr-picker.is-open .fr-picker-panel { display: block; }\n.fr-picker-list { padding: 4px; max-height: 280px; overflow-y: auto; }\n.fr-picker-option {\n  display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; font: inherit;\n  color: var(--text); font-size: 0.9375rem;\n  background: transparent; border: none; border-radius: 7px; padding: 9px 10px;\n  cursor: pointer; white-space: nowrap; overflow: hidden;\n}\n.fr-picker-option-label { overflow: hidden; text-overflow: ellipsis; }\n@media (hover: hover) { .fr-picker-option:hover { background: var(--bg-elevated); } }\n.fr-picker-option.is-selected { color: var(--accent); font-weight: 600; }\n\n/* A status the row carries, not a second label: it sits at the far edge,\n   never truncates (the name gives way first), and stays quiet enough that\n   the row still reads as one selectable thing rather than two. The option\n   remains fully selectable — a window that is over today is the right\n   choice for tomorrow, which the day nav is one tap away from. */\n.fr-picker-option-note, .fr-picker-btn-note {\n  margin-left: auto; flex-shrink: 0; font-size: 0.75rem; font-weight: 500; white-space: nowrap;\n  color: var(--text-secondary); font-variant-numeric: tabular-nums;\n}\n.fr-picker-option.is-selected .fr-picker-option-note { font-weight: 500; }\n\n/* Day navigator (Calendar + Book Slot share this) */\n.fr-daynav { display: flex; align-items: center; gap: 6px; }\n.fr-daynav-label { font-weight: 600; font-size: 0.9375rem; flex: 1; text-align: center; white-space: nowrap; }\n.fr-daynav-btn {\n  display: flex; align-items: center; justify-content: center;\n  width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0;\n  background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text);\n  cursor: pointer;\n}\n@media (hover: hover) { .fr-daynav-btn:hover:not(:disabled) { background: var(--bg-elevated-2); } }\n.fr-daynav-btn:disabled { opacity: 0.35; cursor: not-allowed; }\n\n/* Calendar grid */\n.fr-cal-header {\n  display: grid; grid-template-columns: 1fr auto; grid-template-areas: \"title title\" \"nav toggle\";\n  align-items: center; gap: 12px 16px; margin-bottom: 20px;\n}\n.fr-cal-header-title { grid-area: title; margin: 0; }\n.fr-cal-header-nav { grid-area: nav; min-width: 0; }\n.fr-cal-header-nav .fr-datestrip { margin: 0; }\n.fr-cal-header-toggle { grid-area: toggle; }\n.fr-view-toggle { display: flex; background: var(--bg-elevated); border-radius: 9px; padding: 3px; gap: 2px; flex-shrink: 0; }\n.fr-view-toggle button {\n  padding: 6px 14px; border-radius: 7px; background: transparent; border: none;\n  color: var(--text-secondary); font: inherit; font-weight: 600; font-size: 0.8125rem; cursor: pointer;\n}\n.fr-view-toggle button.is-active { background: var(--bg-elevated-2); color: var(--text); }\n\n/* Same split as .fr-picker-panel: the frame owns the border/radius and\n   clips unconditionally via overflow:hidden; the scroll happens on a\n   separate inner element instead of on the radius-bearing one itself\n   (unreliable on Android WebView — right corners squared off under the\n   scrollbar, invisible in desktop testing). */\n.fr-cal-wrap { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }\n.fr-cal-scroll { display: flex; overflow-x: auto; }\n.fr-cal-gutter { width: 52px; flex-shrink: 0; border-right: 1px solid var(--border); }\n.fr-cal-gutter-header { height: 40px; border-bottom: 1px solid var(--border); }\n.fr-cal-hour-label {\n  height: var(--fr-hour-h); font-size: 0.6875rem; color: var(--text-secondary);\n  text-align: right; padding-right: 8px; position: relative;\n}\n/* Straddles the gridline above it (like most calendar apps: the label\n   marks the line, not the row) — except the very first label, which has\n   no row above it to straddle into and would otherwise overlap the\n   day-header instead. overflow:hidden here (not on every label) clips\n   only that one case without cutting off every other label's top half. */\n.fr-cal-hour-label span { position: absolute; top: -7px; right: 8px; }\n.fr-cal-hour-label--first { overflow: hidden; }\n.fr-cal-hour-label--first span { top: 1px; }\n.fr-cal-days { flex: 1; display: grid; }\n.fr-cal-day-col { position: relative; border-right: 1px solid var(--border); }\n.fr-cal-day-col:last-child { border-right: none; }\n.fr-cal-day-header {\n  height: 40px; display: flex; flex-direction: column; align-items: center; justify-content: center;\n  border-bottom: 1px solid var(--border); font-size: 0.75rem; font-weight: 600; color: var(--text-secondary);\n  white-space: nowrap;\n}\n.fr-cal-day-header.is-today { color: var(--accent); }\n.fr-cal-hour-row { height: var(--fr-hour-h); border-bottom: 1px solid var(--border); }\n.fr-cal-body { position: relative; }\n.fr-cal-now-line { position: absolute; left: 0; right: 0; height: 2px; background: var(--accent); z-index: 2; }\n.fr-cal-now-line::before {\n  content: ''; position: absolute; left: -4px; top: -3px; width: 8px; height: 8px;\n  border-radius: 50%; background: var(--accent);\n}\n.fr-cal-event {\n  position: absolute; left: 3px; right: 3px; border-radius: 7px; padding: 4px 8px;\n  background: color-mix(in srgb, var(--accent) 20%, var(--bg-elevated));\n  font-size: 0.75rem; line-height: 1.3; cursor: default;\n  overflow: hidden;\n}\n/* The venue used to be the one line allowed to wrap, on the theory that a\n   long room name should grow the block rather than lose characters. It\n   grows it into the block below: a calendar block's height is its\n   duration, so any extra line is an overlap, and \"Chandragupta - Focus\n   Room 201 W\" is a real room name. Every line in the block is bounded now\n   (venue and professor to one line, the course title to two), and the\n   block itself clips — the full text is on the block's title attribute. */\n.fr-cal-event-venue {\n  font-weight: 600; color: var(--accent);\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n.fr-cal-event-title {\n  font-weight: 600; margin-top: 1px;\n  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;\n}\n.fr-cal-event-meta {\n  color: var(--text-secondary); margin-top: 1px;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n\n/* Home dashboard — week-strip date picker above the classes list */\n.fr-datestrip { display: flex; align-items: center; gap: 8px; margin: 4px 0 28px; }\n.fr-datestrip-cells { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }\n.fr-datestrip-cell {\n  display: flex; flex-direction: column; align-items: center; gap: 4px;\n  padding: 10px 4px; border-radius: 10px; background: var(--bg-elevated);\n  border: 1px solid transparent; color: var(--text-secondary); font: inherit; cursor: pointer;\n  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;\n}\n@media (hover: hover) { .fr-datestrip-cell:hover { background: var(--bg-elevated-2); } }\n.fr-datestrip-cell.is-today {\n  background: color-mix(in srgb, var(--accent) 20%, var(--bg-elevated));\n  border-color: var(--accent); color: var(--text);\n}\n.fr-datestrip-cell.is-today .fr-datestrip-daynum { color: var(--accent); }\n.fr-datestrip-cell.is-selected { background: var(--accent); color: var(--accent-text); border-color: transparent; }\n.fr-datestrip-cell.is-selected .fr-datestrip-daynum { color: inherit; }\n.fr-datestrip-weekday { font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.8; white-space: nowrap; }\n.fr-datestrip-daynum { font-size: 1.0625rem; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.fr-datestrip-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }\n.fr-datestrip-dot.is-empty { visibility: hidden; }\n\n/* Facility rail + slot layout (Book Slot) */\n/* minmax(0, ...) on both tracks, not plain 1fr: a grid track's default\n   minimum is min-content, so a single unbreakable child — a facility name\n   that no longer wraps — widens its column past the viewport and takes the\n   whole page sideways with it. Caught by ?auto=wrapcheck's overflow half. */\n.fr-book-layout { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 32px; align-items: start; }\n.fr-facility-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }\n.fr-facility-item {\n  display: block; width: 100%; text-align: left; font: inherit; font-weight: 500;\n  padding: 10px 12px; border-radius: 9px; background: transparent; border: none;\n  color: var(--text-secondary); cursor: pointer; transition: background-color 120ms ease, color 120ms ease;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n@media (hover: hover) { .fr-facility-item:hover { background: var(--bg-elevated); color: var(--text); } }\n.fr-facility-item.is-active { background: var(--accent); color: var(--accent-text); }\n.fr-book-field { margin-bottom: 16px; }\n.fr-book-field-label { display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.fr-book-results-title { font-weight: 600; margin: 0 0 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n\n.fr-slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }\n.fr-slot {\n  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;\n  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px;\n  padding: 12px 14px; cursor: pointer; text-align: left; font: inherit; color: var(--text);\n  transition: border-color 120ms ease, background-color 120ms ease;\n}\n@media (hover: hover) { .fr-slot:hover:not(:disabled) { border-color: var(--text-secondary); } }\n.fr-slot.is-selected { border-color: var(--accent); background: var(--bg-elevated-2); }\n.fr-slot:disabled { opacity: 0.4; cursor: not-allowed; }\n/* Looks unavailable, still answers when tapped — a real `disabled` button\n   swallows the click, and these have a reason to give. */\n.fr-slot.is-blocked { opacity: 0.4; cursor: pointer; }\n@media (hover: hover) { .fr-slot.is-blocked:hover { border-color: var(--border); } }\n.fr-slot-time { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; max-width: 100%; overflow: hidden; }\n.fr-slot-cap { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; min-height: 1.125em; }\n.fr-slot-cap:empty::before { content: '\\00a0'; }\n.fr-slot-notice {\n  margin: 0 0 16px; padding: 10px 14px; background: var(--bg-elevated);\n  border: 1px solid var(--border); border-radius: 10px;\n  font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.45;\n}\n\n/* A slot the portal hasn't opened yet: real, dated, and schedulable, but\n   not bookable now — dashed to say \"not yet\" without inventing a colour. */\n.fr-slot--later { border-style: dashed; color: var(--text-secondary); }\n.fr-slot--later .fr-slot-time { color: var(--text); }\n@media (hover: hover) { .fr-slot--later:hover { border-color: var(--text-secondary); } }\n.fr-slot--later.is-scheduled { border-style: solid; border-color: var(--accent); }\n.fr-slot--later.is-scheduled .fr-slot-cap { color: var(--accent); }\n.fr-slot.is-confirming-cancel {\n  border-style: solid; border-color: var(--danger);\n  background: color-mix(in srgb, var(--danger) 14%, var(--bg-elevated));\n}\n.fr-slot.is-confirming-cancel .fr-slot-cap { color: var(--danger); font-weight: 600; }\n\n.fr-sched { margin-top: 28px; }\n.fr-sched-title {\n  font-size: 0.8125rem; font-weight: 600; text-transform: uppercase;\n  letter-spacing: 0.04em; color: var(--text-secondary); margin: 0 0 12px;\n}\n.fr-sched-row {\n  display: flex; align-items: center; justify-content: space-between; gap: 12px;\n  padding: 10px 0; border-top: 1px solid var(--border);\n}\n.fr-sched-main { min-width: 0; }\n.fr-sched-name, .fr-sched-note { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.fr-sched-name { margin: 0; font-weight: 600; font-size: 0.875rem; }\n.fr-sched-note { margin: 2px 0 0; font-size: 0.8125rem; color: var(--text-secondary); }\n\n/* A pending autobook in My Bookings is a real .fr-row (see\n   buildPendingBookingRow) — same 70px rhythm as an actual booking, not a\n   separate boxed list with its own heading. Dashed, not solid: the same\n   \"not real yet\" language .fr-slot--later already uses for a watched slot\n   that is a try, not a reservation. Neutral border, not accent — it's a\n   state, not a call to action. */\n.fr-row--pending { background: transparent; border: 1px dashed var(--border); }\n.fr-badge.is-pending { background: transparent; border: 1px dashed var(--border); color: var(--text-secondary); }\n\n/* A switch, for the one place the UI has a real on/off choice (repeat\n   this autobook daily). A button with aria-pressed rather than a\n   checkbox: it has to sit in a grid cell next to inputs and buttons and\n   match their height, which a native checkbox will not do without more\n   overriding than the control is worth. */\n.fr-switch-row {\n  display: flex; align-items: center; justify-content: space-between; gap: 8px;\n}\n/* Lets the text side actually wrap in a narrow container (the long-press\n   menu's settings view) instead of a flex item's default min-width:auto\n   holding it to its unwrapped intrinsic width. Inert everywhere else\n   this is used (Book Slot's short, hint-less \"Daily\" row). */\n.fr-switch-row > div:first-child { min-width: 0; }\n.fr-switch-label { font-size: 0.8125rem; font-weight: 500; color: var(--text-secondary); white-space: nowrap; }\n.fr-switch-hint { margin: 2px 0 0; font-size: 0.8125rem; color: var(--text-secondary); }\n.fr-switch {\n  flex-shrink: 0; width: 42px; height: 24px; padding: 2px;\n  border-radius: 999px; border: 1px solid var(--border);\n  background: var(--bg-elevated-2); cursor: pointer;\n  transition: background-color 140ms ease, border-color 140ms ease;\n}\n.fr-switch-knob {\n  display: block; width: 18px; height: 18px; border-radius: 50%;\n  background: var(--text-secondary);\n  transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 140ms ease;\n}\n.fr-switch[aria-pressed=\"true\"] { background: var(--accent); border-color: transparent; }\n.fr-switch[aria-pressed=\"true\"] .fr-switch-knob { transform: translateX(18px); background: var(--accent-text); }\n\n/* Says what scheduling actually promises. Autobook watches and retries;\n   it does not hold a slot, and a slot that is full stays full until\n   someone cancels. Saying so once, here, is cheaper than a support\n   conversation with yourself in three weeks. */\n.fr-confirm-note {\n  margin: 0; font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.45;\n  text-wrap: pretty;\n}\n.fr-confirm-warn {\n  margin: 0; font-size: 0.8125rem; line-height: 1.45; color: var(--danger);\n  background: color-mix(in srgb, var(--danger) 12%, var(--bg-elevated));\n  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);\n  padding: 10px 12px; border-radius: 8px;\n  text-wrap: pretty;\n}\n\n/* Auto-booking results land while you are somewhere else in the app, so\n   they are announced above whatever tab is open rather than buried in the\n   one that caused them. */\n/* An overlay, not a row in the shell. It used to sit in normal flow\n   between the nav and .fr-content, so a result arriving shoved the whole\n   page down — the same layout-shift this codebase already refuses\n   elsewhere (see attachCancelConfirm, where three designs were rejected\n   for moving the row they appeared in). A booking result is a\n   notification: it should arrive over the page, not rearrange it.\n   pointer-events are off on the host so the gaps around a banner stay\n   clickable, and back on for the banner itself. */\n.fr-banner-host {\n  position: fixed;\n  top: 72px;\n  right: 48px;\n  width: min(440px, calc(100vw - 96px));\n  z-index: 30;\n  pointer-events: none;\n}\n.fr-banner-host:empty { display: none; }\n\n/* One slot per banner, animating its own height. Nothing outside the\n   overlay depends on this any more, but with two banners stacked it is\n   what makes dismissing the top one slide the second up instead of\n   snapping it. grid-template-rows 0fr -> 1fr is the reliable way to\n   transition to a content-derived height; the clip needs min-height: 0 or\n   the grid item refuses to shrink below its content. */\n.fr-banner-slot {\n  display: grid;\n  grid-template-rows: 0fr;\n  transition: grid-template-rows 280ms cubic-bezier(0.2, 0.8, 0.2, 1);\n}\n.fr-banner-slot.is-open { grid-template-rows: 1fr; }\n.fr-banner-clip { overflow: hidden; min-height: 0; }\n.fr-banner {\n  display: flex; align-items: center; justify-content: space-between; gap: 12px;\n  border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin: 12px 0 0;\n  /* Opaque and lifted: it now floats over real content, so it needs to\n     read as being above the page rather than part of it. */\n  background: var(--bg-elevated);\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);\n  pointer-events: auto;\n  opacity: 0;\n  transform: translateY(-10px);\n  transition: opacity 200ms ease, transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1);\n}\n.fr-banner-slot.is-open .fr-banner { opacity: 1; transform: none; }\n.fr-banner.is-good { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); background: var(--success-bg); }\n.fr-banner.is-bad { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); background: var(--danger-bg); }\n.fr-banner-main { min-width: 0; }\n.fr-banner-title {\n  margin: 0; font-weight: 600; font-size: 0.875rem;\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n}\n.fr-banner.is-good .fr-banner-title { color: var(--success); }\n.fr-banner.is-bad .fr-banner-title { color: var(--danger); }\n/* Deliberately the one line here that still wraps: it carries the\n   portal's own refusal text verbatim, and a truncated reason is worse\n   than a two-line banner. The banner is a single full-width element with\n   nothing beside it to knock out of alignment. */\n.fr-banner-note { margin: 2px 0 0; font-size: 0.8125rem; color: var(--text-secondary); }\n\n.fr-confirm-panel {\n  margin-top: 20px; padding: 18px 20px; background: var(--bg-elevated);\n  border: 1px solid var(--border); border-radius: 14px;\n  display: flex; flex-direction: column; gap: 12px;\n  scroll-margin-bottom: 120px;\n}\n.fr-confirm-header {\n  display: flex; align-items: center; justify-content: space-between; gap: 12px;\n}\n.fr-confirm-panel-title { font-weight: 600; font-size: 0.9375rem; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.fr-confirm-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }\n.fr-confirm-submit { width: 100%; height: 42px; font-weight: 600; justify-content: center; scroll-margin-bottom: 120px; }\n.fr-success-panel { background: var(--success-bg); color: var(--success); border-radius: 10px; padding: 14px 16px; font-weight: 500; margin-top: 24px; }\n/* createReservation returns state:SUCCESS with a plain message string even\n   when the booking was refused (e.g. \"More than 1 bookings are not allowed\n   for selected resource.\") — the try/catch never fires for that case, so\n   this panel exists to show refusals as refusals instead of green success. */\n.fr-error-panel { background: var(--danger-bg); color: var(--danger); border-radius: 10px; padding: 14px 16px; font-weight: 500; margin-top: 24px; }\n.fr-error-text { color: var(--danger); }\n\n/* Gyan chat tab */\n.fr-content--gyan { overflow: hidden; height: 100%; padding: 24px 48px 24px; }\n.fr-gyan-page { display: flex; flex-direction: column; height: 100%; min-height: 0; max-width: 720px; }\n.fr-gyan-messages { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; }\n/* A short exchange used to sit flush against the header, leaving a dead\n   gap down to the composer — the opposite of every chat convention, where\n   the live edge of the conversation stays anchored next to the input. The\n   auto margin hugs the list to the bottom when it's shorter than the\n   viewport and steps out of the way once real content overflows, so\n   scrolling still works normally for a long conversation. The empty/\n   welcome state is a different kind of content (an explanation, not a\n   conversation) and gets centered instead, not bottom-anchored. */\n.fr-gyan-list { display: flex; flex-direction: column; gap: 12px; margin-top: auto; }\n.fr-gyan-messages > .fr-empty { margin: auto 0; }\n.fr-gyan-welcome-wrap { margin: auto 0; display: flex; flex-direction: column; align-items: center; gap: 24px; width: 100%; }\n.fr-gyan-suggestions { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; max-width: 540px; }\n.fr-gyan-suggestions-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }\n.fr-gyan-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }\n.fr-gyan-chip {\n  font: inherit; font-size: 0.8125rem; font-weight: 500; color: var(--text);\n  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 20px;\n  padding: 7px 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;\n  transition: all 150ms ease; user-select: none;\n}\n.fr-gyan-chip .icon { width: 14px; height: 14px; color: var(--accent); }\n/* :active (a real touch press) stays ungated — unlike :hover it has a\n   real \"release\" on touch, so it can't get stuck the same way. */\n.fr-gyan-chip:active:not(:disabled) {\n  background: var(--bg-elevated-2); border-color: var(--accent); color: var(--text);\n  transform: translateY(-1px);\n}\n@media (hover: hover) {\n  .fr-gyan-chip:hover:not(:disabled) {\n    background: var(--bg-elevated-2); border-color: var(--accent); color: var(--text);\n    transform: translateY(-1px);\n  }\n}\n/* Dimmed while Gyan is still initialising — the chips submit through the\n   composer, so they follow the send button's disabled state exactly. */\n.fr-gyan-chip:disabled { opacity: 0.45; cursor: default; transform: none; }\n.fr-gyan-msg { display: flex; }\n.fr-gyan-msg--user { justify-content: flex-end; }\n.fr-gyan-msg--assistant { justify-content: flex-start; }\n.fr-gyan-bubble {\n  max-width: 75%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap;\n  word-break: break-word; line-height: 1.45;\n}\n.fr-gyan-bubble strong, .fr-gyan-bubble b { font-weight: 700; color: var(--text); }\n.fr-gyan-msg--user .fr-gyan-bubble { background: var(--accent); color: var(--accent-text); }\n.fr-gyan-msg--assistant .fr-gyan-bubble { background: var(--bg-elevated); color: var(--text); }\n.fr-gyan-typing { color: var(--text-secondary); font-style: italic; }\n.fr-gyan-composer { display: flex; gap: 10px; margin-top: 16px; flex-shrink: 0; }\n.fr-gyan-composer .fr-input { flex: 1; }\n@keyframes fr-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }\n.fr-spinner-svg { animation: fr-spin 0.8s linear infinite; width: 18px; height: 18px; display: block; }\n.fr-btn--loading { min-width: 64px; display: inline-flex; align-items: center; justify-content: center; opacity: 0.65; cursor: not-allowed; }\n\n/* The off-state fallback: only ever visible while the reskin itself is\n   off, at which point #flame-reskin-root (and every in-shell control) is\n   hidden entirely — nothing of ours is ever on screen at the same time, so\n   this one genuinely can't collide with anything regardless of viewport or\n   which tab was last open. Hidden by default; body.flame-reskin-off is the\n   only thing that ever shows it. */\n#flame-reskin-toggle {\n  display: none;\n}\nbody.flame-reskin-off #flame-reskin-toggle {\n  display: block;\n  position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;\n  background: #1a1e28; color: #eef0f6; border: 1px solid #2b3040;\n  border-radius: 999px; padding: 8px 16px; font: 600 12px ui-sans-serif, -apple-system, sans-serif;\n  cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.45);\n}\n@media (hover: hover) { #flame-reskin-toggle:hover { background: #232838; } }\n\n@media (max-width: 760px) {\n  .fr-nav {\n    position: fixed; left: 0; right: 0; bottom: 0; top: auto;\n    width: auto; height: 68px;\n    border-right: none; border-top: 1px solid var(--border); border-bottom: none;\n    padding: 8px 8px calc(8px + var(--flame-navbar-inset)); background: var(--bg); align-items: center; z-index: 5;\n    height: calc(68px + var(--flame-navbar-inset));\n  }\n  .fr-brand, .fr-nav > .fr-nav-toggle { display: none; }\n  .fr-nav-list { flex: 1; justify-content: space-around; }\n  .fr-nav-btn { flex-direction: column; gap: 4px; padding: 6px 10px; }\n  .fr-nav-label { font-size: 0.6875rem; }\n  .fr-content { padding: 12px 20px calc(96px + var(--flame-navbar-inset)); }\n  /* Bottom on mobile, sitting just above the tab bar: at the top it\n     landed straight on the page heading, and a result you can dismiss\n     without moving your thumb off the nav is the better answer anyway.\n     Same reason Android puts snackbars there. */\n  .fr-banner-host {\n    top: auto;\n    bottom: calc(76px + var(--flame-navbar-inset));\n    right: 20px; left: 20px; width: auto;\n  }\n  /* Rising from below, since that is now the edge it comes from. */\n  .fr-banner { transform: translateY(10px); margin: 0 0 12px; }\n  .fr-book-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }\n  .fr-book-field:last-child { margin-bottom: 0; }\n  .fr-datestrip { gap: 4px; }\n  .fr-datestrip-cells { gap: 4px; }\n  .fr-datestrip-cell { padding: 8px 0; }\n  .fr-datestrip-weekday { font-size: 0.625rem; }\n  .fr-datestrip-daynum { font-size: 0.9375rem; }\n  .fr-daynav-btn { width: 28px; height: 28px; }\n  /* .fr-row's justify-content:space-between shoves fr-row-main to the far\n     right edge on class-schedule rows (only 2 children: time + main) —\n     reads fine on a wide desktop row but leaves an ugly gap on mobile's\n     narrower rows. Scoped to rows with a .fr-row-time child specifically\n     (only class-schedule rows have one) so booking rows — which rely on\n     space-between to push their status pill/cancel button to the right —\n     are untouched. */\n  .fr-row:has(.fr-row-time) { justify-content: flex-start; }\n  /* Day/week toggle moves up next to the title; the day-nav/date-strip\n     gets its own full-width row below (same grid, different areas). */\n  .fr-cal-header { grid-template-areas: \"title toggle\" \"nav nav\"; }\n  /* Wider floor than the old 130px: \"11 AM - 12 PM\" has to fit on one\n     line, or the trailing meridiem wraps and that one tile grows taller\n     than the rest of the grid. Two columns still fit a 360px viewport. */\n  .fr-slot-grid { grid-template-columns: repeat(auto-fill, minmax(146px, 1fr)); }\n  .fr-slot { padding: 11px 12px; }\n  .fr-slot-time { font-size: 0.9375rem; }\n  .fr-row { gap: 10px; padding: 12px 14px; }\n  /* A narrow row can't afford both a status pill and a Cancel button, and\n     doesn't need both: the button only ever renders on a booked\n     reservation, so the pill next to it is restating the obvious. Dropping\n     it buys the title/time line ~70px, which is the difference between\n     \"Tomorrow - 9 AM - 10 AM\" fitting on one line and wrapping. */\n  .fr-row-actions:has(.fr-cancel-wrap) .fr-badge { display: none; }\n  /* Both answers stay short enough that the row's time line survives at\n     360px; see attachCancelConfirm for why the safe one sits on the right. */\n  .fr-cancel-wrap { gap: 6px; }\n  /* Week view: .fr-cal-scroll (always overflow-x:auto) lets the grid\n     scroll horizontally at a readable column width instead of squeezing 7\n     days into the viewport — the JS gives .fr-cal-days a min-width in\n     week mode to force this. */\n  .fr-cal-gutter { position: sticky; left: 0; z-index: 1; background: var(--bg); }\n  .fr-confirm-panel { grid-template-columns: 1fr; }\n  .fr-content--gyan {\n    height: 100%;\n    overflow: hidden;\n    padding: 12px 20px calc(80px + var(--flame-navbar-inset));\n  }\n}\n\n/* A booking result is worth noticing, but not worth insisting on for\n   someone who has asked the system for less movement. The end states are\n   identical, only the travel is dropped. */\n@media (prefers-reduced-motion: reduce) {\n  .fr-banner-slot, .fr-banner { transition: none; }\n  .fr-banner { transform: none; }\n}\n";

  // The design system's CSS, injected as one <style> tag.
  //
  // esbuild's text loader turns the .css file into a string at build time —
  // the same thing the single-file version did with a template literal,
  // minus the escaping traps (a bare \0 followed by a digit is an illegal
  // octal escape in a template literal, which is why .fr-row-meta's
  // non-breaking space had to be written '\\00a0' there and can be written
  // normally here).


  function injectComponentStyles() {
    if (document.getElementById('flame-reskin-styles')) return;
    const style = document.createElement('style');
    style.id = 'flame-reskin-styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // 13. Book Slot tab — facility rail + auto-checked availability + submit
  // ---------------------------------------------------------------------


  const bookState = { facilities: null, categoryIdx: 0, resourceId: null, date: startOfToday() };

  // getResources returns each facility's rooms in whatever order the query
  // produced — ARB001, ARB004, ARB002, ARB101 — which reads as no order at
  // all in the picker. Sorted once here, at the point the data lands, so the
  // picker, the default selection and anything else reading bookState all
  // agree.
  //
  // Numeric collation is what makes ARB002 come before ARB101 (a plain
  // string sort puts "101" before "2"), and it puts Discussion Room A/B/C in
  // sequence. The one case it gets wrong on its own is a name carrying an
  // operating window — "Gym ( 3:00 pm to 11:00 pm slot )" would sort before
  // "Gym ( 6:00 am to 2:00 pm slot )" on the bare digit 3 — so a window is
  // split off and compared as a real time, listing the morning gym first.
  // Pinned to 'en' rather than the device's locale: this order is not
  // presentation. firstLiveResource() takes the default selection from it,
  // so `undefined` would let the phone's language decide which resource is
  // preselected — the same "the environment decides behaviour" mistake that
  // drew every slot twice. The names are English either way.
  const RESOURCE_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const RESOURCE_WINDOW_RE = /^(.*?)\s*\(\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i;

  function splitResourceWindow(name) {
    const m = RESOURCE_WINDOW_RE.exec(name || '');
    if (!m) return { label: (name || '').trim(), startMinutes: 0 };
    const hour12 = Number(m[2]) % 12;
    const hour = m[4].toLowerCase() === 'p' ? hour12 + 12 : hour12;
    return { label: m[1].trim(), startMinutes: hour * 60 + Number(m[3] || 0) };
  }

  function sortResources(resources) {
    return resources.slice().sort((a, b) => {
      const left = splitResourceWindow(a.name);
      const right = splitResourceWindow(b.name);
      return RESOURCE_COLLATOR.compare(left.label, right.label) || left.startMinutes - right.startMinutes;
    });
  }

  // A resource's day is spent when its slot times are known and every one of
  // them has already started. That is knowable locally — knownSlotTimes reads
  // the operating window out of the resource's own name — so it is an answer,
  // not a guess, and the grid never has to ask the server for it.
  //
  // An unparseable time makes every() false rather than true: not knowing is
  // not the same as knowing it is over, and the request is the right move then.
  function windowSpent(resource, isoDate, nowMs) {
    const known = knownSlotTimes(resource);
    if (!known.length) return false;
    return known.every((sl) => {
      const start = slotStartDate(isoDate, sl.startTime);
      return !!start && start.getTime() <= nowMs;
    });
  }

  // Default to a window the user can actually act on. The resource list is
  // sorted by start time, so resources[0] is the *earliest* window — which
  // after 1 pm is the one gym option guaranteed to be over. Picking the first
  // live one instead is what keeps the common case ("book the gym") from
  // opening on a dead end.
  function firstLiveResource(facility, isoDate, nowMs) {
    if (!facility || !facility.resources.length) return null;
    return facility.resources.find((r) => !windowSpent(r, isoDate, nowMs)) || facility.resources[0];
  }

  // The confirm panel is appended below the slot grid, usually past the fold,
  // and it is the last thing on the page — so selecting a slot scrolls the
  // whole page to the bottom, which is what the panel opening should feel
  // like. scrollIntoView could not do this: `block: 'end'` aligns the button
  // with the bottom of the scrollport, which on mobile is exactly where the
  // fixed nav bar sits, so the button landed underneath it. Going to the
  // bottom is safe because .fr-content's own bottom padding (96px + the nav
  // bar inset on mobile) is more than the bar's height, so the end of the
  // content parks above it rather than behind it — and confirmScrollDelta
  // verifies exactly that rather than trusting the arithmetic.
  const CONFIRM_SCROLL_GAP = 12;
  const CONFIRM_SCROLL_SETTLE_MS = 400;

  // How far the scroller has to move for `target` to sit fully inside the
  // part of it nothing is covering. Positive scrolls down. 0 means it is
  // already there, which is also the answer once a scroll has landed.
  function confirmScrollDelta(scroller, target) {
    const nav = document.querySelector('.fr-nav');
    // Only a fixed nav bar overlaps the scroller — the desktop bar is in
    // normal flow above it and takes nothing away from the view.
    const covered = nav && getComputedStyle(nav).position === 'fixed'
      ? nav.getBoundingClientRect().height
      : 0;
    const view = scroller.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    const topEdge = view.top + CONFIRM_SCROLL_GAP;
    const bottomEdge = view.bottom - covered - CONFIRM_SCROLL_GAP;

    let delta = 0;
    if (box.bottom > bottomEdge) delta = box.bottom - bottomEdge;
    else if (box.top < topEdge) delta = box.top - topEdge;
    // A panel taller than the view can't fit whole; keep its top on screen
    // rather than scrolling the header off to chase the bottom.
    if (delta > 0 && box.top - delta < topEdge) delta = box.top - topEdge;
    return Math.abs(delta) < 1 ? 0 : delta;
  }

  function scrollConfirmIntoView(target) {
    const scroller = target.closest('.fr-content');
    if (!scroller) {
      target.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
      return;
    }

    const bottomOf = () => scroller.scrollHeight - scroller.clientHeight;

    // Issued synchronously, and deliberately not from inside
    // requestAnimationFrame: the panel is already in the document by the
    // time this is called, and reading layout flushes it anyway, so there is
    // nothing a frame would add — while rAF is not dependable here at all.
    // It goes unserviced whenever this WebView decides it has nothing to
    // paint (the same starvation that deadlocked the cold-launch cover; the
    // harness reproduces it, and the scroll simply never ran).
    scroller.scrollTo({ top: bottomOf(), behavior: 'smooth' });

    // Smooth scrolling is a request, not a guarantee: Android WebView drops
    // it some of the time (headless Chrome ignores it outright), and the
    // grid above can still reflow after the panel opens, moving the bottom
    // after the scroll was aimed at it — which together are why this landed
    // short from some slot rows before. So look at where it actually ended
    // up and finish the job without animation, unless the user has taken
    // over, in which case their scroll wins and we leave it alone.
    let taken = false;
    const takeOver = () => { taken = true; };
    const opts = { passive: true, once: true };
    scroller.addEventListener('touchstart', takeOver, opts);
    scroller.addEventListener('wheel', takeOver, opts);
    setTimeout(() => {
      scroller.removeEventListener('touchstart', takeOver);
      scroller.removeEventListener('wheel', takeOver);
      if (taken || !target.isConnected) return;
      const bottom = bottomOf();
      if (scroller.scrollTop < bottom - 1) scroller.scrollTop = bottom;
      // The bottom is the intent; the button being visible is the
      // requirement. If some future layout ever puts the two in conflict,
      // this is what keeps the button reachable.
      const left = confirmScrollDelta(scroller, target);
      if (left) scroller.scrollTop += left;
    }, CONFIRM_SCROLL_SETTLE_MS);
  }

  async function fetchFacilities() {
    const raw = await callAura('CustomBookingController', 'getResources', null, true);
    return JSON.parse(raw).map((f) => ({ ...f, resources: sortResources(f.resources || []) }));
  }

  async function renderBookSlot(token) {
    if (!bookState.facilities) {
      // Everything above the slot grid — the facility rail, the resource
      // picker, the day nav — is drawn from this one list, and the list is
      // the same all semester. Waiting on a round trip to draw a rail whose
      // contents never change is the whole reason this tab used to open on
      // a blank page. So last week's copy paints now and the request still
      // goes out; only an answer that differs is allowed to touch the UI.
      const cached = readPersistedResources();
      if (cached) {
        bookState.facilities = cached;
        fetchFacilities()
          .then((fresh) => {
            if (!fresh || !fresh.length || sameData(fresh, bookState.facilities)) return;
            bookState.facilities = fresh;
            writePersistedResources(fresh);
            // Rare enough to be worth a plain repaint: a resource was added
            // or renamed, which changes the rail and the picker together.
            // Not a loop — facilities is set, so this returns straight past
            // the branch it is standing in.
            if (token === ui.activeToken) renderBookSlot(token);
          })
          .catch(() => {
            // A failed revalidation leaves the cached list on screen, which
            // is the same list the portal had a moment ago.
          });
      } else {
        bookState.facilities = await fetchFacilities();
        writePersistedResources(bookState.facilities);
      }
    }
    const facilities = bookState.facilities;
    if (token !== ui.activeToken) return;
    if (!bookState.resourceId && facilities[bookState.categoryIdx]) {
      const live = firstLiveResource(facilities[bookState.categoryIdx], isoDateLocal(bookState.date), Date.now());
      bookState.resourceId = live.resourceId;
    }

    const page = el('div', { class: 'fr-page' });
    page.appendChild(el('h1', { class: 'fr-page-title', text: 'Book a Slot' }));

    const layout = el('div', { class: 'fr-book-layout' });

    // Left: facility category rail + resource picker + day nav
    const leftCol = el('div', {});
    const facilityList = el('div', { class: 'fr-facility-list' });
    const resourceField = el('div', { class: 'fr-book-field' });
    resourceField.appendChild(el('span', { class: 'fr-book-field-label', text: 'Resource' }));
    const resourcePicker = buildPicker({ ariaLabel: 'Resource', onChange: () => refreshAvailability() });
    resourceField.appendChild(resourcePicker.el);

    const dayField = el('div', { class: 'fr-book-field' });

    // Right: results
    const rightCol = el('div', {});
    const resultsWrap = el('div', {});
    const confirmWrap = el('div', {});
    rightCol.append(resultsWrap, confirmWrap);

    function currentResource() {
      const facility = facilities[bookState.categoryIdx];
      return (facility && facility.resources.find((r) => r.resourceId === resourcePicker.value)) || null;
    }

    // A slot card as a box, before anything is known about it. The times
    // are not a guess: knownSlotTimes derives them from the resource's own
    // operating window ("Gym ( 6:00 am to 2:00 pm slot )" is eight hourly
    // slots), falling back to whatever that resource last offered. So the
    // grid can be drawn with real labels, in the real number of cards, and
    // only the capacity line — the one thing that genuinely needs the
    // server — is left shimmering.
    function createSlotShell(sl) {
      const btn = el('button', { class: 'fr-slot fr-slot--skeleton', type: 'button', disabled: '' });
      btn.dataset.start = slotTimeKey(sl.startTime);
      btn.append(
        el('span', { class: 'fr-slot-time', text: compactTimeRange(sl.startTime, sl.endTime) }),
        el('span', { class: 'fr-slot-cap' }, [skel(7)])
      );
      return btn;
    }

    // The window this resource covers, as the day nav writes it — "6 AM – 2 PM"
    // — built from the resource's own slot times rather than re-parsing its
    // name, so it matches the cards the grid would have drawn.
    function windowLabel(resource) {
      const known = knownSlotTimes(resource);
      if (!known.length) return cleanResourceName(resource.name);
      return compactTimeRange(known[0].startTime, known[known.length - 1].endTime);
    }

    // The same facility's other window for the same thing: the 3 PM gym when
    // the 6 AM gym is over. Matched on the resource *class* — the name without
    // its window suffix — so a spent gym never offers a squash court.
    function liveSiblingWindow(resource, isoDate, nowMs) {
      const facility = facilities[bookState.categoryIdx];
      if (!facility) return null;
      const klass = cleanResourceName(resource.name).toLowerCase();
      return facility.resources.find((r) => (
        r.resourceId !== resource.resourceId
        && cleanResourceName(r.name).toLowerCase() === klass
        && !windowSpent(r, isoDate, nowMs)
      )) || null;
    }

    // Every slot this resource has for this day is already behind us, and that
    // was knowable without asking. Drawn immediately: no skeleton (there is
    // nothing truthful to predict), no spinner, and no request whose only
    // possible answer is an empty list.
    function renderWindowSpent(resource, isoDate, nowMs) {
      const sibling = liveSiblingWindow(resource, isoDate, nowMs);
      const action = sibling
        ? {
          label: `Switch to ${windowLabel(sibling)}`,
          onClick: () => {
            bookState.resourceId = sibling.resourceId;
            resourcePicker.value = sibling.resourceId;
            refreshAvailability();
          },
        }
        : {
          label: 'Try tomorrow',
          onClick: () => {
            bookState.date = addDays(bookState.date, 1);
            renderDayNav();
            paintResourceOptions();
            refreshAvailability();
          },
        };
      resultsWrap.replaceChildren(
        renderEmpty(
          'clock',
          `${windowLabel(resource)} is bookable from tomorrow`,
          '',
          'fr-empty--inline',
          action
        ),
        buildScheduledList(refreshAvailability)
      );
    }

    async function refreshAvailability() {
      confirmWrap.replaceChildren();
      const resource = currentResource();
      const isoDate = isoDateLocal(bookState.date);

      if (resource && windowSpent(resource, isoDate, Date.now())) {
        renderWindowSpent(resource, isoDate, Date.now());
        return;
      }

      // The scheduled-autobook list below the grid is read out of
      // localStorage, so it is drawn now rather than after a request it
      // never needed. When the resource's slot times can't be predicted at
      // all, there is nothing truthful to draw and the spinner is still the
      // honest answer.
      // A slot whose start is already behind us cannot be booked, and the
      // portal does not list it, so predicting it means drawing cards that
      // vanish the moment the answer lands — half the grid disappearing on
      // an afternoon open. Same predicate the known-slot fill below uses.
      const nowMs = Date.now();
      const expected = resource
        ? knownSlotTimes(resource).filter((sl) => {
            const start = slotStartDate(isoDate, sl.startTime);
            return !start || start.getTime() > nowMs;
          })
        : [];
      let grid = null;
      if (expected.length) {
        grid = el('div', { class: 'fr-slot-grid', 'aria-busy': 'true' });
        for (const sl of expected) grid.appendChild(createSlotShell(sl));
        // The claim note is drawn now for the same reason the scheduled
        // list is: it comes from an intent in localStorage, not from the
        // request. Leaving it out until the answer lands would push the
        // whole grid down a line at exactly the wrong moment.
        resultsWrap.replaceChildren(
          ...(claimNoteFor(resource, isoDate) ? [claimNoteFor(resource, isoDate)] : []),
          grid,
          buildScheduledList(refreshAvailability)
        );
      } else {
        resultsWrap.replaceChildren(el('div', { class: 'fr-loading', style: 'padding: 40px 0;' }, [el('div', { class: 'fr-spinner' })]));
      }
      let slots = [];
      let serverMessage = '';
      try {
        const raw2 = await callAura('CustomBookingController', 'getResourceAvailability', {
          resourceId: resourcePicker.value,
          bookingDate: isoDate,
        });
        let parsed = null;
        try {
          parsed = JSON.parse(raw2);
        } catch (e) {
          // raw2 is a plain message like "Booking date cannot be in the past."
        }
        if (parsed) {
          slots = parsed.availabilitySlots || [];
          rememberSlotTimes(resourcePicker.value, slots);
        } else {
          serverMessage = raw2;
        }
      } catch (e) {
        resultsWrap.replaceChildren(el('p', { class: 'fr-rail-meta fr-error-text', text: `Error: ${e.message}` }));
        return;
      }

      // A slot the portal won't list yet is not the same as a slot that
      // doesn't exist: bookings open 24h ahead, so the rest of the day is
      // real, just not open. Those are rendered too, as schedulable.
      const now = Date.now();
      // Keyed on the minute, not on the text: a derived "6:00 am" and the
      // portal's "6:00 AM" are the same slot, and comparing the strings drew
      // both of them.
      const bookable = new Map(slots.map((sl) => [slotTimeKey(sl.startTime), sl]));
      const timeline = [];
      for (const sl of slots) {
        const start = slotStartDate(isoDate, sl.startTime);
        const opensAt = start ? start.getTime() - BOOKING_WINDOW_MS : 0;
        const isOpenWindow = opensAt <= now;
        timeline.push({ ...sl, kind: isOpenWindow ? 'open' : 'later', opensAt });
      }
      for (const known of knownSlotTimes(resource)) {
        if (bookable.has(slotTimeKey(known.startTime))) continue;
        const start = slotStartDate(isoDate, known.startTime);
        if (!start || start.getTime() <= now) continue; // already gone today
        timeline.push({ ...known, kind: 'later', opensAt: start.getTime() - BOOKING_WINDOW_MS });
      }
      timeline.sort((a, b) => (parseClockMinutes(a.startTime) || 0) - (parseClockMinutes(b.startTime) || 0));

      if (!timeline.length) {
        resultsWrap.replaceChildren(
          serverMessage
            ? renderEmpty('clock', 'Nothing to book here', serverMessage, 'fr-empty--inline')
            : renderEmpty('clock', 'No open slots', 'Every slot for this day is taken or past.', 'fr-empty--inline', {
              label: 'Try tomorrow',
              onClick: () => {
                bookState.date = addDays(bookState.date, 1);
                renderDayNav();
                paintResourceOptions();
                refreshAvailability();
              },
            }),
          buildScheduledList(refreshAvailability)
        );
        return;
      }

      // Fill the cards that are already on screen rather than building a
      // second grid and swapping it in: same nodes, same positions, so the
      // answer arriving changes the words inside the cards and nothing else.
      // A card is only created here when the skeleton could not predict it.
      const shells = new Map();
      if (grid) for (const node of grid.children) shells.set(node.dataset.start, node);
      const ordered = [];
      for (const sl of timeline) {
        const slotBtn = shells.get(slotTimeKey(sl.startTime)) || createSlotShell(sl);
        shells.delete(slotTimeKey(sl.startTime));
        ordered.push(slotBtn);
        slotBtn.classList.remove('fr-slot--skeleton');
        slotBtn.classList.toggle('fr-slot--later', sl.kind === 'later');
        slotBtn.disabled = false;
        const cap = slotBtn.querySelector('.fr-slot-cap');
        // One auto-booking per resource class per day: if any waiting
        // intent already claims this class on this date, only the tile it
        // belongs to stays interactive. The rest say why they are inert
        // instead of accepting a tap that could never become a booking.
        // The claim is a property of the day, not of the tile's kind. This
        // used to be computed only for 'later' tiles, so an open slot on a
        // day already claimed by an autobook looked perfectly bookable.
        const claimedBy = conflictingIntent(resource.name, isoDate);
        // "Scheduled" means this exact slot on this exact day. A daily
        // series reaching forward from an earlier day claims the day too,
        // but it is not this tile's intent and must not offer to cancel it.
        const scheduled = !!claimedBy && claimedBy.date === isoDate
          && claimedBy.resourceId === resource.resourceId && slotTimeKey(claimedBy.startTime) === slotTimeKey(sl.startTime);
        const bySeries = !!claimedBy && claimedBy.date !== isoDate;
        // Two different answers for the two kinds. A second *autobook* on a
        // claimed day can never succeed, so it is refused outright. A manual
        // booking still can — it just costs the day, so it warns and stops
        // the pending intent instead of being blocked.
        const blocked = !!claimedBy && !scheduled && sl.kind === 'later';
        const warnsClaim = !!claimedBy && !scheduled && sl.kind === 'open';
        // A 'later' tile exists because availability did not list the slot.
        // Usually that means its 24h window has not opened; but when the
        // portal returns nothing at all for a resource, slots inside the
        // window land here too, and "Opens now" is a nonsense caption for
        // them. They are simply not on offer, and all autobook can do is
        // keep checking.
        const windowOpen = sl.kind === 'later' && sl.opensAt <= Date.now();
        // Truthful even when memory was wrong about this resource's hours.
        slotBtn.querySelector('.fr-slot-time').textContent = compactTimeRange(sl.startTime, sl.endTime);
        if (sl.kind === 'open') {
          cap.replaceChildren();
          cap.textContent = `${sl.availableCapacity} left`;
          if (sl.availableCapacity <= 0) slotBtn.disabled = true;
          slotBtn.addEventListener('click', () => {
            grid.querySelectorAll('.fr-slot').forEach((b) => b.classList.remove('is-selected'));
            slotBtn.classList.add('is-selected');
            openConfirm(sl, warnsClaim ? claimedBy : null);
          });
        } else {
          cap.replaceChildren();
          // A blocked tile says nothing at all. The reason is identical on
          // every one of them, so printing it down a whole grid is noise;
          // it is stated once above the grid, and again on tap.
          cap.textContent = scheduled ? 'Auto-booking ✓'
            : windowOpen ? 'Slots full'
            : `Opens ${relativeFuture(sl.opensAt)}`;
          slotBtn.classList.toggle('is-scheduled', scheduled);
          if (blocked) {
            // Not `disabled`: a disabled button never fires a click, and
            // this one has something to say. Looks unavailable, is marked
            // up as unavailable, still answers when tapped.
            slotBtn.classList.add('is-blocked');
            slotBtn.setAttribute('aria-disabled', 'true');
            slotBtn.title = blockedReason(claimedBy, bySeries);
          }
          let cancelTimer = null;
          let confirmingCancel = false;

          function resetCancelState() {
            if (!confirmingCancel) return;
            confirmingCancel = false;
            if (cancelTimer) {
              clearTimeout(cancelTimer);
              cancelTimer = null;
            }
            slotBtn.classList.remove('is-confirming-cancel');
            const cap = slotBtn.querySelector('.fr-slot-cap');
            if (cap) cap.textContent = 'Auto-booking ✓';
            document.removeEventListener('click', handleOutsideClick);
          }

          function handleOutsideClick(e) {
            if (!slotBtn.contains(e.target)) {
              resetCancelState();
            }
          }

          slotBtn.addEventListener('click', () => {
            if (blocked) {
              showNotice({
                title: bySeries ? 'Covered by a daily autobook' : 'Already scheduled that day',
                note: blockedReason(claimedBy, bySeries),
              });
              return;
            }
            if (scheduled) {
              const mine = loadIntents().find(
                (i) => i.state === 'waiting' && i.resourceId === resource.resourceId && i.date === isoDate && slotTimeKey(i.startTime) === slotTimeKey(sl.startTime)
              );
              if (!mine) return;

              if (!confirmingCancel) {
                confirmingCancel = true;
                slotBtn.classList.add('is-confirming-cancel');
                const cap = slotBtn.querySelector('.fr-slot-cap');
                if (cap) cap.textContent = 'Tap again to stop';

                setTimeout(() => {
                  if (confirmingCancel) document.addEventListener('click', handleOutsideClick);
                }, 0);

                cancelTimer = setTimeout(() => {
                  resetCancelState();
                }, 3000);
                return;
              }

              resetCancelState();
              removeIntent(mine.id);
              refreshAvailability();
              return;
            }
            grid.querySelectorAll('.fr-slot').forEach((b) => b.classList.remove('is-selected'));
            slotBtn.classList.add('is-selected');
            openAutoConfirm(sl, windowOpen);
          });
        }
      }
      // Whatever the skeleton predicted and the day did not have simply
      // does not make it into `ordered`, so this drops it.
      if (grid) grid.replaceChildren(...ordered);
      else grid = el('div', { class: 'fr-slot-grid' }, ordered);
      grid.removeAttribute('aria-busy');
      const claimNote = claimNoteFor(resource, isoDate);
      resultsWrap.replaceChildren(
        ...(claimNote ? [claimNote] : []),
        grid,
        buildScheduledList(refreshAvailability)
      );
    }

    // Said once, above the grid, so the greying is not a mystery until
    // something is tapped. Known without asking the portal anything — the
    // claim is an intent of ours, sitting in localStorage.
    function claimNoteFor(resource, isoDate) {
      const dayClaim = resource ? conflictingIntent(resource.name, isoDate) : null;
      return dayClaim
        ? el('p', { class: 'fr-slot-notice', text: blockedReason(dayClaim, dayClaim.date !== isoDate) })
        : null;
    }

    // One wording, three places: the tooltip, the tap notice, and the line
    // above the grid. Concise explanation with no repeated date or slot details.
    function blockedReason(claim, bySeries) {
      return bySeries
        ? 'A daily autobook already covers this day. Stop it below to book this day yourself.'
        : 'An autobook is already scheduled for this day. Stop it below to book this day yourself.';
    }

    // One wording for one rule, wherever it is set from. A daily series
    // beginning today supersedes any daily set for a later day, and both
    // panels can begin one, so both say the same sentence about it.
    function dailyClashText(futures) {
      if (!futures.length) return '';
      const first = futures[0];
      const parts = first.date.split('-').map(Number);
      const firstDate = new Date(parts[0], parts[1] - 1, parts[2]);
      return `Replaces daily autobook from ${dayLabel(firstDate)} (${compactTimeRange(first.startTime, first.endTime)}).`;
    }

    // A booking leaves its success panel on screen, so the grid is not
    // repainted around it — but the list under the grid has just gained a
    // series, or lost the intent this booking spent. Rebuilt in place;
    // refreshAvailability would clear the panel being read.
    function repaintScheduledList() {
      const old = resultsWrap.querySelector('.fr-sched');
      if (old) old.replaceWith(buildScheduledList(refreshAvailability));
    }

    function openConfirm(slot, claimedBy) {
      // currentResource(), not `resource`: that binding is local to
      // refreshAvailability and this is a sibling of it, not a child.
      const resource = currentResource();
      // Purpose/co-attendee only make sense for a room booking (who's
      // meeting, why) — a gym or pool slot doesn't need either, so skip
      // the fields entirely for Sports Facilities rather than showing
      // inputs with nothing meaningful to fill in.
      const facility = facilities[bookState.categoryIdx];
      const needsDetails = facility.facility_Name !== 'Sports Facilities';
      const purposeInput = needsDetails
        ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Purpose' })
        : null;
      const attendeeInput = needsDetails
        ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Co-attendee' })
        : null;
      const submitBtn = el('button', { class: 'fr-btn fr-btn--primary fr-confirm-submit', type: 'button', text: 'Confirm booking' });

      submitBtn.addEventListener('click', async () => {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Booking…';
        try {
          const userId = await resolveUserId();
          const result = await callAura('CustomBookingController', 'createReservation', {
            dateSelected: isoDateLocal(bookState.date),
            startTime: slot.startTime,
            endTime: slot.endTime,
            resource: resourcePicker.value,
            bookingPurpose: purposeInput ? purposeInput.value || '' : '',
            coAttendee: attendeeInput ? attendeeInput.value || '' : '',
            userId,
          });
          // createReservation returns state:SUCCESS (no thrown error) even
          // when the booking was refused — e.g. "More than 1 bookings are
          // not allowed for selected resource." — so success has to be
          // read out of the message itself. Real accepted bookings always
          // name the new booking id ("...Booking Id R-714794...").
          if (/\bR-\d+\b/.test(result)) {
            cache.bookings = null; // invalidate so My Bookings refetches
            clearPersistedBookings();
            // This booking just spent the day's one allowance, so a pending
            // autobook for the same resource that day can only fail now.
            // Clearing it here is the promise the warning above made. Done
            // before the series is armed, so the day it frees is a day the
            // series is allowed to step onto.
            if (claimedBy) removeIntent(claimedBy.id);
            // Today's slot is booked outright; the repeat starts at the next
            // occurrence, on the first day ahead that nothing else claims.
            const series = repeatSwitch.checked
              ? startDailySeries({
                  resource,
                  facilityName: facility.facility_Name,
                  date: bookState.date,
                  startTime: slot.startTime,
                  endTime: slot.endTime,
                  purpose: purposeInput ? purposeInput.value || '' : '',
                  coAttendee: attendeeInput ? attendeeInput.value || '' : '',
                })
              : null;
            const seriesStart = series ? slotStartDate(series.date, series.startTime) : null;
            confirmWrap.replaceChildren(
              el('div', { class: 'fr-success-panel', text: result }),
              // Said only when a repeat was asked for: what was armed and
              // where to call it off, or why nothing was.
              ...(repeatSwitch.checked
                ? [series
                    ? el('p', {
                        class: 'fr-confirm-note',
                        text: `Daily autobook starts ${seriesStart ? shortDayLabel(seriesStart) : series.date}. Stop it below.`,
                      })
                    : el('p', {
                        class: 'fr-confirm-warn',
                        text: 'Daily not started — an autobook already covers the next 7 days.',
                      })]
                : [])
            );
            repaintScheduledList();
          } else {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Confirm booking';
            confirmWrap.replaceChildren(el('div', { class: 'fr-error-panel', text: result }));
          }
        } catch (e) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm booking';
          confirmWrap.appendChild(el('p', { class: 'fr-error-text', text: `Failed: ${e.message}` }));
        }
      });

      // Ask before acting. The portal refuses a second booking of the same
      // resource class on the same day, and that refusal used to arrive as a
      // red error panel after a request that was never going to work. The
      // answer is already in the bookings list, so read it there.
      const conflictSlot = el('div', { class: 'fr-confirm-note' });
      existingBookingFor(resource.name, isoDateLocal(bookState.date))
        .then((booked) => {
          if (!booked) return;
          submitBtn.disabled = true;
          conflictSlot.className = 'fr-confirm-warn';
          conflictSlot.textContent =
            `Already booked ${cleanResourceName(resource.name)} ${formatBookingWhen(booked)} — one booking a day.`;
        })
        .catch(() => {
          // A failed lookup must not block a booking that might be fine;
          // the portal is still the authority and will say no if it must.
        });

      const warning = claimedBy
        ? el('p', {
            class: 'fr-confirm-warn',
            text: `Stops your ${compactTimeRange(claimedBy.startTime, claimedBy.endTime || claimedBy.startTime)} autobook — one booking a day.`,
          })
        : null;

      // The same Daily toggle the autobook panel carries. A series had to be
      // started from a future day before this — the only day whose slots are
      // not yet bookable — which is a strange place to have to go to say
      // "every day". Here it books this slot now and repeats from tomorrow.
      const futures = futureDailyIntents(resource.name, isoDateLocal(bookState.date));
      const dailyNote = el('p', { class: 'fr-confirm-note fr-confirm-daily' });
      const clashWarn = el('p', { class: 'fr-confirm-warn fr-confirm-daily-clash' });

      function updateDailyLines() {
        const on = repeatSwitch.checked;
        // The distinction worth the line: this one is booked, the rest are
        // only attempted, each when its own window opens.
        dailyNote.textContent = on ? 'Books now. Each following day is tried as its window opens.' : '';
        dailyNote.style.display = on ? 'block' : 'none';
        const clash = on ? dailyClashText(futures) : '';
        clashWarn.textContent = clash;
        clashWarn.style.display = clash ? 'block' : 'none';
      }

      const repeatSwitch = buildSwitch({ label: 'Daily', onChange: updateDailyLines });
      updateDailyLines();

      const header = el('div', { class: 'fr-confirm-header' }, [
        el('p', { class: 'fr-confirm-panel-title', text: `Book ${compactTimeRange(slot.startTime, slot.endTime)}` }),
        repeatSwitch.el,
      ]);

      const inputsWrap = (purposeInput || attendeeInput)
        ? el('div', { class: 'fr-confirm-inputs' }, [
            ...(purposeInput ? [purposeInput] : []),
            ...(attendeeInput ? [attendeeInput] : []),
          ])
        : null;

      confirmWrap.replaceChildren(
        el('div', { class: 'fr-confirm-panel' }, [
          header,
          ...(inputsWrap ? [inputsWrap] : []),
          ...(warning ? [warning] : []),
          conflictSlot,
          dailyNote,
          clashWarn,
          submitBtn,
        ])
      );
      scrollConfirmIntoView(submitBtn);
    }

    // The autobook twin of openConfirm. Same panel, same fields, because it
    // ends in the same createReservation call — just made later, by the
    // runner, from what is captured here.
    function openAutoConfirm(slot, windowOpen) {
      const resource = currentResource();
      if (!resource) return;
      const facility = facilities[bookState.categoryIdx];
      const needsDetails = facility.facility_Name !== 'Sports Facilities';
      const purposeInput = needsDetails
        ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Purpose' })
        : null;
      const attendeeInput = needsDetails
        ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Co-attendee' })
        : null;
      const isoDate = isoDateLocal(bookState.date);
      const futures = futureDailyIntents(resource.name, isoDate);
      const clashWarn = el('p', { class: 'fr-confirm-warn fr-confirm-daily-clash' });
      clashWarn.style.display = 'none';

      function updateClashWarn() {
        const text = repeatSwitch.checked ? dailyClashText(futures) : '';
        clashWarn.textContent = text;
        clashWarn.style.display = text ? 'block' : 'none';
      }

      const repeatSwitch = buildSwitch({ label: 'Daily', onChange: updateClashWarn });
      updateClashWarn();

      const submitBtn = el('button', { class: 'fr-btn fr-btn--primary fr-confirm-submit', type: 'button', text: 'Autobook' });

      const header = el('div', { class: 'fr-confirm-header' }, [
        el('p', { class: 'fr-confirm-panel-title', text: `Autobook ${compactTimeRange(slot.startTime, slot.endTime)}` }),
        repeatSwitch.el,
      ]);

      // What scheduling actually promises, said plainly. It watches and
      // retries; it does not reserve anything, and a full slot stays full
      // until somebody cancels.
      const note = el('p', {
        class: 'fr-confirm-note',
        text: windowOpen ? 'Currently full. Auto-checks for cancellations.'
                         : 'Attempts booking as soon as window opens.',
      });

      submitBtn.addEventListener('click', () => {
        const intent = scheduleIntent({
          resource,
          facilityName: facility.facility_Name,
          date: bookState.date,
          startTime: slot.startTime,
          endTime: slot.endTime,
          purpose: purposeInput ? purposeInput.value || '' : '',
          coAttendee: attendeeInput ? attendeeInput.value || '' : '',
          repeat: repeatSwitch.checked ? 'daily' : null,
        });
        confirmWrap.replaceChildren();
        if (!intent) {
          // scheduleIntent refuses a second one for the same resource class
          // and day; say so rather than silently doing nothing.
          confirmWrap.replaceChildren(
            el('div', {
              class: 'fr-error-panel',
              text: `You already have an autobook waiting for ${cleanResourceName(resource.name)} that day.`,
            })
          );
        }
        refreshAvailability();
      });

      const inputsWrap = (purposeInput || attendeeInput)
        ? el('div', { class: 'fr-confirm-inputs' }, [
            ...(purposeInput ? [purposeInput] : []),
            ...(attendeeInput ? [attendeeInput] : []),
          ])
        : null;

      confirmWrap.replaceChildren(
        el('div', { class: 'fr-confirm-panel' }, [
          header,
          ...(inputsWrap ? [inputsWrap] : []),
          note,
          clashWarn,
          submitBtn,
        ])
      );
      scrollConfirmIntoView(submitBtn);
    }

    facilities.forEach((facility, idx) => {
      const btn = el('button', { class: 'fr-facility-item', type: 'button', text: facility.facility_Name });
      btn.classList.toggle('is-active', idx === bookState.categoryIdx);
      btn.addEventListener('click', () => {
        bookState.categoryIdx = idx;
        const live = firstLiveResource(facility, isoDateLocal(bookState.date), Date.now());
        bookState.resourceId = live.resourceId;
        facilityList.querySelectorAll('.fr-facility-item').forEach((b, i) => b.classList.toggle('is-active', i === idx));
        paintResourceOptions();
        resourcePicker.value = bookState.resourceId;
        refreshAvailability();
      });
      facilityList.appendChild(btn);
    });

    // Repainted on a date step as well as a facility change: "over for today"
    // is true of a resource *on a date*, and stepping to tomorrow makes the
    // 6 am gym live again.
    function paintResourceOptions() {
      const facility = facilities[bookState.categoryIdx];
      const isoDate = isoDateLocal(bookState.date);
      const nowMs = Date.now();
      resourcePicker.setOptions(facility.resources.map((r) => ({
        value: r.resourceId,
        text: r.name,
        note: windowSpent(r, isoDate, nowMs) ? 'Bookable tomorrow' : '',
      })));
    }

    paintResourceOptions();
    resourcePicker.value = bookState.resourceId;

    // Facilities are cached above and only the availability results depend
    // on the date, so stepping the day rebuilds just the nav control and
    // refetches only resultsWrap (which has its own inline spinner) —
    // no full-page reload for a single date change.
    function renderDayNav() {
      dayField.replaceChildren(
        el('span', { class: 'fr-book-field-label', text: 'Date' }),
        buildDayNav({
          label: dayLabel(bookState.date),
          prevDisabled: sameDay(bookState.date, startOfToday()),
          onPrev: () => {
            bookState.date = addDays(bookState.date, -1);
            renderDayNav();
            paintResourceOptions();
            refreshAvailability();
          },
          onNext: () => {
            bookState.date = addDays(bookState.date, 1);
            renderDayNav();
            paintResourceOptions();
            refreshAvailability();
          },
          onToday: () => {
            bookState.date = startOfToday();
            renderDayNav();
            paintResourceOptions();
            refreshAvailability();
          },
        })
      );
    }
    renderDayNav();

    leftCol.append(facilityList, resourceField, dayField);
    layout.append(leftCol, rightCol);
    page.appendChild(layout);
    ui.contentEl.replaceChildren(page);

    refreshAvailability();
  }

  // ---------------------------------------------------------------------
  // 11. My Bookings tab
  // ---------------------------------------------------------------------


  async function renderMyBookings(token) {
    const userId = await resolveUserId();
    if (!cache.bookings) {
      cache.bookings = await callAura('CustomBookingController', 'getReservations', { userId });
    }
    const bookings = cache.bookings;
    if (token !== ui.activeToken) return;

    const waitingIntents = loadIntents().filter((i) => i.state === 'waiting');

    const page = el('div', { class: 'fr-page' });
    page.appendChild(el('h1', { class: 'fr-page-title', text: 'My Bookings' }));

    if (!bookings.length && !waitingIntents.length) {
      page.appendChild(renderEmpty('bookings', 'No bookings yet', 'Reserve a facility from Book Slot.'));
      ui.contentEl.replaceChildren(page);
      return;
    }

    const now = new Date();
    const today = startOfToday();
    const withDates = bookings.map((x) => ({ b: x, start: parseBookingDateTime(x.startDateTime) }));

    // Sectioned by calendar day, not by instant — a booking from earlier
    // today still reads as "today", not "past", which is what a student
    // checking "did I already use my gym slot" actually wants to see.
    const upcoming = withDates.filter((x) => x.start > today && !sameDay(x.start, today));
    const todaysBookings = withDates.filter((x) => sameDay(x.start, today));
    const past = withDates.filter((x) => x.start < today && !sameDay(x.start, today));

    upcoming.sort((a, b) => a.start - b.start);
    todaysBookings.sort((a, b) => a.start - b.start);
    past.sort((a, b) => b.start - a.start);

    // A watched intent belongs wherever its own date lands, same as a real
    // booking — booking a full slot for today autobooks into Today, not
    // Upcoming, and the date string sorts lexically same as ISO dates do.
    const todayIso = isoDateLocal(today);
    const todayIntents = waitingIntents.filter((i) => i.date <= todayIso);
    const upcomingIntents = waitingIntents.filter((i) => i.date > todayIso);

    const cancellableNow = (b) => b.status === 'Booked' && parseBookingDateTime(b.startDateTime) > now;

    // Pending rows are real .fr-rows, same 70px rhythm as an actual booking,
    // dashed instead of solid. In a section still ahead of you they sort in
    // by their own start time alongside the live bookings — an autobook
    // watch that's sooner than a confirmed booking shows first, same as any
    // other "what's actually next" question. Cancelled bookings still sink
    // below all of that: a cancelled slot sitting between two live ones (or
    // a watch) reads as "is this one still on?", so it sorts last, by its
    // own time among itself. Past has no intents to merge and stays
    // strictly chronological, cancellations included inline — sinking them
    // there would just pile every cancellation ever made at the bottom of a
    // section nobody re-checks anyway.
    function buildSection(title, items, pendingIntents) {
      const section = el('section', { class: 'fr-day-group' });
      section.appendChild(el('h2', { class: 'fr-group-heading', text: title }));

      if (pendingIntents === undefined) {
        if (items.length) {
          const list = el('div', { class: 'fr-list' });
          for (const { b } of items) list.appendChild(renderBookingRow(b, cancellableNow(b)));
          section.appendChild(list);
        }
        return section;
      }

      const live = items.filter((x) => x.b.status === 'Booked');
      const cancelled = items.filter((x) => x.b.status !== 'Booked').sort((a, b) => a.start - b.start);
      const merged = [
        ...live.map((x) => ({ kind: 'booking', start: x.start, b: x.b })),
        ...pendingIntents.map((i) => ({ kind: 'intent', start: slotStartDate(i.date, i.startTime) || new Date(`${i.date}T00:00:00`), i })),
      ].sort((a, b) => a.start - b.start);

      if (merged.length || cancelled.length) {
        const list = el('div', { class: 'fr-list' });
        for (const m of merged) {
          list.appendChild(m.kind === 'intent'
            ? buildPendingBookingRow(m.i, () => switchTab('bookings'))
            : renderBookingRow(m.b, cancellableNow(m.b)));
        }
        for (const { b } of cancelled) list.appendChild(renderBookingRow(b, false));
        section.appendChild(list);
      }
      return section;
    }

    if (upcoming.length || upcomingIntents.length) {
      page.appendChild(buildSection('Upcoming', upcoming, upcomingIntents));
    }
    if (todaysBookings.length || todayIntents.length) {
      page.appendChild(buildSection('Today', todaysBookings, todayIntents));
    }
    if (past.length) page.appendChild(buildSection('Past', past));

    ui.contentEl.replaceChildren(page);
  }

  function renderBookingRow(booking, cancellable) {
    const cancelled = booking.status !== 'Booked';
    const row = el('div', { class: cancelled ? 'fr-row is-cancelled' : 'fr-row' });
    const main = el('div', { class: 'fr-row-main' });
    const name = cleanResourceName(booking.resourceName);
    const when = formatBookingWhen(booking);
    const title = el('p', { class: 'fr-row-title', text: name, title: name });
    const meta = el('p', { class: 'fr-row-meta', text: when, title: when });
    main.append(title, meta);
    row.appendChild(main);

    // Pill and cancel control share one right-hand column so mobile can
    // treat them as a unit (it drops the pill when a cancel control is
    // present — see .fr-row-actions:has(.fr-cancel-wrap)).
    const actions = el('div', { class: 'fr-row-actions' });
    const statusClass = booking.status === 'Booked' ? 'is-booked' : 'is-cancelled';
    actions.appendChild(el('span', { class: `fr-badge ${statusClass}`, text: booking.status }));
    row.appendChild(actions);

    if (cancellable && booking.status === 'Booked') {
      attachCancelConfirm(booking, { row, actions, title, meta, name, when });
    }
    return row;
  }

  // Confirming a cancel costs the row nothing: its own title turns into the
  // question ("Gym" -> "Cancel Gym?"), so the booking is named once, where
  // its name already was, and the only new pixels are a second button. No
  // expansion, no overlay, no reflow — the row is exactly as tall and as
  // wide while asking as it is at rest, so every row in the list stays
  // identical. Earlier passes that added a separate question line, an
  // overlay, or a drawer are recorded in HANDOFF.md; each one had to buy
  // room the row did not have.
  function attachCancelConfirm(booking, parts) {
    const { row, actions, title, meta, name, when } = parts;
    const wrap = el('div', { class: 'fr-cancel-wrap' });
    actions.appendChild(wrap);

    const trigger = el('button', {
      class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Cancel', 'aria-expanded': 'false',
    });
    // Yes sits to the LEFT of No, which is the reverse of the usual order:
    // No lands on the exact spot the finger just left (the trigger's), so a
    // double-tap cannot cancel a booking. The danger fill makes Yes just as
    // findable from either side.
    const yesBtn = el('button', { class: 'fr-btn fr-btn--danger fr-btn--sm', type: 'button', text: 'Yes' });
    const noBtn = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'No' });

    function showIdle() {
      row.classList.remove('is-confirming');
      title.textContent = name;
      title.title = name;
      meta.textContent = when;
      meta.title = when;
      meta.classList.remove('fr-error-text');
      trigger.setAttribute('aria-expanded', 'false');
      yesBtn.disabled = false;
      yesBtn.textContent = 'Yes';
      noBtn.disabled = false;
      wrap.replaceChildren(trigger);
    }
    row.__frCloseConfirm = showIdle;

    trigger.addEventListener('click', (e) => {
      // One row asking at a time — two rows both reading "Cancel …?" is a
      // genuine misread risk, not just noise.
      for (const other of ui.contentEl.querySelectorAll('.fr-row.is-confirming')) {
        if (other !== row && other.__frCloseConfirm) other.__frCloseConfirm();
      }
      row.classList.add('is-confirming');
      const asking = `Cancel ${name}?`;
      title.textContent = asking;
      title.title = asking;
      trigger.setAttribute('aria-expanded', 'true');
      wrap.replaceChildren(yesBtn, noBtn);
      // Only chase the focus for a keyboard activation (click.detail === 0
      // means Enter/Space, not a real pointer) — a tap would otherwise be
      // left with a focus ring parked on a button it never targeted.
      if (e.detail === 0) noBtn.focus();
    });

    noBtn.addEventListener('click', () => {
      showIdle();
      trigger.focus();
    });

    row.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && row.classList.contains('is-confirming')) {
        showIdle();
        trigger.focus();
      }
    });

    yesBtn.addEventListener('click', async () => {
      yesBtn.disabled = true;
      noBtn.disabled = true;
      yesBtn.textContent = '…';
      try {
        const userId = await resolveUserId();
        await callAura('CustomBookingController', 'cancelReservation', { userId, bookingId: booking.bookingId });
        cache.bookings = null;
        clearPersistedBookings();
        await switchTab('bookings');
      } catch (e) {
        // The failure replaces the time line rather than adding anything:
        // the row still can't change size, and the title above still says
        // which booking failed. Both ways out stay where they are.
        const failure = `Couldn't cancel: ${e.message}`;
        meta.textContent = failure;
        meta.title = failure;
        meta.classList.add('fr-error-text');
        yesBtn.disabled = false;
        yesBtn.textContent = 'Retry';
        noBtn.disabled = false;
      }
    });

    showIdle();
  }

  // ---------------------------------------------------------------------
  // 10. Calendar tab — real day/week grid, no date picker
  // ---------------------------------------------------------------------


  const calState = { date: startOfToday(), mode: 'day' };

  const CAL_START_HOUR = 9;
  const CAL_END_HOUR = 19;
  const CAL_HOUR_HEIGHT = 78;

  // Greedy interval-graph lane packing so overlapping events sit side by
  // side instead of stacking on top of each other.
  function assignLanes(items) {
    const sorted = [...items].sort((a, b) => a.start - b.start);
    const laneEnds = [];
    const placed = [];
    for (const it of sorted) {
      let lane = laneEnds.findIndex((end) => end <= it.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(it.end);
      } else {
        laneEnds[lane] = it.end;
      }
      placed.push({ ...it, lane });
    }
    const totalLanes = laneEnds.length || 1;
    return placed.map((p) => ({ ...p, totalLanes }));
  }

  function buildCalDayColumn(dayDate, events, isToday) {
    const col = el('div', { class: 'fr-cal-day-col' });
    const totalHours = CAL_END_HOUR - CAL_START_HOUR;
    const body = el('div', { class: 'fr-cal-body', style: `height: ${totalHours * CAL_HOUR_HEIGHT}px;` });
    for (let h = 0; h < totalHours; h++) body.appendChild(el('div', { class: 'fr-cal-hour-row' }));

    const dayEvents = events
      .filter((e) => sameDay(new Date(e.startDateTime), dayDate))
      .map((e) => ({ start: new Date(e.startDateTime), end: new Date(e.endDateTime), raw: e }));
    const laned = assignLanes(dayEvents);

    for (const item of laned) {
      const startFrac = item.start.getHours() + item.start.getMinutes() / 60 - CAL_START_HOUR;
      const endFrac = item.end.getHours() + item.end.getMinutes() / 60 - CAL_START_HOUR;
      const top = Math.max(0, startFrac) * CAL_HOUR_HEIGHT;
      const height = Math.max(20, (endFrac - Math.max(0, startFrac)) * CAL_HOUR_HEIGHT);
      const widthPct = 100 / item.totalLanes;
      const block = el('div', {
        class: 'fr-cal-event',
        style: `top:${top}px; height:${height}px; left:calc(${item.lane * widthPct}% + 3px); width:calc(${widthPct}% - 6px);`,
      });
      // Time is redundant with the block's own vertical position in the
      // grid — drop it and lead with venue instead. Every line clips
      // rather than wrapping: the block's height is the class's duration,
      // so a wrapped line is an overlap with the block below it. The full
      // untruncated text goes on the block's own title attribute.
      const courseName = item.raw.courseName || item.raw.title;
      const prof = item.raw.faculty ? `${item.raw.facultySalutation || ''} ${item.raw.faculty}`.trim() : '';
      block.title = [item.raw.room, courseName, prof].filter(Boolean).join(' · ');
      if (item.raw.room) block.appendChild(el('div', { class: 'fr-cal-event-venue', text: item.raw.room }));
      block.appendChild(el('div', { class: 'fr-cal-event-title', text: courseName }));
      if (prof) block.appendChild(el('div', { class: 'fr-cal-event-meta', text: prof }));
      body.appendChild(block);
    }

    if (isToday) {
      const now = new Date();
      const frac = now.getHours() + now.getMinutes() / 60 - CAL_START_HOUR;
      if (frac >= 0 && frac <= totalHours) {
        body.appendChild(el('div', { class: 'fr-cal-now-line', style: `top:${frac * CAL_HOUR_HEIGHT}px;` }));
      }
    }

    col.append(body);
    return col;
  }

  async function renderCalendar(token) {
    const userId = await resolveUserId();
    if (!cache.events) cache.events = await callAura('StudentPortalCalendarCtrl', 'getAllScheduledEvents', { userId });
    const events = cache.events;
    if (token !== ui.activeToken) return;

    const page = el('div', { class: 'fr-page' });

    const days = calState.mode === 'week'
      ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeekMonday(calState.date), i))
      : [calState.date];

    // Mobile day view swaps the simple prev/next/label nav for the same
    // week-strip date picker Home uses — more useful than a single-day
    // stepper when you're already looking at one specific day.
    const isMobile = window.matchMedia('(max-width: 760px)').matches;
    const useDateStrip = isMobile && calState.mode === 'day';

    const titleText = useDateStrip ? dayLabel(calState.date) : 'Calendar';
    const titleEl = el('h1', { class: 'fr-page-title fr-cal-header-title', text: titleText });

    // events is cached above (see cache.events) and nothing else on this tab
    // needs a network round-trip, so date/mode nav re-renders the tab in
    // place instead of going through switchTab's full-page spinner + refetch.
    const rerender = () => renderCalendar(token);

    let navEl;
    if (useDateStrip) {
      navEl = buildDateStrip({
        weekStart: startOfWeekMonday(calState.date),
        selected: calState.date,
        hasEvents: (day) => events.some((e) => sameDay(new Date(e.startDateTime), day)),
        onSelect: (day) => {
          calState.date = day;
          rerender();
        },
        onPrevWeek: () => {
          calState.date = addDays(calState.date, -7);
          rerender();
        },
        onNextWeek: () => {
          calState.date = addDays(calState.date, 7);
          rerender();
        },
      });
    } else {
      const label = calState.mode === 'week' ? `${shortDate(days[0])} – ${shortDate(days[6])}` : dayLabel(calState.date);
      navEl = buildDayNav({
        label,
        onPrev: () => {
          calState.date = addDays(calState.date, calState.mode === 'week' ? -7 : -1);
          rerender();
        },
        onNext: () => {
          calState.date = addDays(calState.date, calState.mode === 'week' ? 7 : 1);
          rerender();
        },
        onToday: () => {
          calState.date = startOfToday();
          rerender();
        },
      });
    }
    navEl.classList.add('fr-cal-header-nav');

    const viewToggle = el('div', { class: 'fr-view-toggle fr-cal-header-toggle' });
    const dayBtn = el('button', { type: 'button', text: 'Day' });
    const weekBtn = el('button', { type: 'button', text: 'Week' });
    dayBtn.classList.toggle('is-active', calState.mode === 'day');
    weekBtn.classList.toggle('is-active', calState.mode === 'week');
    dayBtn.addEventListener('click', () => {
      calState.mode = 'day';
      rerender();
    });
    weekBtn.addEventListener('click', () => {
      calState.mode = 'week';
      rerender();
    });
    viewToggle.append(dayBtn, weekBtn);

    const header = el('div', { class: 'fr-cal-header' });
    header.append(titleEl, navEl, viewToggle);
    page.appendChild(header);

    const calWrap = el('div', { class: 'fr-cal-wrap' });
    const calScroll = el('div', { class: 'fr-cal-scroll' });
    const gutter = el('div', { class: 'fr-cal-gutter', style: `--fr-hour-h: ${CAL_HOUR_HEIGHT}px;` });
    // Week mode's day columns each carry a 40px .fr-cal-day-header, so the
    // gutter needs a matching blank spacer to keep hours aligned with the
    // grid below it. Day mode has no such header on its column — adding
    // the spacer there instead pushes every hour label down with nothing
    // to align to, which is exactly the "hours don't line up" bug.
    if (calState.mode === 'week') gutter.appendChild(el('div', { class: 'fr-cal-gutter-header' }));
    for (let h = CAL_START_HOUR; h < CAL_END_HOUR; h++) {
      const label12 = new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
      const cls = h === CAL_START_HOUR ? 'fr-cal-hour-label fr-cal-hour-label--first' : 'fr-cal-hour-label';
      gutter.appendChild(el('div', { class: cls }, [el('span', { text: label12 })]));
    }

    // Week mode gets a min-width floor per column so narrow (mobile)
    // viewports scroll the grid horizontally instead of crushing 7 columns
    // down to unreadable widths; day mode has just one column and should
    // still fill the available width naturally. Wide enough that real venue
    // names (e.g. "APJ Abdul Kalam 102") sit on one line instead of wrapping
    // and blowing past the block's fixed height — the view already scrolls
    // horizontally on mobile, so there's no cost to the extra width.
    const daysMinWidth = calState.mode === 'week' ? `min-width: ${days.length * 150}px;` : '';
    const daysWrap = el('div', {
      class: 'fr-cal-days',
      style: `grid-template-columns: repeat(${days.length}, 1fr); --fr-hour-h: ${CAL_HOUR_HEIGHT}px; ${daysMinWidth}`,
    });
    for (const d of days) {
      const isToday = sameDay(d, startOfToday());
      if (calState.mode === 'week') {
        const header = el('div', { class: `fr-cal-day-header${isToday ? ' is-today' : ''}` });
        header.append(
          el('div', { text: d.toLocaleDateString(undefined, { weekday: 'short' }) }),
          el('div', { text: String(d.getDate()) })
        );
        const colWrap = el('div', {});
        colWrap.appendChild(header);
        colWrap.appendChild(buildCalDayColumn(d, events, isToday));
        daysWrap.appendChild(colWrap);
      } else {
        daysWrap.appendChild(buildCalDayColumn(d, events, isToday));
      }
    }

    calScroll.append(gutter, daysWrap);
    calWrap.appendChild(calScroll);
    page.appendChild(calWrap);
    ui.contentEl.replaceChildren(page);
  }

  const gyanState = {
    ready: false,
    loadingReady: null,
    assistantId: null,
    userId: null,
    threadId: null,
    threadContext: null,
    additionalKnowledgeFileIds: null,
    displayName: 'Gyan',
    welcomeMessage: '',
    introductionText: '',
    messages: [], // { role: 'user' | 'assistant', text }
    sending: false,
  };

  async function ensureGyanReady() {
    if (gyanState.ready) return;
    if (gyanState.loadingReady) return gyanState.loadingReady;

    gyanState.loadingReady = (async () => {
      try {
        const userId = await resolveUserId();
        const ctx = await getAssistantContext();
        gyanState.userId = userId;
        gyanState.threadContext = ctx.threadContext;
        gyanState.additionalKnowledgeFileIds = ctx.additionalKnowledgeFileIds || [];

        const assistant = await callAura(
          'AiAssistantWindowController', 'getAssistant',
          { assistantName: 'Gyan', recordId: '' }, true, 'vnai'
        );
        gyanState.assistantId = assistant.assistantId;
        gyanState.displayName = assistant.displayName || assistant.name || 'Gyan';
        gyanState.welcomeMessage = assistant.welcomeMessage || '';
        gyanState.introductionText = assistant.introductionText || '';

        gyanState.threadId = await acquireGyanThread(userId);
        gyanState.ready = true;
      } finally {
        gyanState.loadingReady = null;
      }
    })();

    return gyanState.loadingReady;
  }

  // Busy means "a request this tab owns is actually in flight" — an init
  // that already finished and *failed* is not busy, it is a retry waiting to
  // happen. Keying the disabled state off gyanState.ready instead was what
  // left the tab permanently dead after one failed turn: ready stayed false,
  // so Send and New chat were both disabled and nothing ever re-ran init.
  function gyanBusy() {
    return gyanState.sending || !!gyanState.loadingReady;
  }

  // Root cause, finally confirmed via a HAR of the real "Start chat" click:
  // getUserThread's createIfNotExists flag is misleading — it never
  // actually creates anything, only looks up a thread that already
  // exists (comes back `{}` otherwise, regardless of the flag). Real
  // creation is a wholly separate method, createNewThread, which the
  // stock UI calls only when the lookup comes back empty. Its response is
  // the threadId *string itself*, not an object with a .threadId field
  // (confirmed from the capture: returnValue is literally
  // "thread_0055i00000CwfKqAAJ...", no wrapper). Safe to call whenever a
  // thread is missing — deleteThread (fired for real by "New chat" below)
  // is a real, working delete, and this is the real, working recreate.
  async function acquireGyanThread(userId) {
    const existing = await callAura(
      'AiAssistantWindowController', 'getUserThread',
      { assistantId: gyanState.assistantId, actorId: userId, createIfNotExists: true, refreshToken: 0 },
      true, 'vnai'
    );
    if (existing.threadId) return existing.threadId;

    const newThreadId = await callAura(
      'AiAssistantWindowController', 'createNewThread',
      { assistantId: gyanState.assistantId, assistantName: gyanState.displayName, actorId: userId },
      false, 'vnai'
    );
    if (!newThreadId) throw new Error('Gyan could not create a conversation thread');
    return newThreadId;
  }

  // A transfer_to_* requiredAction's functionArgs carries a userQuery —
  // that becomes the *next* call's top-level message (confirmed against a
  // real capture: "book me a gym slot..." transferred through two
  // sub-assistants this way before any tool actually ran). Plain tool
  // calls (getCurrentDateTime, getResourceAvailability, ...) have no
  // userQuery, so the relay just sends an empty message for those.
  function extractUserQuery(functionArgsJson) {
    try {
      const parsed = JSON.parse(functionArgsJson);
      return typeof parsed.userQuery === 'string' ? parsed.userQuery : null;
    } catch (e) {
      return null;
    }
  }

  async function runGyanTurn(message) {
    const currentTurn = (gyanState.activeTurnId = (gyanState.activeTurnId || 0) + 1);
    await ensureGyanReady();
    if (currentTurn !== gyanState.activeTurnId) throw new Error('Gyan turn aborted');

    try {
      await callAura('AiAssistantWindowController', 'runModeration', { message }, false, 'vnai');
    } catch (e) {
      console.warn('[flame-reskin] gyan moderation check failed, sending anyway', e);
    }
    if (currentTurn !== gyanState.activeTurnId) throw new Error('Gyan turn aborted');

    let runRequest = {
      assistantId: gyanState.assistantId,
      actorId: gyanState.userId,
      threadId: gyanState.threadId,
      message,
      threadContext: gyanState.threadContext,
      additionalKnowledgeFileIds: gyanState.additionalKnowledgeFileIds,
    };

    // Capped so a malformed/looping response can't hang the chat forever.
    for (let step = 0; step < 8; step++) {
      const res = await callAura('AiAssistantWindowController', 'runAssistant', { runRequest }, false, 'vnai');
      if (currentTurn !== gyanState.activeTurnId) throw new Error('Gyan turn aborted');

      if (!res.requiredActions || !res.requiredActions.length) {
        return res.text || "Sorry, I didn't get a response for that.";
      }
      const toolResponses = res.requiredActions.map((a) => ({
        name: a.functionName,
        arguments: a.functionArgs,
        callId: a.toolCallId,
        response: a.functionResponse,
      }));
      const transferQuery = res.requiredActions.map((a) => extractUserQuery(a.functionArgs)).find(Boolean);
      const excludeFunctions = res.requiredActions.map((a) => a.excludeTransferFunction).filter(Boolean);
      const transferredFrom = res.requiredActions.map((a) => a.transferredFromAssistantId).find(Boolean);
      runRequest = {
        assistantId: gyanState.assistantId,
        actorId: gyanState.userId,
        threadId: gyanState.threadId,
        message: transferQuery || '',
        toolResponses,
        threadContext: gyanState.threadContext,
        additionalKnowledgeFileIds: gyanState.additionalKnowledgeFileIds,
        excludeFunctions,
        ...(transferredFrom ? { transferredFromAssistantId: transferredFrom } : {}),
      };
    }
    throw new Error('Gyan did not finish responding (too many tool steps)');
  }

  function getCleanWelcomeTitle() {
    let title = gyanState.welcomeMessage || '';
    if (!title || /start chat/i.test(title)) {
      title = 'Ask Gyan';
    }
    return title;
  }

  function getCleanWelcomeText() {
    let intro = gyanState.introductionText || '';
    if (!intro || /start chat/i.test(intro)) {
      intro = 'Ask about classes, facility bookings, campus info, or anything else Gyan can help with.';
    }
    return intro;
  }

  function getSmartGyanChips() {
    const hour = new Date().getHours();
    const chips = [];

    if (hour >= 0 && hour < 11) {
      chips.push({ text: "What's for breakfast today?", label: "Breakfast today", icon: 'utensils' });
      chips.push({ text: "What's for lunch today?", label: "Lunch today", icon: 'utensils' });
    } else if (hour >= 11 && hour < 16) {
      chips.push({ text: "What's for lunch today?", label: "Lunch today", icon: 'utensils' });
      chips.push({ text: "What's for dinner tonight?", label: "Dinner tonight", icon: 'utensils' });
    } else if (hour >= 16 && hour < 19) {
      chips.push({ text: "What's for snacks today?", label: "Snacks today", icon: 'utensils' });
      chips.push({ text: "What's for dinner tonight?", label: "Dinner tonight", icon: 'utensils' });
    } else {
      chips.push({ text: "What's for dinner tonight?", label: "Dinner tonight", icon: 'utensils' });
      chips.push({ text: "What's for breakfast tomorrow?", label: "Tomorrow's breakfast", icon: 'utensils' });
    }

    chips.push({ text: "What is my next class?", label: "Next class", icon: 'calendar' });
    chips.push({ text: "Are sports slots available today?", label: "Sports slots", icon: 'clock' });

    return chips;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function parseGyanBold(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    // Double asterisks **bold**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$2</strong>');
    // Single asterisk *bold*
    html = html.replace(/(^|\s)\*([^\*\n]+)\*(\s|$)/g, '$1<strong>$2</strong>$3');
    return html;
  }

  async function renderGyan(token) {
    if (token !== ui.activeToken) return;

    const page = el('div', { class: 'fr-page fr-gyan-page' });
    const headerRow = el('div', { class: 'fr-group-heading-row' });
    headerRow.appendChild(el('h1', { class: 'fr-page-title', text: gyanState.displayName, style: 'margin: 0;' }));
    const newChatBtn = el('button', { class: 'fr-link-btn', type: 'button', text: 'New chat' });
    newChatBtn.addEventListener('click', async () => {
      if (gyanBusy()) return;
      newChatBtn.disabled = true;
      gyanState.activeTurnId = (gyanState.activeTurnId || 0) + 1;
      const oldThreadId = gyanState.threadId;
      gyanState.messages = [];
      gyanState.threadId = null;
      gyanState.ready = false;
      paintMessages();
      if (oldThreadId) {
        try {
          await callAura('AiAssistantWindowController', 'deleteThread', { threadId: oldThreadId }, false, 'vnai');
        } catch (e) {
          console.warn('[flame-reskin] failed to delete old gyan thread, continuing anyway', e);
        }
      }
      if (token === ui.activeToken) switchTab('gyan');
    });
    headerRow.appendChild(newChatBtn);
    page.appendChild(headerRow);

    const messagesEl = el('div', { class: 'fr-gyan-messages' });
    const composerForm = el('form', { class: 'fr-gyan-composer' });
    const inputEl = el('input', {
      class: 'fr-input', type: 'text', placeholder: `Ask ${gyanState.displayName}…`, autocomplete: 'off',
    });
    const sendBtn = el('button', { class: 'fr-btn fr-btn--primary', type: 'submit' });
    composerForm.append(inputEl, sendBtn);

    function paintMessages() {
      // Textbox is always interactive (never disabled) so the user can type immediately
      inputEl.disabled = false;

      const isLoading = gyanBusy();
      sendBtn.disabled = isLoading;
      newChatBtn.disabled = isLoading;
      newChatBtn.style.opacity = isLoading ? '0.4' : '1';
      newChatBtn.style.pointerEvents = isLoading ? 'none' : 'auto';
      if (isLoading) {
        sendBtn.classList.add('fr-btn--loading');
        sendBtn.replaceChildren(icon('spinner'));
      } else {
        sendBtn.classList.remove('fr-btn--loading');
        sendBtn.replaceChildren();
        sendBtn.textContent = 'Send';
      }

      if (!gyanState.messages.length && !gyanState.sending) {
        const emptyWrap = el('div', { class: 'fr-gyan-welcome-wrap' });
        const emptyEl = renderEmpty('sparkle', getCleanWelcomeTitle(), getCleanWelcomeText());

        const suggestionsEl = el('div', { class: 'fr-gyan-suggestions' });
        const suggestionsLabel = el('div', { class: 'fr-gyan-suggestions-label', text: 'Suggested questions' });
        const chipsRow = el('div', { class: 'fr-gyan-chips' });

        for (const c of getSmartGyanChips()) {
          const btn = el('button', { class: 'fr-gyan-chip', type: 'button' });
          // A chip submits by dispatching the form event, which does not care
          // that sendBtn is disabled — so the chip has to carry the same
          // disabled state itself, or it fires a turn the composer is refusing.
          btn.disabled = isLoading;
          btn.append(icon(c.icon), document.createTextNode(c.label));
          btn.addEventListener('click', () => {
            if (gyanBusy()) return;
            inputEl.value = c.text;
            composerForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
          });
          chipsRow.appendChild(btn);
        }

        suggestionsEl.append(suggestionsLabel, chipsRow);
        emptyWrap.append(emptyEl, suggestionsEl);
        messagesEl.replaceChildren(emptyWrap);
        return;
      }

      const list = el('div', { class: 'fr-gyan-list' });
      for (const m of gyanState.messages) {
        const row = el('div', { class: `fr-gyan-msg fr-gyan-msg--${m.role}` });
        const bubble = el('div', { class: 'fr-gyan-bubble' });
        if (m.role === 'assistant') {
          bubble.innerHTML = parseGyanBold(m.text);
        } else {
          bubble.textContent = m.text;
        }
        row.appendChild(bubble);
        list.appendChild(row);
      }
      if (gyanState.sending) {
        const row = el('div', { class: 'fr-gyan-msg fr-gyan-msg--assistant' });
        row.appendChild(el('div', { class: 'fr-gyan-bubble fr-gyan-typing', text: `${gyanState.displayName} is thinking…` }));
        list.appendChild(row);
      }
      messagesEl.replaceChildren(list);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    composerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text || gyanState.sending) return;
      inputEl.value = '';
      gyanState.messages.push({ role: 'user', text });
      gyanState.sending = true;

      if (token === ui.activeToken) paintMessages();
      try {
        if (!gyanState.ready) {
          await ensureGyanReady();
        }
        const reply = await runGyanTurn(text);
        gyanState.messages.push({ role: 'assistant', text: reply });
      } catch (err) {
        gyanState.messages.push({ role: 'assistant', text: `Sorry, something went wrong: ${err.message}` });
        gyanState.ready = false;
      } finally {
        gyanState.sending = false;
        if (token === ui.activeToken) paintMessages();
      }
    });

    inputEl.addEventListener('focus', () => {
      setTimeout(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 150);
    });

    // Kicked off *before* the first paint: ensureGyanReady sets loadingReady
    // synchronously, so paintMessages already sees the busy state and the very
    // first frame carries the spinner instead of an enabled Send for one tick.
    if (!gyanState.ready) {
      ensureGyanReady().then(() => {
        if (token === ui.activeToken) paintMessages();
      }).catch((err) => {
        console.warn('[flame-reskin] ensureGyanReady background init failed', err);
        if (token === ui.activeToken) paintMessages();
      });
    }

    paintMessages();
    page.append(messagesEl, composerForm);
    ui.contentEl.replaceChildren(page);

    const isMobile = window.innerWidth <= 760 || 'ontouchstart' in window;
    if (!isMobile) {
      inputEl.focus();
    }
  }

  // ---------------------------------------------------------------------
  // 9. Home tab — today's classes, upcoming-days glance, upcoming bookings
  // ---------------------------------------------------------------------


  const homeState = { weekStart: startOfWeekMonday(startOfToday()), selected: startOfToday() };

  // Home is the boot tab, so it is the one place where the wait is the
  // first thing you see. It paints last launch's data immediately when
  // there is any, then repaints with the real answer — the requests still
  // go out every time, this only decides what is on screen while they fly.
  //
  // Calendar and My Bookings deliberately don't do this: by the time either
  // is opened, Home's own revalidation has already filled the in-memory
  // cache they read, so they are fast for free and a second stale-paint
  // path would be complexity with nothing to buy.
  async function renderHome(token) {
    homeState.weekStart = startOfWeekMonday(startOfToday());
    homeState.selected = startOfToday();

    const stale = (!cache.events || !cache.bookings) ? readPersisted() : null;
    const painted = { events: null, bookings: null };
    if (stale && stale.events && stale.bookings && token === ui.activeToken) {
      painted.events = stale.events;
      painted.bookings = stale.bookings;
      ui.contentEl.replaceChildren(buildHomePage(stale.events, stale.bookings));
    } else if (!cache.events || !cache.bookings) {
      // Nothing known yet — first ever launch, or a cache older than a day.
      // The date strip and the day's own name need no data at all, so they
      // are real from the first frame and only the parts that are actually
      // unknown shimmer.
      if (token === ui.activeToken) ui.contentEl.replaceChildren(buildHomeSkeleton());
    }

    const userId = await resolveUserId();
    const [events, bookings] = await Promise.all([
      cache.events ? Promise.resolve(cache.events) : callAura('StudentPortalCalendarCtrl', 'getAllScheduledEvents', { userId }),
      cache.bookings ? Promise.resolve(cache.bookings) : callAura('CustomBookingController', 'getReservations', { userId }),
    ]);
    cache.events = events;
    cache.bookings = bookings;
    writePersisted({ events, bookings });
    if (token !== ui.activeToken) return;

    // The stale paint is usually right — the timetable is semester-static
    // and bookings change a few times a week — and repainting an identical
    // page still tears down every node and builds it again, which shows up
    // as a jitter a moment after the tab opens. So the answer is compared
    // against what is already on screen and dropped when it matches.
    if (painted.events && sameData(painted.events, events) && sameData(painted.bookings, bookings)) return;

    // homeState is deliberately not reset here: if a day was tapped on the
    // strip while the fetch was in flight, the repaint keeps that choice
    // rather than yanking the view back to today under the finger.
    //
    // The bookings section is the one part of this page whose height the
    // skeleton cannot always predict: it stands one booking tall, which is
    // what most days hold and exactly what "nothing booked" now occupies,
    // but a three-booking day resolves taller. Measure what it occupied
    // before the swap and let it grow into the new height instead of
    // snapping the rest of the page down.
    const wasTall = ui.contentEl.querySelector('.fr-home-bookings');
    const priorHeight = wasTall ? wasTall.offsetHeight : 0;
    ui.contentEl.replaceChildren(buildHomePage(events, bookings));
    const nowTall = ui.contentEl.querySelector('.fr-home-bookings');
    if (nowTall) morphHeight(nowTall, priorHeight);
  }

  // The loading state is the real page with the unknown parts shimmering:
  // same title, same date strip, same headings, same row boxes. Three class
  // rows and one booking row, because that is the shape of a normal day and
  // a skeleton that guesses high leaves a hole when the data lands short.
  function buildHomeSkeleton() {
    const page = el('div', { class: 'fr-page', 'aria-busy': 'true' });
    page.appendChild(el('h1', { class: 'fr-page-title', text: dayLabel(homeState.selected) }));
    page.appendChild(
      buildDateStrip({
        weekStart: homeState.weekStart,
        selected: homeState.selected,
        // Which days carry classes is exactly what is not known yet; the
        // markers appear with the data rather than guessing and correcting.
        hasEvents: () => false,
        onSelect: () => {},
        onPrevWeek: () => {},
        onNextWeek: () => {},
      })
    );

    page.appendChild(el('h2', { class: 'fr-group-heading', text: 'Classes' }));
    const classes = el('div', { class: 'fr-list' });
    for (const width of [22, 17, 26]) {
      classes.appendChild(
        el('div', { class: 'fr-row' }, [
          el('span', { class: 'fr-row-time' }, [skel(5)]),
          el('div', { class: 'fr-row-main' }, [
            el('p', { class: 'fr-row-title' }, [skel(width)]),
            el('p', { class: 'fr-row-meta' }, [skel(14)]),
          ]),
        ])
      );
    }
    page.appendChild(classes);

    const bookings = el('div', { class: 'fr-home-bookings', style: 'margin-top: 32px;' });
    bookings.appendChild(
      el('div', { class: 'fr-group-heading-row' }, [
        // Whether this reads "Today" or "Upcoming" depends on data not in
        // yet, so the label itself shimmers rather than guessing one.
        el('h2', { class: 'fr-group-heading', style: 'margin: 0;' }, [skel(8)]),
      ])
    );
    bookings.appendChild(
      el('div', { class: 'fr-list' }, [
        el('div', { class: 'fr-row' }, [
          el('div', { class: 'fr-row-main' }, [
            el('p', { class: 'fr-row-title' }, [skel(16)]),
            el('p', { class: 'fr-row-meta' }, [skel(24)]),
          ]),
        ]),
      ])
    );
    page.appendChild(bookings);
    return page;
  }

  function buildHomePage(events, bookings) {
    const page = el('div', { class: 'fr-page' });
    const title = el('h1', { class: 'fr-page-title', text: dayLabel(homeState.selected) });
    const stripWrap = el('div', {});
    const classesHeading = el('h2', { class: 'fr-group-heading', text: 'Classes' });
    const classesList = el('div', {});
    page.append(title, stripWrap, classesHeading, classesList);

    // The date strip is repainted on paging (prev/next week); the classes
    // list is repainted on selecting a day — both are pure client-side
    // filters over the already-fetched `events`, no refetch on click.
    function paintStrip() {
      stripWrap.replaceChildren(
        buildDateStrip({
          weekStart: homeState.weekStart,
          selected: homeState.selected,
          hasEvents: (day) => events.some((e) => sameDay(new Date(e.startDateTime), day)),
          onSelect: selectDate,
          onPrevWeek: () => {
            homeState.weekStart = addDays(homeState.weekStart, -7);
            paintStrip();
          },
          onNextWeek: () => {
            homeState.weekStart = addDays(homeState.weekStart, 7);
            paintStrip();
          },
        })
      );
    }

    function paintClasses() {
      title.textContent = dayLabel(homeState.selected);
      const dayEvents = events
        .filter((e) => sameDay(new Date(e.startDateTime), homeState.selected))
        .sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
      if (!dayEvents.length) {
        classesList.replaceChildren(renderEmpty('calendar', 'No classes', 'Nothing scheduled this day.', 'fr-empty--inline'));
        return;
      }
      const list = el('div', { class: 'fr-list' });
      for (const ev of dayEvents) {
        const row = el('div', { class: 'fr-row' });
        row.appendChild(el('span', { class: 'fr-row-time', text: formatTime(new Date(ev.startDateTime)) }));
        const main = el('div', { class: 'fr-row-main' });
        const courseTitle = ev.courseName || ev.title;
        main.appendChild(el('p', { class: 'fr-row-title', text: courseTitle, title: courseTitle }));
        const meta = [ev.room, ev.faculty ? `${ev.facultySalutation || ''} ${ev.faculty}`.trim() : null].filter(Boolean).join(' · ');
        // Appended even when empty: the meta line's height is what keeps
        // every row in the list the same height (see .fr-row-meta:empty).
        main.appendChild(el('p', { class: 'fr-row-meta', text: meta, title: meta }));
        row.appendChild(main);
        list.appendChild(row);
      }
      classesList.replaceChildren(list);
    }

    // Reused by buildDateStrip's cells and the prev/next buttons.
    function selectDate(day) {
      homeState.selected = day;
      paintStrip();
      paintClasses();
    }

    paintStrip();
    paintClasses();

    // One bucket, not two: Today when today has anything still ahead of it,
    // else a single next-upcoming row as a nudge (My Bookings is where you
    // browse further — "See all" already covers "there's more"). Cancelled
    // bookings are dropped outright here, not dimmed — a cancelled slot has
    // nothing to tell a glance view. A daily autobook watch counts too,
    // merged in by its own start time rather than tacked on after real
    // bookings, so whichever is actually sooner is what shows first.
    const now = new Date();
    const today = startOfToday();

    const liveBookings = bookings
      .filter((b) => b.status === 'Booked' && parseBookingDateTime(b.endDateTime) > now)
      .map((b) => ({ kind: 'booking', start: parseBookingDateTime(b.startDateTime), b }));
    const liveIntents = loadIntents()
      .filter((i) => i.state === 'waiting')
      .map((i) => ({ kind: 'intent', start: slotStartDate(i.date, i.startTime), i }))
      // A still-"waiting" intent whose own start already elapsed is stale
      // (runAutoBook fails it out once that happens, but only while the app
      // is actually open to run the loop) — not something to show as "next".
      .filter((x) => x.start && x.start > now);

    const combined = [...liveBookings, ...liveIntents].sort((a, b) => a.start - b.start);
    const todayItems = combined.filter((x) => sameDay(x.start, today));
    const isToday = todayItems.length > 0;
    const displayItems = isToday ? todayItems : combined.slice(0, 1);
    const hasAnyRow = displayItems.length > 0;

    // The section stays whether or not anything is upcoming. It used to be
    // dropped entirely when empty, which left the page looking like it had
    // ended early — and an empty booking list is the one moment where the
    // obvious next move is to make a booking, so it says that and offers it.
    const bookingsSection = el('div', { class: 'fr-home-bookings', style: 'margin-top: 32px;' });
    const headingRow = el('div', { class: 'fr-group-heading-row' });
    headingRow.appendChild(el('h2', { class: 'fr-group-heading', text: isToday ? 'Today' : 'Upcoming', style: 'margin: 0;' }));
    if (hasAnyRow) {
      const seeAll = el('button', { class: 'fr-link-btn', type: 'button', text: 'See all' });
      seeAll.addEventListener('click', () => switchTab('bookings'));
      headingRow.appendChild(seeAll);
    }
    bookingsSection.appendChild(headingRow);
    if (hasAnyRow) {
      const list = el('div', { class: 'fr-list' });
      for (const item of displayItems) {
        if (item.kind === 'intent') {
          list.appendChild(buildPendingBookingBadge(item.i));
          continue;
        }
        const b = item.b;
        list.appendChild(
          el('div', { class: 'fr-row' }, [
            el('div', { class: 'fr-row-main' }, [
              el('p', { class: 'fr-row-title', text: cleanResourceName(b.resourceName), title: cleanResourceName(b.resourceName) }),
              el('p', { class: 'fr-row-meta', text: formatBookingWhen(b), title: formatBookingWhen(b) }),
            ]),
          ])
        );
      }
      bookingsSection.appendChild(list);
    } else {
      // Deliberately not renderEmpty: that one is sized for a whole empty
      // tab and stood three rows tall here, so a day with no bookings
      // dropped the page ~130px below where the skeleton had put it. This
      // is one row exactly — same box as a booking, same two lines — drawn
      // as a hairline outline rather than a filled card so it still cannot
      // be misread as something that was actually booked.
      const book = el('button', { class: 'fr-link-btn', type: 'button', text: 'Book a slot' });
      book.addEventListener('click', () => switchTab('book-slot'));
      bookingsSection.appendChild(
        el('div', { class: 'fr-nothing' }, [
          icon('clock', 'fr-nothing-icon'),
          el('div', { class: 'fr-row-main' }, [
            el('p', { class: 'fr-row-title', text: 'Nothing booked' }),
            el('p', { class: 'fr-row-meta', text: 'Bookings open a day ahead.' }),
          ]),
          book,
        ])
      );
    }
    page.appendChild(bookingsSection);

    return page;
  }

  // Entry point. `npm run build` bundles everything reachable from here into
  // portal-reskin.user.js; edit these modules, never that file.
  //
  // Load order matters in one place only: the hide-CSS goes in before
  // anything else, because @run-at document-start is what lets the stock
  // Siteforce chrome be hidden before it ever paints.


  registerRenderers({
    home: renderHome,
    calendar: renderCalendar,
    bookings: renderMyBookings,
    'book-slot': renderBookSlot,
    gyan: renderGyan,
  });

  // The reskin's hide-CSS is domain-wide (@match covers the whole site), so
  // without this check it would also blank the login page before auth
  // completes — including the "Sign in with Google" button/flow. Bail out
  // entirely on anything that looks like a login page and let the stock UI
  // render untouched. The path fragments are a best guess (unconfirmed — the
  // HAR only covers post-login traffic, see HANDOFF.md); the DOM checks are
  // the backstop in case that guess is wrong.
  function isLoginPage() {
    const path = location.pathname.toLowerCase();
    if (path.includes('/login') || path.includes('/identity') || path.includes('/idp')) return true;
    if (document.querySelector('input[type="password"]')) return true;
    if (document.querySelector('a[href*="accounts.google.com"], [class*="google-login" i], [id*="google-login" i]')) return true;
    return false;
  }

  function boot() {
    if (isLoginPage()) {
      console.log('[flame-reskin] login page detected — leaving stock UI untouched');
      return;
    }
    injectHideStyle();
    injectComponentStyles();
    buildToggleButton();
    keepHiding();
    buildShell();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
