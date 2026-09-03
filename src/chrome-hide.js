// ---------------------------------------------------------------------
// 3. Hide original Siteforce chrome, keep it hidden across SPA nav —
//    except when the user has toggled back to the stock UI (section 5).
// ---------------------------------------------------------------------

// The page is a pure Aura SPA shell (confirmed against the HAR: initial
// HTML is just <body class="null loading"> plus a spinner, no app markup
// — Aura renders everything client-side as children of <body>). So rather
// than guess at component class names that only exist post-render, hide
// by structural position: every direct child of <body> except our own
// the reskin root and the stock-UI toggle button. CSS re-applies automatically to
// nodes Aura inserts later, no JS needed for that part.

import { ui } from './state.js';

export function injectHideStyle() {
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
export function keepHiding() {
  const observer = new MutationObserver(() => {
    if (!document.getElementById('flame-reskin-root') && ui.root) document.body.appendChild(ui.root);
    if (!document.getElementById('flame-reskin-toggle') && ui.toggleBtn) document.body.appendChild(ui.toggleBtn);
  });
  observer.observe(document.body, { childList: true });
}
