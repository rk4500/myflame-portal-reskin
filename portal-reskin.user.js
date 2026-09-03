// ==UserScript==
// @name         FLAME Portal Reskin
// @namespace    kaanav.gathani
// @match        https://my.flame.edu.in/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

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

  function harvestFromBody(bodyStr) {
    if (!bodyStr || bodyStr.indexOf('aura.context') === -1) return;
    try {
      const params = new URLSearchParams(bodyStr);
      const ctx = params.get('aura.context');
      const tok = params.get('aura.token');
      if (ctx) auraState.context = ctx;
      if (tok) auraState.token = tok;

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
    // Preview/dev hook: when a static preview page defines this global,
    // short-circuit the network entirely and resolve canned data. Never
    // set on the real portal, so this is inert in production.
    if (window.__FLAME_RESKIN_PREVIEW__) {
      const key = `${classname}.${method}`;
      const stub = window.__FLAME_RESKIN_PREVIEW__[key];
      if (stub === undefined) throw new Error(`no preview stub for ${key}`);
      await new Promise((r) => setTimeout(r, 80));
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
    if (JSON.stringify(action).indexOf('INVALID_TOKEN') !== -1) {
      auraState.token = null;
    }
    throw new Error(`aura call failed (${classname}.${method}): ${JSON.stringify(action.error || action)}`);
  }

  // ---------------------------------------------------------------------
  // 3. Hide original Siteforce chrome, keep it hidden across SPA nav —
  //    except when the user has toggled back to the stock UI (section 5).
  // ---------------------------------------------------------------------

  // The page is a pure Aura SPA shell (confirmed against the HAR: initial
  // HTML is just <body class="null loading"> plus a spinner, no app markup
  // — Aura renders everything client-side as children of <body>). So rather
  // than guess at component class names that only exist post-render, hide
  // by structural position: every direct child of <body> except our own
  // root and the stock-UI toggle button. CSS re-applies automatically to
  // nodes Aura inserts later, no JS needed for that part.
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
      if (!document.getElementById('flame-reskin-root') && root) document.body.appendChild(root);
      if (!document.getElementById('flame-reskin-toggle') && toggleBtn) document.body.appendChild(toggleBtn);
    });
    observer.observe(document.body, { childList: true });
  }

  // ---------------------------------------------------------------------
  // 4. Visual design system
  // ---------------------------------------------------------------------

  const STYLE_CSS = `
#flame-reskin-root, #flame-reskin-root * { box-sizing: border-box; }
/* An author rule setting display: (e.g. .fr-confirm-panel { display: flex }) beats
   the UA [hidden]{display:none} rule at equal specificity — restore it explicitly,
   otherwise setting .hidden = true silently does nothing on any styled element. */
#flame-reskin-root [hidden] { display: none !important; }

#flame-reskin-root {
  /* Default via CSS env() for browsers/PWAs that populate it (0 elsewhere,
     e.g. desktop). The Android app's native hook overrides this at runtime
     with a precisely-measured value, since this WebView doesn't reliably
     populate env(safe-area-inset-bottom) on its own. */
  --flame-navbar-inset: env(safe-area-inset-bottom, 0px);
  --bg: #11131a;
  --bg-elevated: #1a1e28;
  --bg-elevated-2: #232838;
  --border: #2b3040;
  --text: #eef0f6;
  --text-secondary: #96a0b8;
  --accent: #5b8cff;
  --accent-hover: #71a0ff;
  --accent-text: #0d1220;
  --danger: #e0836f;
  --danger-bg: #3a241f;
  --success: #7fc98a;
  --success-bg: #1c2f22;

  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  color-scheme: dark;
}

#flame-reskin-root a { color: var(--accent); }
#flame-reskin-root ::selection { background: var(--accent); color: var(--accent-text); }
#flame-reskin-root *:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

#flame-reskin-root ::-webkit-scrollbar { width: 10px; height: 10px; }
#flame-reskin-root ::-webkit-scrollbar-track { background: transparent; }
#flame-reskin-root ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }
#flame-reskin-root ::-webkit-scrollbar-thumb:hover { background: var(--bg-elevated-2); }
#flame-reskin-root * { scrollbar-color: var(--border) transparent; scrollbar-width: thin; }

/* Top bar on desktop (mobile repositions this same markup into a bottom
   tab bar — see the media query). A vertical sidebar with a colored-square
   "FL" mark stacked over a name in the top-left corner is, structurally,
   the exact shape of every app's account switcher; the same mark inline in
   a horizontal bar just reads as a logo. */
.fr-nav {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  padding: 0 48px; /* matches .fr-content's left/right padding, so the bar's edges line up with the page content below it */
  height: 60px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.fr-brand { display: flex; align-items: center; gap: 8px; padding-right: 20px; margin-right: 4px; border-right: 1px solid var(--border); }
.fr-brand-mark { color: var(--accent); width: 22px; height: 22px; }
.fr-brand-name { font-weight: 700; font-size: 14px; letter-spacing: 0.02em; }
.fr-nav-list { display: flex; align-items: center; gap: 4px; }
.fr-nav-btn {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 8px;
  background: transparent; border: none;
  color: var(--text-secondary); font: inherit; font-weight: 500; font-size: 0.875rem;
  cursor: pointer; text-align: left;
  transition: background-color 120ms ease, color 120ms ease;
}
.fr-nav-btn:hover { background: var(--bg-elevated); color: var(--text); }
.fr-nav-btn.is-active { background: var(--bg-elevated-2); color: var(--text); }
.fr-nav-btn.is-active .icon { color: var(--accent); }
/* Mobile-only long-press-to-switch-to-stock feedback on the Home tab (see
   attachHomeLongPress()) — a slow fill exactly matching the hold duration,
   so releasing early visibly "un-fills" instead of just snapping off.
   Harmless if ever triggered on desktop by a mouse-down; nothing reads it. */
.fr-nav-btn.is-pressing { background: var(--bg-elevated-2); transition: background-color 550ms ease; }
/* The one action in the bar that isn't navigation — pushed to the far
   opposite end from the brand mark so it reads as a utility, not a tab.
   Desktop only; mobile switches via a Home long-press instead (no room
   for a 6th icon in the bottom tab bar). */
.fr-nav-toggle {
  margin-left: auto; flex-shrink: 0;
  background: transparent; border: 1px solid var(--border); border-radius: 8px;
  color: var(--text-secondary); font: inherit; font-weight: 500; font-size: 0.8125rem;
  padding: 7px 12px; cursor: pointer; transition: border-color 120ms ease, color 120ms ease;
}
.fr-nav-toggle:hover { color: var(--text); border-color: var(--text-secondary); }

.fr-content { flex: 1; overflow-y: auto; padding: 40px 48px 80px; display: flex; justify-content: center; align-items: flex-start; }
.fr-page { max-width: 1320px; width: 100%; animation: fr-fade-in 180ms ease-out; }
@keyframes fr-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.fr-page-title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 24px; }

.icon { width: 20px; height: 20px; display: inline-flex; flex-shrink: 0; }
.icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }

.fr-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 96px 0; color: var(--text-secondary); }
.fr-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: fr-spin 700ms linear infinite; }
@keyframes fr-spin { to { transform: rotate(360deg); } }

.fr-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 64px 24px; color: var(--text-secondary); }
.fr-empty-icon { width: 32px; height: 32px; color: var(--text-secondary); opacity: 0.6; margin-bottom: 4px; }
.fr-empty-title { font-weight: 600; color: var(--text); margin: 0; }
.fr-empty-text { margin: 0; font-size: 0.875rem; }
.fr-empty--error { color: var(--danger); }
.fr-empty--error .fr-empty-title { color: var(--danger); }
.fr-empty--inline { padding: 32px 16px; }

.fr-day-group { margin-bottom: 32px; }
.fr-group-heading {
  font-size: 0.8125rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--text-secondary); margin: 0 0 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fr-group-heading-row { display: flex; align-items: baseline; justify-content: space-between; margin: 0 0 12px; }
.fr-link-btn {
  font: inherit; font-size: 0.8125rem; font-weight: 600; color: var(--accent);
  background: none; border: none; padding: 0; cursor: pointer;
}

.fr-list { display: flex; flex-direction: column; gap: 8px; }
.fr-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  background: var(--bg-elevated); border-radius: 12px; padding: 14px 16px;
}
/* Every row in a list has to be the same height. A long class title, or a
   "Wednesday, Sep 10 - 10:00 AM - 11:00 AM" meta line, used to wrap onto a
   second line and grow its own box, which reads as "this class runs
   longer" when it only means "this name is longer". Both lines are single
   line + ellipsis now, and .fr-row-main shrinks (min-width:0) rather than
   shoving the pill/button off the edge. */
.fr-row-main { flex: 1; min-width: 0; }
.fr-row-title { margin: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fr-row-meta {
  margin: 4px 0 0; font-size: 0.8125rem; color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* A class row with no room/faculty still has to reserve the meta line's
   height, or it sits shorter than its neighbours. */
.fr-row-meta:empty::before { content: '\\00a0'; } /* escaped twice: STYLE_CSS is a template literal, and a bare \0 + digit is an illegal octal escape there */
.fr-row-time { font-weight: 600; font-variant-numeric: tabular-nums; flex-shrink: 0; min-width: 78px; white-space: nowrap; }
/* Status pill + cancel button share one right-hand column, so mobile can
   collapse them together. */
.fr-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.fr-badge { flex-shrink: 0; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
.fr-badge.is-booked { background: var(--success-bg); color: var(--success); }
.fr-badge.is-cancelled { background: var(--bg-elevated-2); color: var(--text-secondary); }

.fr-cancel-wrap { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Cancel confirmation. Three earlier attempts all failed the same way —
   they added something to the row (a question string, an overlay, a drawer)
   and then had to find room for it. This one adds nothing: the row's own
   title becomes the question ("Gym" -> "Cancel Gym?"), so the object being
   cancelled is named exactly once, in the place already reading as its
   name, and the only new pixels are one extra button. Nothing expands,
   nothing is covered, every row in the list keeps the same height. */
.fr-row.is-confirming {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-elevated));
}
.fr-row.is-confirming .fr-row-title { color: var(--danger); }
.fr-row, .fr-row-title { transition: background-color 140ms ease, color 140ms ease; }

.fr-btn {
  font: inherit; font-weight: 600; border-radius: 9px; padding: 9px 16px;
  border: 1px solid transparent; cursor: pointer; white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.fr-btn:disabled { opacity: 0.5; cursor: default; }
.fr-btn--primary { background: var(--accent); color: var(--accent-text); }
.fr-btn--primary:hover:not(:disabled) { background: var(--accent-hover); }
.fr-btn--secondary { background: var(--bg-elevated-2); color: var(--text); }
.fr-btn--secondary:hover:not(:disabled) { background: #2b3143; }
.fr-btn--ghost { background: transparent; color: var(--text-secondary); border-color: var(--border); }
.fr-btn--ghost:hover:not(:disabled) { color: var(--text); border-color: var(--text-secondary); }
.fr-btn--danger { background: var(--danger); color: #241512; }
.fr-btn--sm { padding: 6px 12px; font-size: 0.8125rem; }
.fr-btn--icon { padding: 8px; line-height: 0; }

.fr-input, .fr-select {
  font: inherit; color: var(--text); background: var(--bg-elevated);
  border: 1px solid var(--border); border-radius: 9px; padding: 9px 12px; width: 100%;
}
.fr-input:focus, .fr-select:focus { border-color: var(--accent); }
/* No rule here previously meant placeholders fell back to the browser's
   default (near-black) placeholder color on this dark input background —
   effectively invisible. */
.fr-input::placeholder { color: var(--text-secondary); opacity: 1; }

/* Custom picker — replaces a native <select> (the Resource dropdown),
   which renders as the platform's own picker UI (a full-screen wheel on
   Android WebView) with none of the reskin's styling. */
.fr-picker { position: relative; }
.fr-picker-btn {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font: inherit; color: var(--text); background: var(--bg-elevated);
  border: 1px solid var(--border); border-radius: 9px; padding: 9px 12px;
  cursor: pointer; text-align: left; transition: border-color 120ms ease;
}
.fr-picker-btn:hover { border-color: var(--text-secondary); }
.fr-picker.is-open .fr-picker-btn { border-color: var(--accent); }
.fr-picker-btn-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fr-picker-btn .icon { flex-shrink: 0; width: 16px; height: 16px; color: var(--text-secondary); transition: transform 120ms ease; }
.fr-picker.is-open .fr-picker-btn .icon { transform: rotate(180deg); }
/* Split into an outer frame (owns the border/radius/shadow, clips via
   overflow:hidden) and an inner scroll list (owns overflow-y:auto) rather
   than putting both the radius and the scrolling on one element — a
   scrolling element's own border-radius isn't reliably clipped against its
   scrollbar on every renderer (confirmed broken on Android WebView: the
   right corners squared off under the native scrollbar track, invisible
   in desktop testing since desktop's custom-styled scrollbar doesn't
   expose the same gap). overflow:hidden on a non-scrolling ancestor clips
   unconditionally regardless of how the descendant's own scrollbar renders. */
.fr-picker-panel {
  position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 20;
  background: var(--bg-elevated-2); border: 1px solid var(--border); border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 12px 28px rgba(0,0,0,0.5);
  display: none;
}
.fr-picker.is-open .fr-picker-panel { display: block; }
.fr-picker-list { padding: 4px; max-height: 280px; overflow-y: auto; }
.fr-picker-option {
  display: block; width: 100%; text-align: left; font: inherit; color: var(--text); font-size: 0.9375rem;
  background: transparent; border: none; border-radius: 7px; padding: 9px 10px;
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fr-picker-option:hover { background: var(--bg-elevated); }
.fr-picker-option.is-selected { color: var(--accent); font-weight: 600; }

/* Day navigator (Calendar + Book Slot share this) */
.fr-daynav { display: flex; align-items: center; gap: 6px; }
.fr-daynav-label { font-weight: 600; font-size: 0.9375rem; flex: 1; text-align: center; white-space: nowrap; }
.fr-daynav-btn {
  display: flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0;
  background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text);
  cursor: pointer;
}
.fr-daynav-btn:hover:not(:disabled) { background: var(--bg-elevated-2); }
.fr-daynav-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* Calendar grid */
.fr-cal-header {
  display: grid; grid-template-columns: 1fr auto; grid-template-areas: "title title" "nav toggle";
  align-items: center; gap: 12px 16px; margin-bottom: 20px;
}
.fr-cal-header-title { grid-area: title; margin: 0; }
.fr-cal-header-nav { grid-area: nav; min-width: 0; }
.fr-cal-header-nav .fr-datestrip { margin: 0; }
.fr-cal-header-toggle { grid-area: toggle; }
.fr-view-toggle { display: flex; background: var(--bg-elevated); border-radius: 9px; padding: 3px; gap: 2px; flex-shrink: 0; }
.fr-view-toggle button {
  padding: 6px 14px; border-radius: 7px; background: transparent; border: none;
  color: var(--text-secondary); font: inherit; font-weight: 600; font-size: 0.8125rem; cursor: pointer;
}
.fr-view-toggle button.is-active { background: var(--bg-elevated-2); color: var(--text); }

/* Same split as .fr-picker-panel: the frame owns the border/radius and
   clips unconditionally via overflow:hidden; the scroll happens on a
   separate inner element instead of on the radius-bearing one itself
   (unreliable on Android WebView — right corners squared off under the
   scrollbar, invisible in desktop testing). */
.fr-cal-wrap { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.fr-cal-scroll { display: flex; overflow-x: auto; }
.fr-cal-gutter { width: 52px; flex-shrink: 0; border-right: 1px solid var(--border); }
.fr-cal-gutter-header { height: 40px; border-bottom: 1px solid var(--border); }
.fr-cal-hour-label {
  height: var(--fr-hour-h); font-size: 0.6875rem; color: var(--text-secondary);
  text-align: right; padding-right: 8px; position: relative;
}
/* Straddles the gridline above it (like most calendar apps: the label
   marks the line, not the row) — except the very first label, which has
   no row above it to straddle into and would otherwise overlap the
   day-header instead. overflow:hidden here (not on every label) clips
   only that one case without cutting off every other label's top half. */
.fr-cal-hour-label span { position: absolute; top: -7px; right: 8px; }
.fr-cal-hour-label--first { overflow: hidden; }
.fr-cal-hour-label--first span { top: 1px; }
.fr-cal-days { flex: 1; display: grid; }
.fr-cal-day-col { position: relative; border-right: 1px solid var(--border); }
.fr-cal-day-col:last-child { border-right: none; }
.fr-cal-day-header {
  height: 40px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  border-bottom: 1px solid var(--border); font-size: 0.75rem; font-weight: 600; color: var(--text-secondary);
  white-space: nowrap;
}
.fr-cal-day-header.is-today { color: var(--accent); }
.fr-cal-hour-row { height: var(--fr-hour-h); border-bottom: 1px solid var(--border); }
.fr-cal-body { position: relative; }
.fr-cal-now-line { position: absolute; left: 0; right: 0; height: 2px; background: var(--accent); z-index: 2; }
.fr-cal-now-line::before {
  content: ''; position: absolute; left: -4px; top: -3px; width: 8px; height: 8px;
  border-radius: 50%; background: var(--accent);
}
.fr-cal-event {
  position: absolute; left: 3px; right: 3px; border-radius: 7px; padding: 4px 8px;
  background: color-mix(in srgb, var(--accent) 20%, var(--bg-elevated));
  font-size: 0.75rem; line-height: 1.3; cursor: default;
  overflow: hidden;
}
/* The venue used to be the one line allowed to wrap, on the theory that a
   long room name should grow the block rather than lose characters. It
   grows it into the block below: a calendar block's height is its
   duration, so any extra line is an overlap, and "Chandragupta - Focus
   Room 201 W" is a real room name. Every line in the block is bounded now
   (venue and professor to one line, the course title to two), and the
   block itself clips — the full text is on the block's title attribute. */
.fr-cal-event-venue {
  font-weight: 600; color: var(--accent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fr-cal-event-title {
  font-weight: 600; margin-top: 1px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.fr-cal-event-meta {
  color: var(--text-secondary); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Home dashboard — week-strip date picker above the classes list */
.fr-datestrip { display: flex; align-items: center; gap: 8px; margin: 4px 0 28px; }
.fr-datestrip-cells { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.fr-datestrip-cell {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 10px 4px; border-radius: 10px; background: var(--bg-elevated);
  border: 1px solid transparent; color: var(--text-secondary); font: inherit; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.fr-datestrip-cell:hover { background: var(--bg-elevated-2); }
.fr-datestrip-cell.is-today {
  background: color-mix(in srgb, var(--accent) 20%, var(--bg-elevated));
  border-color: var(--accent); color: var(--text);
}
.fr-datestrip-cell.is-today .fr-datestrip-daynum { color: var(--accent); }
.fr-datestrip-cell.is-selected { background: var(--accent); color: var(--accent-text); border-color: transparent; }
.fr-datestrip-cell.is-selected .fr-datestrip-daynum { color: inherit; }
.fr-datestrip-weekday { font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.8; white-space: nowrap; }
.fr-datestrip-daynum { font-size: 1.0625rem; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fr-datestrip-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.fr-datestrip-dot.is-empty { visibility: hidden; }

/* Facility rail + slot layout (Book Slot) */
/* minmax(0, ...) on both tracks, not plain 1fr: a grid track's default
   minimum is min-content, so a single unbreakable child — a facility name
   that no longer wraps — widens its column past the viewport and takes the
   whole page sideways with it. Caught by ?auto=wrapcheck's overflow half. */
.fr-book-layout { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 32px; align-items: start; }
.fr-facility-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
.fr-facility-item {
  display: block; width: 100%; text-align: left; font: inherit; font-weight: 500;
  padding: 10px 12px; border-radius: 9px; background: transparent; border: none;
  color: var(--text-secondary); cursor: pointer; transition: background-color 120ms ease, color 120ms ease;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fr-facility-item:hover { background: var(--bg-elevated); color: var(--text); }
.fr-facility-item.is-active { background: var(--accent); color: var(--accent-text); }
.fr-book-field { margin-bottom: 16px; }
.fr-book-field-label { display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fr-book-results-title { font-weight: 600; margin: 0 0 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.fr-slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
.fr-slot {
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; cursor: pointer; text-align: left; font: inherit; color: var(--text);
  transition: border-color 120ms ease, background-color 120ms ease;
}
.fr-slot:hover:not(:disabled) { border-color: var(--text-secondary); }
.fr-slot.is-selected { border-color: var(--accent); background: var(--bg-elevated-2); }
.fr-slot:disabled { opacity: 0.4; cursor: not-allowed; }
.fr-slot-time { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; max-width: 100%; overflow: hidden; }
.fr-slot-cap { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }

/* A slot the portal hasn't opened yet: real, dated, and schedulable, but
   not bookable now — dashed to say "not yet" without inventing a colour. */
.fr-slot--later { border-style: dashed; color: var(--text-secondary); }
.fr-slot--later .fr-slot-time { color: var(--text); }
.fr-slot--later:hover { border-color: var(--text-secondary); }
.fr-slot--later.is-scheduled { border-style: solid; border-color: var(--accent); }
.fr-slot--later.is-scheduled .fr-slot-cap { color: var(--accent); }

.fr-sched { margin-top: 28px; }
.fr-sched-title {
  font-size: 0.8125rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--text-secondary); margin: 0 0 12px;
}
.fr-sched-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 0; border-top: 1px solid var(--border);
}
.fr-sched-main { min-width: 0; }
.fr-sched-name, .fr-sched-note { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fr-sched-name { margin: 0; font-weight: 600; font-size: 0.875rem; }
.fr-sched-note { margin: 2px 0 0; font-size: 0.8125rem; color: var(--text-secondary); }

/* Auto-booking results land while you are somewhere else in the app, so
   they are announced above whatever tab is open rather than buried in the
   one that caused them. */
.fr-banner-host { padding: 12px 48px 0; }
.fr-banner-host:empty { display: none; }
.fr-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 8px;
}
.fr-banner.is-good { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); background: var(--success-bg); }
.fr-banner.is-bad { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); background: var(--danger-bg); }
.fr-banner-main { min-width: 0; }
.fr-banner-title {
  margin: 0; font-weight: 600; font-size: 0.875rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fr-banner.is-good .fr-banner-title { color: var(--success); }
.fr-banner.is-bad .fr-banner-title { color: var(--danger); }
/* Deliberately the one line here that still wraps: it carries the
   portal's own refusal text verbatim, and a truncated reason is worse
   than a two-line banner. The banner is a single full-width element with
   nothing beside it to knock out of alignment. */
.fr-banner-note { margin: 2px 0 0; font-size: 0.8125rem; color: var(--text-secondary); }

.fr-confirm-panel {
  margin-top: 24px; padding: 20px; background: var(--bg-elevated); border-radius: 14px;
  display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end;
}
.fr-confirm-panel-title { grid-column: 1 / -1; font-weight: 600; margin: 0 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fr-success-panel { background: var(--success-bg); color: var(--success); border-radius: 10px; padding: 14px 16px; font-weight: 500; margin-top: 24px; }
/* createReservation returns state:SUCCESS with a plain message string even
   when the booking was refused (e.g. "More than 1 bookings are not allowed
   for selected resource.") — the try/catch never fires for that case, so
   this panel exists to show refusals as refusals instead of green success. */
.fr-error-panel { background: var(--danger-bg); color: var(--danger); border-radius: 10px; padding: 14px 16px; font-weight: 500; margin-top: 24px; }
.fr-error-text { color: var(--danger); }

/* Gyan chat tab */
.fr-gyan-page { display: flex; flex-direction: column; height: 100%; min-height: 0; max-width: 720px; }
.fr-gyan-messages { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; }
/* A short exchange used to sit flush against the header, leaving a dead
   gap down to the composer — the opposite of every chat convention, where
   the live edge of the conversation stays anchored next to the input. The
   auto margin hugs the list to the bottom when it's shorter than the
   viewport and steps out of the way once real content overflows, so
   scrolling still works normally for a long conversation. The empty/
   welcome state is a different kind of content (an explanation, not a
   conversation) and gets centered instead, not bottom-anchored. */
.fr-gyan-list { display: flex; flex-direction: column; gap: 12px; margin-top: auto; }
.fr-gyan-messages > .fr-empty { margin: auto 0; }
.fr-gyan-msg { display: flex; }
.fr-gyan-msg--user { justify-content: flex-end; }
.fr-gyan-msg--assistant { justify-content: flex-start; }
.fr-gyan-bubble {
  max-width: 75%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap;
  word-break: break-word; line-height: 1.45;
}
.fr-gyan-msg--user .fr-gyan-bubble { background: var(--accent); color: var(--accent-text); }
.fr-gyan-msg--assistant .fr-gyan-bubble { background: var(--bg-elevated); color: var(--text); }
.fr-gyan-typing { color: var(--text-secondary); font-style: italic; }
.fr-gyan-composer { display: flex; gap: 10px; margin-top: 16px; flex-shrink: 0; }
.fr-gyan-composer .fr-input { flex: 1; }

/* The off-state fallback: only ever visible while the reskin itself is
   off, at which point #flame-reskin-root (and every in-shell control) is
   hidden entirely — nothing of ours is ever on screen at the same time, so
   this one genuinely can't collide with anything regardless of viewport or
   which tab was last open. Hidden by default; body.flame-reskin-off is the
   only thing that ever shows it. */
#flame-reskin-toggle {
  display: none;
}
body.flame-reskin-off #flame-reskin-toggle {
  display: block;
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
  background: #1a1e28; color: #eef0f6; border: 1px solid #2b3040;
  border-radius: 999px; padding: 8px 16px; font: 600 12px ui-sans-serif, -apple-system, sans-serif;
  cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.45);
}
#flame-reskin-toggle:hover { background: #232838; }

@media (max-width: 760px) {
  .fr-nav {
    position: fixed; left: 0; right: 0; bottom: 0; top: auto;
    width: auto; height: 68px;
    border-right: none; border-top: 1px solid var(--border); border-bottom: none;
    padding: 8px 8px calc(8px + var(--flame-navbar-inset)); background: var(--bg); align-items: center; z-index: 5;
    height: calc(68px + var(--flame-navbar-inset));
  }
  .fr-brand, .fr-nav > .fr-nav-toggle { display: none; }
  .fr-nav-list { flex: 1; justify-content: space-around; }
  .fr-nav-btn { flex-direction: column; gap: 4px; padding: 6px 10px; }
  .fr-nav-label { font-size: 0.6875rem; }
  .fr-content { padding: 12px 20px calc(96px + var(--flame-navbar-inset)); }
  .fr-banner-host { padding: 12px 20px 0; }
  .fr-book-layout { grid-template-columns: minmax(0, 1fr); }
  .fr-datestrip { gap: 4px; }
  .fr-datestrip-cells { gap: 4px; }
  .fr-datestrip-cell { padding: 8px 0; }
  .fr-datestrip-weekday { font-size: 0.625rem; }
  .fr-datestrip-daynum { font-size: 0.9375rem; }
  .fr-daynav-btn { width: 28px; height: 28px; }
  /* .fr-row's justify-content:space-between shoves fr-row-main to the far
     right edge on class-schedule rows (only 2 children: time + main) —
     reads fine on a wide desktop row but leaves an ugly gap on mobile's
     narrower rows. Scoped to rows with a .fr-row-time child specifically
     (only class-schedule rows have one) so booking rows — which rely on
     space-between to push their status pill/cancel button to the right —
     are untouched. */
  .fr-row:has(.fr-row-time) { justify-content: flex-start; }
  /* Day/week toggle moves up next to the title; the day-nav/date-strip
     gets its own full-width row below (same grid, different areas). */
  .fr-cal-header { grid-template-areas: "title toggle" "nav nav"; }
  /* Wider floor than the old 130px: "11 AM - 12 PM" has to fit on one
     line, or the trailing meridiem wraps and that one tile grows taller
     than the rest of the grid. Two columns still fit a 360px viewport. */
  .fr-slot-grid { grid-template-columns: repeat(auto-fill, minmax(146px, 1fr)); }
  .fr-slot { padding: 11px 12px; }
  .fr-slot-time { font-size: 0.9375rem; }
  .fr-row { gap: 10px; padding: 12px 14px; }
  /* A narrow row can't afford both a status pill and a Cancel button, and
     doesn't need both: the button only ever renders on a booked
     reservation, so the pill next to it is restating the obvious. Dropping
     it buys the title/time line ~70px, which is the difference between
     "Tomorrow - 9 AM - 10 AM" fitting on one line and wrapping. */
  .fr-row-actions:has(.fr-cancel-wrap) .fr-badge { display: none; }
  /* Both answers stay short enough that the row's time line survives at
     360px; see attachCancelConfirm for why the safe one sits on the right. */
  .fr-cancel-wrap { gap: 6px; }
  /* Week view: .fr-cal-scroll (always overflow-x:auto) lets the grid
     scroll horizontally at a readable column width instead of squeezing 7
     days into the viewport — the JS gives .fr-cal-days a min-width in
     week mode to force this. */
  .fr-cal-gutter { position: sticky; left: 0; z-index: 1; background: var(--bg); }
  .fr-confirm-panel { grid-template-columns: 1fr; }
}
`;

  function injectComponentStyles() {
    if (document.getElementById('flame-reskin-styles')) return;
    const style = document.createElement('style');
    style.id = 'flame-reskin-styles';
    style.textContent = STYLE_CSS;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // 5. Stock-UI toggle
  // ---------------------------------------------------------------------

  let toggleBtn; // module-scope so keepHiding() can re-append it if Aura wipes <body>

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

  // Mobile has no spare chrome for a Stock-UI control: the bottom tab bar
  // is full, and every fixed/floating overlay tried so far ended up
  // sitting on top of some tab's own content sooner or later. A long-press
  // on the Home tab needs none — it's the one tab guaranteed present in
  // every layout, and long-press-for-a-secondary-action is an established
  // mobile convention (app icons, list rows) rather than an invented one.
  // Only fires below the mobile breakpoint; on desktop this is a no-op and
  // the explicit top-bar button (above) is the real control.
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
        setReskinOff(true);
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
    // after a long-press release (harmless once off — root is hidden
    // either way — but pointless work and a visible flash to the Home tab
    // in the instant before it disappears).
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

    toggleBtn = el('button', {
      id: 'flame-reskin-toggle', type: 'button', text: 'Custom UI', title: 'Switch back to the reskinned portal',
    });
    toggleBtn.addEventListener('click', () => setReskinOff(false));
    document.body.appendChild(toggleBtn);
  }

  // ---------------------------------------------------------------------
  // 6. Icons (authored inline SVG, not emoji/unicode)
  // ---------------------------------------------------------------------

  const ICONS = {
    home: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/></svg>',
    calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
    bookings: '<svg viewBox="0 0 24 24"><path d="M6 4h12v16l-6-4-6 4V4z"/></svg>',
    book: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 3h6"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M12 3c-.8 2.6-3.2 3.7-3.2 6.8a3.2 3.2 0 0 0 6.4 0c0-1-.6-1.6-.9-2.4 1.4.9 2.7 2.6 2.7 4.7a5 5 0 0 1-10 0C7 8.3 9.6 5.6 12 3z"/></svg>',
  };

  function icon(name, extraClass) {
    const span = document.createElement('span');
    span.className = extraClass ? `icon ${extraClass}` : 'icon';
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  // ---------------------------------------------------------------------
  // 7. DOM + date helpers
  // ---------------------------------------------------------------------

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) node.appendChild(child);
    return node;
  }

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

  function formatTimeRange(startISO, endISO) {
    const fmt = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${fmt(new Date(startISO))} – ${fmt(new Date(endISO))}`;
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

  // ---------------------------------------------------------------------
  // 8. Shell + tab switching
  // ---------------------------------------------------------------------

  const TABS = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { id: 'bookings', label: 'My Bookings', icon: 'bookings' },
    { id: 'book-slot', label: 'Book Slot', icon: 'book' },
    { id: 'gyan', label: 'Gyan', icon: 'sparkle' },
  ];

  let root, contentEl;
  let bookingsCache = null;
  let eventsCache = null; // class schedule doesn't change mid-session — fetch once, nav re-renders locally
  const calState = { date: startOfToday(), mode: 'day' };

  function renderLoading() {
    contentEl.replaceChildren(el('div', { class: 'fr-loading' }, [el('div', { class: 'fr-spinner' }), el('span', { text: 'Loading…' })]));
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
    contentEl.replaceChildren(box);
  }

  function renderEmpty(iconName, title, text, extraClass) {
    const box = el('div', { class: extraClass ? `fr-empty ${extraClass}` : 'fr-empty' });
    box.appendChild(icon(iconName, 'fr-empty-icon'));
    box.appendChild(el('p', { class: 'fr-empty-title', text: title }));
    if (text) box.appendChild(el('p', { class: 'fr-empty-text', text }));
    return box;
  }

  const RENDERERS = {
    home: renderHome,
    calendar: renderCalendar,
    bookings: renderMyBookings,
    'book-slot': renderBookSlot,
    gyan: renderGyan,
  };

  // Guards against a slower response landing after a faster one: if the
  // user switches tabs again before the first tab's data has finished
  // loading, only the render whose token still matches is allowed to touch
  // contentEl. Each render function checks `token === activeToken` right
  // before its final contentEl.replaceChildren(...) call.
  let activeToken = 0;
  let currentTab = null;

  async function switchTab(id) {
    currentTab = id;
    const token = ++activeToken;
    root.querySelectorAll('.fr-nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === id));
    renderLoading();
    try {
      await RENDERERS[id](token);
    } catch (e) {
      if (token === activeToken) {
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
    }, 200);
  });

  function buildShell() {
    root = el('div', { id: 'flame-reskin-root' });

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
    for (const tab of TABS) {
      const btn = el('button', { class: 'fr-nav-btn', type: 'button', 'data-tab': tab.id });
      btn.appendChild(icon(tab.icon));
      btn.appendChild(el('span', { class: 'fr-nav-label', text: tab.label }));
      btn.addEventListener('click', () => switchTab(tab.id));
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

    contentEl = el('main', { class: 'fr-content' });
    // Outside contentEl on purpose: every tab render calls
    // contentEl.replaceChildren(), which would take the banner with it.
    bannerHost = el('div', { class: 'fr-banner-host' });

    root.append(nav, bannerHost, contentEl);
    document.body.appendChild(root);
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
    btn.append(btnLabel, icon('chevronDown'));
    const panel = el('div', { class: 'fr-picker-panel' });
    const list = el('div', { class: 'fr-picker-list', role: 'listbox' });
    panel.appendChild(list);
    wrap.append(btn, panel);

    let options = [];
    let value = null;

    function paintPanel() {
      list.replaceChildren();
      for (const opt of options) {
        const item = el('button', {
          class: `fr-picker-option${opt.value === value ? ' is-selected' : ''}`,
          type: 'button', role: 'option', 'aria-selected': String(opt.value === value), text: opt.text,
        });
        item.addEventListener('click', () => {
          value = opt.value;
          btnLabel.textContent = opt.text;
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
        const found = options.find((o) => o.value === v);
        btnLabel.textContent = found ? found.text : '';
        paintPanel();
      },
      setOptions(newOptions) {
        options = newOptions;
        paintPanel();
      },
    };
  }

  // ---------------------------------------------------------------------
  // 9. Home tab — today's classes, upcoming-days glance, upcoming bookings
  // ---------------------------------------------------------------------

  // Home keeps its own small nav state: which week the strip is paged to,
  // and which single day within it is selected. Resets to today/this-week
  // on every fresh visit to the tab (a glance view, not meant to remember
  // where you left off).
  const homeState = { weekStart: startOfWeekMonday(startOfToday()), selected: startOfToday() };

  async function renderHome(token) {
    homeState.weekStart = startOfWeekMonday(startOfToday());
    homeState.selected = startOfToday();

    const userId = await resolveUserId();
    const [events, bookings] = await Promise.all([
      eventsCache ? Promise.resolve(eventsCache) : callAura('StudentPortalCalendarCtrl', 'getAllScheduledEvents', { userId }),
      bookingsCache ? Promise.resolve(bookingsCache) : callAura('CustomBookingController', 'getReservations', { userId }),
    ]);
    eventsCache = events;
    bookingsCache = bookings;
    if (token !== activeToken) return;

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

    // Upcoming bookings — only shown when something is actually upcoming.
    const now = new Date();
    const upcomingBookings = bookings
      .filter((b) => b.status === 'Booked' && parseBookingDateTime(b.startDateTime) >= now)
      .sort((a, b) => parseBookingDateTime(a.startDateTime) - parseBookingDateTime(b.startDateTime))
      .slice(0, 5);
    if (upcomingBookings.length) {
      const bookingsSection = el('div', { style: 'margin-top: 32px;' });
      const headingRow = el('div', { class: 'fr-group-heading-row' });
      headingRow.appendChild(el('h2', { class: 'fr-group-heading', text: 'Upcoming bookings', style: 'margin: 0;' }));
      const seeAll = el('button', { class: 'fr-link-btn', type: 'button', text: 'See all' });
      seeAll.addEventListener('click', () => switchTab('bookings'));
      headingRow.appendChild(seeAll);
      bookingsSection.appendChild(headingRow);
      const list = el('div', { class: 'fr-list' });
      for (const b of upcomingBookings) {
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
      page.appendChild(bookingsSection);
    }

    contentEl.replaceChildren(page);
  }

  // ---------------------------------------------------------------------
  // 10. Calendar tab — real day/week grid, no date picker
  // ---------------------------------------------------------------------

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
    if (!eventsCache) eventsCache = await callAura('StudentPortalCalendarCtrl', 'getAllScheduledEvents', { userId });
    const events = eventsCache;
    if (token !== activeToken) return;

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

    // events is cached above (see eventsCache) and nothing else on this tab
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
    contentEl.replaceChildren(page);
  }

  // ---------------------------------------------------------------------
  // 11. My Bookings tab
  // ---------------------------------------------------------------------

  async function renderMyBookings(token) {
    const userId = await resolveUserId();
    if (!bookingsCache) {
      bookingsCache = await callAura('CustomBookingController', 'getReservations', { userId });
    }
    const bookings = bookingsCache;
    if (token !== activeToken) return;

    const page = el('div', { class: 'fr-page' });
    page.appendChild(el('h1', { class: 'fr-page-title', text: 'My Bookings' }));

    if (!bookings.length) {
      page.appendChild(renderEmpty('bookings', 'No bookings yet', 'Reserve a facility from Book Slot.'));
      contentEl.replaceChildren(page);
      return;
    }

    const now = new Date();
    const withDates = bookings.map((b) => ({ b, start: parseBookingDateTime(b.startDateTime) }));
    const upcoming = withDates.filter((x) => x.start >= now).sort((a, b) => a.start - b.start);
    const past = withDates.filter((x) => x.start < now).sort((a, b) => b.start - a.start);

    function buildSection(title, items, cancellable) {
      const section = el('section', { class: 'fr-day-group' });
      section.appendChild(el('h2', { class: 'fr-group-heading', text: title }));
      const list = el('div', { class: 'fr-list' });
      for (const { b } of items) list.appendChild(renderBookingRow(b, cancellable));
      section.appendChild(list);
      return section;
    }

    if (upcoming.length) page.appendChild(buildSection('Upcoming', upcoming, true));
    if (past.length) page.appendChild(buildSection('Past', past, false));

    contentEl.replaceChildren(page);
  }

  function renderBookingRow(booking, cancellable) {
    const row = el('div', { class: 'fr-row' });
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
      for (const other of contentEl.querySelectorAll('.fr-row.is-confirming')) {
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
        bookingsCache = null;
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
  const AUTOBOOK_EARLY_MARGIN_MS = 30 * 60 * 1000;

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
  const saveIntents = (list) => saveJson(AUTOBOOK_KEY, list);

  // "7:00 AM" -> minutes since midnight. The portal's own slot strings.
  function parseClockMinutes(text) {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(String(text).trim());
    if (!m) return null;
    const hour12 = Number(m[1]) % 12;
    const hour = m[3].toLowerCase() === 'p' ? hour12 + 12 : hour12;
    return hour * 60 + Number(m[2] || 0);
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

  function minutesToClock(mins) {
    const d = new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60);
    return formatTime(d);
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
  function conflictingIntent(resourceName, isoDate, list) {
    const key = resourceClassKey(resourceName);
    return (list || loadIntents()).find(
      (i) => i.state === 'waiting' && i.date === isoDate && resourceClassKey(i.resourceName) === key
    ) || null;
  }

  // Returns the new intent, or null if the day is already claimed for this
  // resource class. Two intents for one class on one day can only ever
  // produce one booking and one refusal, so the second is refused here,
  // where it can still be explained, rather than at fire time.
  function scheduleIntent({ resource, facilityName, date, startTime, endTime }) {
    const list = loadIntents();
    const isoDate = isoDateLocal(date);
    if (conflictingIntent(resource.name, isoDate, list)) return null;
    const intent = {
      id: `i${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      resourceId: resource.resourceId,
      resourceName: resource.name,
      facilityName: facilityName || '',
      date: isoDate,
      startTime,
      endTime,
      state: 'waiting',
      message: '',
      createdAt: Date.now(),
    };
    list.push(intent);
    saveIntents(list);
    return intent;
  }

  function removeIntent(id) {
    saveIntents(loadIntents().filter((i) => i.id !== id));
  }

  // One booking per resource class per calendar day — and "class" is the
  // resource without its operating-window suffix, so the 6 AM gym and the
  // 3 PM gym are the same thing as far as the rule is concerned. Checking
  // first turns a guaranteed refusal into a clear message.
  async function alreadyBookedThatDay(intent) {
    const userId = await resolveUserId();
    const bookings = bookingsCache || (bookingsCache = await callAura('CustomBookingController', 'getReservations', { userId }));
    const wanted = cleanResourceName(intent.resourceName).toLowerCase();
    return bookings.some((b) => {
      if (b.status !== 'Booked') return false;
      const when = parseBookingDateTime(b.startDateTime);
      return isoDateLocal(when) === intent.date && cleanResourceName(b.resourceName).toLowerCase() === wanted;
    });
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

  // The list of what is being watched, shown under the slot grid. Also the
  // only place a scheduled slot can be called off from another tab.
  function buildScheduledList(onChange) {
    const waiting = loadIntents().filter((i) => i.state === 'waiting');
    const wrap = el('div', { class: 'fr-sched' });
    if (!waiting.length) return wrap;
    wrap.appendChild(el('h3', { class: 'fr-sched-title', text: 'Booking automatically' }));
    for (const intent of waiting) {
      const opensAt = intentOpensAt(intent);
      const row = el('div', { class: 'fr-sched-row' });
      const main = el('div', { class: 'fr-sched-main' }, [
        el('p', { class: 'fr-sched-name', text: intentSummary(intent) }),
        el('p', {
          class: 'fr-sched-note',
          text: intent.message || (opensAt ? `Opens ${relativeFuture(opensAt.getTime())} — books itself while the app is open.` : ''),
        }),
      ]);
      const drop = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Stop' });
      drop.addEventListener('click', () => {
        removeIntent(intent.id);
        if (onChange) onChange();
        paintAutoBookBanner();
      });
      row.append(main, drop);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // Results surface wherever you happen to be when they land, since the
  // booking fires while you are doing something else entirely.
  let bannerHost = null;
  function paintAutoBookBanner() {
    if (!bannerHost) return;
    const list = loadIntents();
    const unseen = list.filter((i) => (i.state === 'done' || i.state === 'failed') && !i.seen);
    if (!unseen.length) {
      bannerHost.replaceChildren();
      return;
    }
    const wrap = el('div', {});
    for (const intent of unseen) {
      const banner = el('div', { class: `fr-banner${intent.state === 'done' ? ' is-good' : ' is-bad'}` });
      banner.appendChild(el('div', { class: 'fr-banner-main' }, [
        el('p', { class: 'fr-banner-title', text: intent.state === 'done' ? `Booked ${intentSummary(intent)}` : `Couldn't book ${intentSummary(intent)}` }),
        el('p', { class: 'fr-banner-note', text: intent.message || '' }),
      ]));
      const ok = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Dismiss' });
      ok.addEventListener('click', () => {
        const all = loadIntents();
        const found = all.find((i) => i.id === intent.id);
        if (found) found.seen = true;
        saveIntents(all.filter((i) => i.state === 'waiting' || !i.seen));
        paintAutoBookBanner();
      });
      banner.appendChild(ok);
      wrap.appendChild(banner);
    }
    bannerHost.replaceChildren(wrap);
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
    // in this same pass is not in bookingsCache's snapshot either.
    const claimed = new Set();
    try {
      for (const intent of waiting) {
        const classKey = `${resourceClassKey(intent.resourceName)}|${intent.date}`;
        if (claimed.has(classKey)) {
          intent.state = 'failed';
          intent.message = `Only one ${cleanResourceName(intent.resourceName)} booking a day — another slot was already taken for ${intent.date}.`;
          changed = true;
          continue;
        }
        const start = slotStartDate(intent.date, intent.startTime);
        const opensAt = intentOpensAt(intent);
        if (!start || !opensAt) {
          intent.state = 'failed';
          intent.message = 'Could not read that slot time.';
          changed = true;
          continue;
        }
        if (Date.now() >= start.getTime()) {
          intent.state = 'failed';
          intent.message = 'The slot started before it could be booked.';
          changed = true;
          continue;
        }
        // Start trying slightly before the window is calculated to open.
        // "Less than 24h away" is our model of the rule, not something the
        // API states; if the portal actually releases a bit earlier (a
        // midnight drop, say, or just a clock that disagrees), being early
        // costs two cheap calls that answer "not listed yet", while being
        // late costs the booking.
        if (Date.now() < opensAt.getTime() - AUTOBOOK_EARLY_MARGIN_MS) continue;

        try {
          if (await alreadyBookedThatDay(intent)) {
            claimed.add(classKey);
            intent.state = 'failed';
            intent.message = `You already have a ${cleanResourceName(intent.resourceName)} booking that day.`;
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
          const match = slots.find((sl) => sl.startTime === intent.startTime);
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
            dateSelected: intent.date,
          });
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          if (/booking id/i.test(text)) {
            intent.state = 'done';
            intent.message = text;
            claimed.add(classKey);
            bookingsCache = null;
          } else {
            // createReservation answers refusals with state:SUCCESS and a
            // plain string, so the text is the only signal there is.
            intent.state = 'failed';
            intent.message = text;
          }
          changed = true;
        } catch (e) {
          intent.message = `Attempt failed: ${e.message}`;
          changed = true;
        }
      }
      if (changed) saveIntents(list);
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
        return opensAt && now >= opensAt.getTime() - AUTOBOOK_EARLY_MARGIN_MS;
      });
      const interval = soon ? 15000 : 120000;
      if (now - lastAutoBookRun >= interval) runAutoBook();
    }, 5000);
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
  const RESOURCE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
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

  async function renderBookSlot(token) {
    if (!bookState.facilities) {
      const raw = await callAura('CustomBookingController', 'getResources', null, true);
      bookState.facilities = JSON.parse(raw).map((f) => ({ ...f, resources: sortResources(f.resources || []) }));
    }
    const facilities = bookState.facilities;
    if (token !== activeToken) return;
    if (!bookState.resourceId && facilities[bookState.categoryIdx]) {
      bookState.resourceId = facilities[bookState.categoryIdx].resources[0].resourceId;
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
    const resultsTitle = el('p', { class: 'fr-book-results-title' });
    const resultsWrap = el('div', {});
    const confirmWrap = el('div', {});
    rightCol.append(resultsTitle, resultsWrap, confirmWrap);

    function currentResource() {
      const facility = facilities[bookState.categoryIdx];
      return (facility && facility.resources.find((r) => r.resourceId === resourcePicker.value)) || null;
    }

    function currentResourceName() {
      const facility = facilities[bookState.categoryIdx];
      const r = facility && facility.resources.find((r) => r.resourceId === resourcePicker.value);
      return r ? r.name : '';
    }

    async function refreshAvailability() {
      resultsTitle.textContent = `${currentResourceName()} · ${dayLabel(bookState.date)}`;
      resultsWrap.replaceChildren(el('div', { class: 'fr-loading', style: 'padding: 40px 0;' }, [el('div', { class: 'fr-spinner' })]));
      confirmWrap.replaceChildren();
      const resource = currentResource();
      const isoDate = isoDateLocal(bookState.date);
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
      const bookable = new Map(slots.map((sl) => [sl.startTime, sl]));
      const timeline = [];
      for (const sl of slots) timeline.push({ ...sl, kind: 'open' });
      for (const known of knownSlotTimes(resource)) {
        if (bookable.has(known.startTime)) continue;
        const start = slotStartDate(isoDate, known.startTime);
        if (!start || start.getTime() <= now) continue; // already gone today
        timeline.push({ ...known, kind: 'later', opensAt: start.getTime() - BOOKING_WINDOW_MS });
      }
      timeline.sort((a, b) => (parseClockMinutes(a.startTime) || 0) - (parseClockMinutes(b.startTime) || 0));

      if (!timeline.length) {
        resultsWrap.replaceChildren(
          serverMessage
            ? el('p', { class: 'fr-rail-meta', text: serverMessage })
            : renderEmpty('book', 'No open slots', 'Try a different date.', 'fr-empty--inline')
        );
        return;
      }

      const grid = el('div', { class: 'fr-slot-grid' });
      for (const sl of timeline) {
        const slotBtn = el('button', { class: `fr-slot${sl.kind === 'later' ? ' fr-slot--later' : ''}`, type: 'button' });
        // One auto-booking per resource class per day: if any waiting
        // intent already claims this class on this date, only the tile it
        // belongs to stays interactive. The rest say why they are inert
        // instead of accepting a tap that could never become a booking.
        const claimedBy = sl.kind === 'later' ? conflictingIntent(resource.name, isoDate) : null;
        const scheduled = !!claimedBy && claimedBy.resourceId === resource.resourceId && claimedBy.startTime === sl.startTime;
        const blocked = !!claimedBy && !scheduled;
        slotBtn.append(el('span', { class: 'fr-slot-time', text: compactTimeRange(sl.startTime, sl.endTime) }));
        if (sl.kind === 'open') {
          slotBtn.appendChild(el('span', { class: 'fr-slot-cap', text: `${sl.availableCapacity} left` }));
          if (sl.availableCapacity <= 0) slotBtn.disabled = true;
          slotBtn.addEventListener('click', () => {
            grid.querySelectorAll('.fr-slot').forEach((b) => b.classList.remove('is-selected'));
            slotBtn.classList.add('is-selected');
            openConfirm(sl);
          });
        } else {
          slotBtn.appendChild(el('span', {
            class: 'fr-slot-cap',
            text: scheduled ? 'Auto-booking ✓'
              : blocked ? `${compactTimeRange(claimedBy.startTime, claimedBy.endTime || claimedBy.startTime)} scheduled`
              : `Opens ${relativeFuture(sl.opensAt)}`,
          }));
          slotBtn.classList.toggle('is-scheduled', scheduled);
          if (blocked) {
            slotBtn.disabled = true;
            slotBtn.title = `Only one ${cleanResourceName(resource.name)} booking a day — stop the scheduled one first.`;
          }
          slotBtn.addEventListener('click', () => {
            if (scheduled) {
              const mine = loadIntents().find(
                (i) => i.state === 'waiting' && i.resourceId === resource.resourceId && i.date === isoDate && i.startTime === sl.startTime
              );
              if (mine) removeIntent(mine.id);
            } else {
              scheduleIntent({
                resource,
                facilityName: facilities[bookState.categoryIdx].facility_Name,
                date: bookState.date,
                startTime: sl.startTime,
                endTime: sl.endTime,
              });
            }
            refreshAvailability();
          });
        }
        grid.appendChild(slotBtn);
      }
      resultsWrap.replaceChildren(grid, buildScheduledList(refreshAvailability));
    }

    function openConfirm(slot) {
      // Purpose/co-attendee only make sense for a room booking (who's
      // meeting, why) — a gym or pool slot doesn't need either, so skip
      // the fields entirely for Sports Facilities rather than showing
      // inputs with nothing meaningful to fill in.
      const facility = facilities[bookState.categoryIdx];
      const needsDetails = facility.facility_Name !== 'Sports Facilities';
      const purposeInput = needsDetails
        ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Purpose (optional)' })
        : null;
      const attendeeInput = needsDetails
        ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Co-attendee (optional)' })
        : null;
      const submitBtn = el('button', { class: 'fr-btn fr-btn--primary', type: 'button', text: 'Confirm booking' });

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
            bookingsCache = null; // invalidate so My Bookings refetches
            confirmWrap.replaceChildren(el('div', { class: 'fr-success-panel', text: result }));
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

      confirmWrap.replaceChildren(
        el('div', { class: 'fr-confirm-panel' }, [
          el('p', { class: 'fr-confirm-panel-title', text: compactTimeRange(slot.startTime, slot.endTime) }),
          ...(purposeInput ? [purposeInput] : []),
          ...(attendeeInput ? [attendeeInput] : []),
          submitBtn,
        ])
      );
    }

    facilities.forEach((facility, idx) => {
      const btn = el('button', { class: 'fr-facility-item', type: 'button', text: facility.facility_Name });
      btn.classList.toggle('is-active', idx === bookState.categoryIdx);
      btn.addEventListener('click', () => {
        bookState.categoryIdx = idx;
        bookState.resourceId = facility.resources[0].resourceId;
        facilityList.querySelectorAll('.fr-facility-item').forEach((b, i) => b.classList.toggle('is-active', i === idx));
        resourcePicker.setOptions(facility.resources.map((r) => ({ value: r.resourceId, text: r.name })));
        resourcePicker.value = bookState.resourceId;
        refreshAvailability();
      });
      facilityList.appendChild(btn);
    });

    resourcePicker.setOptions(facilities[bookState.categoryIdx].resources.map((r) => ({ value: r.resourceId, text: r.name })));
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
            refreshAvailability();
          },
          onNext: () => {
            bookState.date = addDays(bookState.date, 1);
            renderDayNav();
            refreshAvailability();
          },
          onToday: () => {
            bookState.date = startOfToday();
            renderDayNav();
            refreshAvailability();
          },
        })
      );
    }
    renderDayNav();

    leftCol.append(facilityList, resourceField, dayField);
    layout.append(leftCol, rightCol);
    page.appendChild(layout);
    contentEl.replaceChildren(page);

    refreshAvailability();
  }

  // ---------------------------------------------------------------------
  // 14. Gyan — the portal's own AI assistant, talked to via the same Aura
  //     RPC endpoint (namespace "vnai" instead of the usual ""). Real
  //     backend actions (menu/faculty lookups, bookings) run server-side —
  //     confirmed against a captured "book a gym slot via chat" session
  //     where the chat's own booking call hit the identical refusal path
  //     CustomBookingController.createReservation does. The client's job is
  //     only to relay each requiredAction's already-computed functionResponse
  //     back as a toolResponse until a real text reply comes back.
  // ---------------------------------------------------------------------

  const gyanState = {
    ready: false,
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
    // The composer's submit handler calls runGyanTurn() directly on every
    // send — it only went through ensureGyanReady() once, on tab mount.
    // (Originally caught a bug this way: something had nulled gyanState's
    // threadId between sends and nothing repopulated it before the next
    // runAssistant call went out.) ensureGyanReady() already no-ops once
    // ready, so calling it on every turn is cheap and guards against that
    // class of bug regardless of what clears the state in the future.
    await ensureGyanReady();

    // runModeration's rejection shape was never observed live (nothing got
    // flagged in the captured session) — fail open rather than block the
    // user's message on an unknown error shape.
    try {
      await callAura('AiAssistantWindowController', 'runModeration', { message }, false, 'vnai');
    } catch (e) {
      console.warn('[flame-reskin] gyan moderation check failed, sending anyway', e);
    }

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

  async function renderGyan(token) {
    await ensureGyanReady();
    if (token !== activeToken) return;

    const page = el('div', { class: 'fr-page fr-gyan-page' });
    const headerRow = el('div', { class: 'fr-group-heading-row' });
    headerRow.appendChild(el('h1', { class: 'fr-page-title', text: gyanState.displayName, style: 'margin: 0;' }));
    const newChatBtn = el('button', { class: 'fr-link-btn', type: 'button', text: 'New chat' });
    newChatBtn.addEventListener('click', async () => {
      // deleteThread + acquireGyanThread's createNewThread fallback is now
      // a confirmed-real delete-and-recreate (see acquireGyanThread) — a
      // HAR of the stock UI's "End chat" button showed deleteThread really
      // deletes, and a HAR of "Start chat" showed createNewThread is the
      // real (and only) way to get a new one back afterward. Earlier this
      // called deleteThread with no working recreate path at all, which
      // was genuinely dangerous; that's fixed now.
      newChatBtn.disabled = true;
      const oldThreadId = gyanState.threadId;
      gyanState.messages = [];
      gyanState.threadId = null;
      gyanState.ready = false;
      if (oldThreadId) {
        try {
          await callAura('AiAssistantWindowController', 'deleteThread', { threadId: oldThreadId }, false, 'vnai');
        } catch (e) {
          console.warn('[flame-reskin] failed to delete old gyan thread, continuing anyway', e);
        }
      }
      if (token === activeToken) switchTab('gyan');
    });
    headerRow.appendChild(newChatBtn);
    page.appendChild(headerRow);

    const messagesEl = el('div', { class: 'fr-gyan-messages' });
    const composerForm = el('form', { class: 'fr-gyan-composer' });
    const inputEl = el('input', {
      class: 'fr-input', type: 'text', placeholder: `Ask ${gyanState.displayName}…`, autocomplete: 'off',
    });
    const sendBtn = el('button', { class: 'fr-btn fr-btn--primary', type: 'submit', text: 'Send' });
    composerForm.append(inputEl, sendBtn);

    function paintMessages() {
      inputEl.disabled = gyanState.sending;
      sendBtn.disabled = gyanState.sending;
      if (!gyanState.messages.length && !gyanState.sending) {
        messagesEl.replaceChildren(
          renderEmpty('sparkle', gyanState.welcomeMessage || 'Ask Gyan',
            gyanState.introductionText || 'Ask about classes, bookings, campus info, or anything else Gyan can help with.')
        );
        return;
      }
      const list = el('div', { class: 'fr-gyan-list' });
      for (const m of gyanState.messages) {
        const row = el('div', { class: `fr-gyan-msg fr-gyan-msg--${m.role}` });
        row.appendChild(el('div', { class: 'fr-gyan-bubble', text: m.text }));
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
      // State updates always happen regardless of which tab is showing —
      // only the DOM paint is gated on still being the active view, so
      // switching away mid-reply and back later shows the finished chat
      // instead of getting stuck on "thinking" forever.
      if (token === activeToken) paintMessages();
      try {
        const reply = await runGyanTurn(text);
        gyanState.messages.push({ role: 'assistant', text: reply });
      } catch (err) {
        gyanState.messages.push({ role: 'assistant', text: `Sorry, something went wrong: ${err.message}` });
        // Soft reset only: re-validate on the next attempt (acquireGyanThread
        // looks up the existing thread first and only creates a new one if
        // that lookup genuinely comes back empty — so this never deletes
        // anything, just stops trusting possibly-stale local state). No
        // automatic deleteThread here — that's real and destructive now
        // that createNewThread's recreate path is confirmed working, so it
        // stays an explicit action (the "New chat" button) the user chooses,
        // not something that fires silently on every transient error.
        gyanState.ready = false;
      } finally {
        gyanState.sending = false;
        if (token === activeToken) paintMessages();
      }
    });

    paintMessages();
    page.append(messagesEl, composerForm);
    contentEl.replaceChildren(page);
    inputEl.focus();
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  // The reskin's hide-CSS is domain-wide (@match covers the whole site),
  // so without this check it would also blank out the login page before
  // auth completes — including the "Sign in with Google" button/flow.
  // Bail out entirely on anything that looks like the login page and let
  // the stock UI render untouched. Path fragments are a best guess
  // (unconfirmed — HAR only covers post-login traffic, see HANDOFF.md);
  // the DOM checks are a belt-and-suspenders backstop in case the path
  // guess is wrong.
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
