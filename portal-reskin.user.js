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

.fr-nav {
  width: 232px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.fr-brand { display: flex; align-items: center; gap: 10px; padding: 0 8px; }
.fr-brand-mark {
  width: 32px; height: 32px; border-radius: 9px;
  background: var(--accent); color: var(--accent-text);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 13px; letter-spacing: -0.02em;
}
.fr-brand-name { font-weight: 600; font-size: 15px; letter-spacing: -0.01em; }
.fr-nav-list { display: flex; flex-direction: column; gap: 4px; }
.fr-nav-btn {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 12px; border-radius: 10px;
  background: transparent; border: none;
  color: var(--text-secondary); font: inherit; font-weight: 500;
  cursor: pointer; text-align: left;
  transition: background-color 120ms ease, color 120ms ease;
}
.fr-nav-btn:hover { background: var(--bg-elevated); color: var(--text); }
.fr-nav-btn.is-active { background: var(--bg-elevated-2); color: var(--text); }
.fr-nav-btn.is-active .icon { color: var(--accent); }

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
.fr-row-main { min-width: 0; }
.fr-row-title { margin: 0; font-weight: 600; }
.fr-row-meta { margin: 4px 0 0; font-size: 0.8125rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.fr-row-time { font-weight: 600; font-variant-numeric: tabular-nums; flex-shrink: 0; min-width: 78px; }

.fr-badge { flex-shrink: 0; padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
.fr-badge.is-booked { background: var(--success-bg); color: var(--success); }
.fr-badge.is-cancelled { background: var(--bg-elevated-2); color: var(--text-secondary); }

.fr-cancel-wrap { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.fr-confirm-text { font-size: 0.8125rem; color: var(--text-secondary); white-space: nowrap; }

.fr-btn {
  font: inherit; font-weight: 600; border-radius: 9px; padding: 9px 16px;
  border: 1px solid transparent; cursor: pointer;
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

.fr-cal-wrap { display: flex; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
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
}
/* Venue never truncates (unlike title/meta below, which clip themselves) —
   an unusually long room name is rare at the widened column width above,
   but when it happens the block grows past its slot rather than losing
   text: overflow lives on the two children that opt into clipping, not
   here, so a wrapped venue line pushes content instead of cutting it off. */
.fr-cal-event-venue {
  font-weight: 600; color: var(--accent);
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
.fr-datestrip-weekday { font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.8; }
.fr-datestrip-daynum { font-size: 1.0625rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.fr-datestrip-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.fr-datestrip-dot.is-empty { visibility: hidden; }

/* Facility rail + slot layout (Book Slot) */
.fr-book-layout { display: grid; grid-template-columns: minmax(240px, 300px) 1fr; gap: 32px; align-items: start; }
.fr-facility-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
.fr-facility-item {
  display: block; width: 100%; text-align: left; font: inherit; font-weight: 500;
  padding: 10px 12px; border-radius: 9px; background: transparent; border: none;
  color: var(--text-secondary); cursor: pointer; transition: background-color 120ms ease, color 120ms ease;
}
.fr-facility-item:hover { background: var(--bg-elevated); color: var(--text); }
.fr-facility-item.is-active { background: var(--accent); color: var(--accent-text); }
.fr-book-field { margin-bottom: 16px; }
.fr-book-field-label { display: block; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin-bottom: 6px; }
.fr-book-results-title { font-weight: 600; margin: 0 0 16px; }

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
.fr-slot-time { font-weight: 600; font-variant-numeric: tabular-nums; }
.fr-slot-cap { font-size: 0.75rem; color: var(--text-secondary); }

.fr-confirm-panel {
  margin-top: 24px; padding: 20px; background: var(--bg-elevated); border-radius: 14px;
  display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end;
}
.fr-confirm-panel-title { grid-column: 1 / -1; font-weight: 600; margin: 0 0 4px; }
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
.fr-gyan-msg--user .fr-gyan-bubble { background: var(--accent); color: var(--accent-text); border-bottom-right-radius: 4px; }
.fr-gyan-msg--assistant .fr-gyan-bubble { background: var(--bg-elevated); color: var(--text); border-bottom-left-radius: 4px; }
.fr-gyan-typing { color: var(--text-secondary); font-style: italic; }
.fr-gyan-composer { display: flex; gap: 10px; margin-top: 16px; flex-shrink: 0; }
.fr-gyan-composer .fr-input { flex: 1; }

/* Stock-UI toggle — lives outside #flame-reskin-root so it survives the off-state */
#flame-reskin-toggle {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
  background: #1a1e28; color: #eef0f6; border: 1px solid #2b3040;
  border-radius: 999px; padding: 8px 16px; font: 600 12px ui-sans-serif, -apple-system, sans-serif;
  cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.45);
}
#flame-reskin-toggle:hover { background: #232838; }

@media (max-width: 760px) {
  .fr-nav {
    position: fixed; left: 0; right: 0; bottom: 0; top: auto;
    width: auto; height: 68px; flex-direction: row;
    border-right: none; border-top: 1px solid var(--border);
    padding: 8px 8px calc(8px + var(--flame-navbar-inset)); background: var(--bg); align-items: center; z-index: 5;
    height: calc(68px + var(--flame-navbar-inset));
  }
  .fr-brand { display: none; }
  .fr-nav-list { flex-direction: row; flex: 1; justify-content: space-around; }
  .fr-nav-btn { flex-direction: column; gap: 4px; padding: 6px 10px; }
  .fr-nav-label { font-size: 0.6875rem; }
  .fr-content { padding: 12px 20px calc(96px + var(--flame-navbar-inset)); }
  .fr-book-layout { grid-template-columns: 1fr; }
  .fr-datestrip { gap: 4px; }
  .fr-datestrip-cells { gap: 4px; }
  .fr-datestrip-cell { padding: 8px 0; }
  .fr-datestrip-weekday { font-size: 0.625rem; }
  .fr-datestrip-daynum { font-size: 0.9375rem; }
  .fr-daynav-btn { width: 28px; height: 28px; }
  /* Day/week toggle moves up next to the title; the day-nav/date-strip
     gets its own full-width row below (same grid, different areas). */
  .fr-cal-header { grid-template-areas: "title toggle" "nav nav"; }
  .fr-slot-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
  /* Week view: let the grid overflow-scroll horizontally at a readable
     column width instead of squeezing 7 days into the viewport — the JS
     gives .fr-cal-days a min-width in week mode to force this. */
  .fr-cal-wrap { overflow-x: auto; }
  .fr-cal-gutter { position: sticky; left: 0; z-index: 1; background: var(--bg); }
  .fr-confirm-panel { grid-template-columns: 1fr; }
  body:not(.flame-reskin-off) #flame-reskin-toggle { bottom: 80px; }
  /* Unlike other tabs, Gyan's chat always fills all the way to the bottom
     of .fr-content's padded box by design (height:100% flex column) — so
     unlike them, it actually reaches down into the Stock UI pill's mobile
     position (bottom:80px + its own height) and the composer visibly
     overlapped it. Give the composer enough clearance instead. */
  .fr-gyan-composer { margin-bottom: 44px; }
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

  let toggleBtn;

  function buildToggleButton() {
    const stored = localStorage.getItem('flame-reskin-enabled');
    const enabled = stored !== 'false';
    document.body.classList.toggle('flame-reskin-off', !enabled);

    toggleBtn = el('button', { id: 'flame-reskin-toggle', type: 'button' });
    const paint = () => {
      const isOff = document.body.classList.contains('flame-reskin-off');
      toggleBtn.textContent = isOff ? 'Custom UI' : 'Stock UI';
      toggleBtn.title = isOff ? 'Switch back to the reskinned portal' : 'Show the original portal UI';
    };
    toggleBtn.addEventListener('click', () => {
      const nextOff = !document.body.classList.contains('flame-reskin-off');
      document.body.classList.toggle('flame-reskin-off', nextOff);
      localStorage.setItem('flame-reskin-enabled', nextOff ? 'false' : 'true');
      paint();
    });
    paint();
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
    sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z"/></svg>',
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
    return `${dayLabel(start)} · ${formatTime(start)} – ${formatTime(end)}`;
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

    const nav = el('nav', { class: 'fr-nav' });
    const brand = el('div', { class: 'fr-brand' }, [
      el('span', { class: 'fr-brand-mark', text: 'FL' }),
      el('span', { class: 'fr-brand-name', text: 'Portal' }),
    ]);
    const navList = el('div', { class: 'fr-nav-list' });
    for (const tab of TABS) {
      const btn = el('button', { class: 'fr-nav-btn', type: 'button', 'data-tab': tab.id });
      btn.appendChild(icon(tab.icon));
      btn.appendChild(el('span', { class: 'fr-nav-label', text: tab.label }));
      btn.addEventListener('click', () => switchTab(tab.id));
      navList.appendChild(btn);
    }
    nav.append(brand, navList);

    contentEl = el('main', { class: 'fr-content' });

    root.append(nav, contentEl);
    document.body.appendChild(root);
    // Preview/dev only: let the harness pick which tab to boot straight
    // into, instead of racing a separate switchTab() call against this one
    // after the fact (two switchTab calls in flight at once is exactly the
    // out-of-order scenario the token guard exists for).
    switchTab((window.__FLAME_RESKIN_PREVIEW__ && window.__FLAME_RESKIN_INITIAL_TAB__) || 'home');
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
        main.appendChild(el('p', { class: 'fr-row-title', text: ev.courseName || ev.title }));
        const meta = [ev.room, ev.faculty ? `${ev.facultySalutation || ''} ${ev.faculty}`.trim() : null].filter(Boolean).join(' · ');
        if (meta) main.appendChild(el('p', { class: 'fr-row-meta', text: meta }));
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
              el('p', { class: 'fr-row-title', text: cleanResourceName(b.resourceName) }),
              el('p', { class: 'fr-row-meta', text: formatBookingWhen(b) }),
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
      // grid — drop it and lead with venue instead (never clipped, unlike
      // the title below it which clamps if the block is short/narrow).
      if (item.raw.room) block.appendChild(el('div', { class: 'fr-cal-event-venue', text: item.raw.room }));
      block.appendChild(el('div', { class: 'fr-cal-event-title', text: item.raw.courseName || item.raw.title }));
      if (item.raw.faculty) {
        const prof = `${item.raw.facultySalutation || ''} ${item.raw.faculty}`.trim();
        block.appendChild(el('div', { class: 'fr-cal-event-meta', text: prof }));
      }
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

    calWrap.append(gutter, daysWrap);
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
    main.appendChild(el('p', { class: 'fr-row-title', text: cleanResourceName(booking.resourceName) }));
    main.appendChild(el('p', { class: 'fr-row-meta', text: formatBookingWhen(booking) }));
    row.appendChild(main);

    const statusClass = booking.status === 'Booked' ? 'is-booked' : 'is-cancelled';
    row.appendChild(el('span', { class: `fr-badge ${statusClass}`, text: booking.status }));

    if (cancellable && booking.status === 'Booked') {
      row.appendChild(buildCancelControl(booking));
    }
    return row;
  }

  function buildCancelControl(booking) {
    const wrap = el('div', { class: 'fr-cancel-wrap' });

    function showAsk() {
      const yesBtn = el('button', { class: 'fr-btn fr-btn--danger fr-btn--sm', type: 'button', text: 'Yes, cancel' });
      const noBtn = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'No' });
      yesBtn.addEventListener('click', async () => {
        yesBtn.disabled = true;
        yesBtn.textContent = 'Cancelling…';
        try {
          const userId = await resolveUserId();
          await callAura('CustomBookingController', 'cancelReservation', { userId, bookingId: booking.bookingId });
          bookingsCache = null;
          await switchTab('bookings');
        } catch (e) {
          wrap.replaceChildren(el('span', { class: 'fr-confirm-text fr-error-text', text: `Failed: ${e.message}` }));
        }
      });
      noBtn.addEventListener('click', showIdle);
      wrap.replaceChildren(el('span', { class: 'fr-confirm-text', text: 'Cancel this booking?' }), yesBtn, noBtn);
    }

    function showIdle() {
      const cancelBtn = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Cancel' });
      cancelBtn.addEventListener('click', showAsk);
      wrap.replaceChildren(cancelBtn);
    }

    showIdle();
    return wrap;
  }

  // ---------------------------------------------------------------------
  // 12. Book Slot tab — facility rail + auto-checked availability + submit
  // ---------------------------------------------------------------------

  const bookState = { facilities: null, categoryIdx: 0, resourceId: null, date: startOfToday() };

  async function renderBookSlot(token) {
    if (!bookState.facilities) {
      const raw = await callAura('CustomBookingController', 'getResources', null, true);
      bookState.facilities = JSON.parse(raw);
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
    const resourceSelect = el('select', { class: 'fr-select', 'aria-label': 'Resource' });
    resourceField.appendChild(resourceSelect);

    const dayField = el('div', { class: 'fr-book-field' });

    // Right: results
    const rightCol = el('div', {});
    const resultsTitle = el('p', { class: 'fr-book-results-title' });
    const resultsWrap = el('div', {});
    const confirmWrap = el('div', {});
    rightCol.append(resultsTitle, resultsWrap, confirmWrap);

    function currentResourceName() {
      const facility = facilities[bookState.categoryIdx];
      const r = facility && facility.resources.find((r) => r.resourceId === resourceSelect.value);
      return r ? r.name : '';
    }

    async function refreshAvailability() {
      resultsTitle.textContent = `${currentResourceName()} · ${dayLabel(bookState.date)}`;
      resultsWrap.replaceChildren(el('div', { class: 'fr-loading', style: 'padding: 40px 0;' }, [el('div', { class: 'fr-spinner' })]));
      confirmWrap.replaceChildren();
      try {
        const raw2 = await callAura('CustomBookingController', 'getResourceAvailability', {
          resourceId: resourceSelect.value,
          bookingDate: isoDateLocal(bookState.date),
        });
        let parsed = null;
        try {
          parsed = JSON.parse(raw2);
        } catch (e) {
          // raw2 is a plain message like "Booking date cannot be in the past."
        }
        if (!parsed) {
          resultsWrap.replaceChildren(el('p', { class: 'fr-row-meta', text: raw2 }));
          return;
        }
        const slots = parsed.availabilitySlots || [];
        if (!slots.length) {
          resultsWrap.replaceChildren(renderEmpty('book', 'No open slots', 'Try a different date.', 'fr-empty--inline'));
          return;
        }
        const grid = el('div', { class: 'fr-slot-grid' });
        for (const s of slots) {
          const slotBtn = el('button', { class: 'fr-slot', type: 'button' });
          slotBtn.append(
            el('span', { class: 'fr-slot-time', text: `${s.startTime} – ${s.endTime}` }),
            el('span', { class: 'fr-slot-cap', text: `${s.availableCapacity} left` })
          );
          if (s.availableCapacity <= 0) slotBtn.disabled = true;
          slotBtn.addEventListener('click', () => {
            grid.querySelectorAll('.fr-slot').forEach((b) => b.classList.remove('is-selected'));
            slotBtn.classList.add('is-selected');
            openConfirm(s);
          });
          grid.appendChild(slotBtn);
        }
        resultsWrap.replaceChildren(grid);
      } catch (e) {
        resultsWrap.replaceChildren(el('p', { class: 'fr-row-meta fr-error-text', text: `Error: ${e.message}` }));
      }
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
            resource: resourceSelect.value,
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
          el('p', { class: 'fr-confirm-panel-title', text: `${slot.startTime} – ${slot.endTime}` }),
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
        resourceSelect.replaceChildren();
        for (const r of facility.resources) resourceSelect.appendChild(el('option', { value: r.resourceId, text: r.name }));
        refreshAvailability();
      });
      facilityList.appendChild(btn);
    });

    for (const r of facilities[bookState.categoryIdx].resources) {
      resourceSelect.appendChild(el('option', { value: r.resourceId, text: r.name }));
    }
    resourceSelect.value = bookState.resourceId;
    resourceSelect.addEventListener('change', refreshAvailability);

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
  // 13. Gyan — the portal's own AI assistant, talked to via the same Aura
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

    const thread = await callAura(
      'AiAssistantWindowController', 'getUserThread',
      { assistantId: gyanState.assistantId, actorId: userId, createIfNotExists: true, refreshToken: 0 },
      true, 'vnai'
    );
    gyanState.threadId = thread.threadId;
    gyanState.ready = true;
  }

  // getUserThread(createIfNotExists:true) reconnects to the same persistent
  // server-side thread every time (threads live per user+assistant, not per
  // page load) — so a thread that's gotten into a bad state server-side
  // (e.g. "List index out of bounds: 0" from runAssistant, seen live) stays
  // broken across reloads too. Delete it and let the next ensureGyanReady()
  // create a fresh one. Best-effort: deleteThread failing shouldn't block
  // the reset, there's nothing more we can do with the response either way.
  async function resetGyanThread({ clearMessages = false } = {}) {
    const oldThreadId = gyanState.threadId;
    gyanState.ready = false;
    gyanState.threadId = null;
    gyanState.sending = false;
    if (clearMessages) gyanState.messages = [];
    if (oldThreadId) {
      try {
        await callAura('AiAssistantWindowController', 'deleteThread', { threadId: oldThreadId }, false, 'vnai');
      } catch (e) {
        console.warn('[flame-reskin] failed to delete old gyan thread, continuing anyway', e);
      }
    }
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
      newChatBtn.disabled = true;
      await resetGyanThread({ clearMessages: true });
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
        // Whatever the cause, retrying against the same server-side thread
        // tends to just fail the same way again — reset it in the
        // background (keeping the visible transcript) so the next message
        // starts clean instead of repeating the same error forever.
        await resetGyanThread();
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
