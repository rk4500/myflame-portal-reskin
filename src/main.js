// Entry point. `npm run build` bundles everything reachable from here into
// portal-reskin.user.js; edit these modules, never that file.
//
// Load order matters in one place only: the hide-CSS goes in before
// anything else, because @run-at document-start is what lets the stock
// Siteforce chrome be hidden before it ever paints.

// The shell holds an empty registry and gets it filled here, so the tab
// modules can import switchTab/renderEmpty out of the shell without the
// two ends importing each other.

import { injectHideStyle, keepHiding } from './chrome-hide.js';
import { buildShell, registerRenderers } from './shell.js';
import { injectComponentStyles } from './styles.js';
import { renderBookSlot } from './tabs/book-slot.js';
import { renderMyBookings } from './tabs/bookings.js';
import { renderCalendar } from './tabs/calendar.js';
import { renderGyan } from './tabs/gyan.js';
import { renderHome } from './tabs/home.js';
import { buildToggleButton } from './toggle.js';

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
