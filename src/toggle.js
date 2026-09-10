// ---------------------------------------------------------------------
// 5. Stock-UI toggle + the long-press menu that reaches it on mobile
// ---------------------------------------------------------------------

import { buildSwitch, el } from './dom.js';
import { settings, setSetting } from './settings.js';
import { ui } from './state.js';

function setReskinOff(nextOff) {
  document.body.classList.toggle('flame-reskin-off', nextOff);
  localStorage.setItem('flame-reskin-enabled', nextOff ? 'false' : 'true');
}

// Desktop top-bar button — only needs to switch *off* (it lives inside
// #flame-reskin-root, so it vanishes along with everything else the
// instant it's hidden; nothing needs to re-paint it afterward). Hidden
// entirely on mobile — see attachHomeLongPress() for the mobile switch.
export function buildStockToggle(className) {
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
export function attachHomeLongPress(btn) {
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
export function buildToggleButton() {
  const stored = localStorage.getItem('flame-reskin-enabled');
  document.body.classList.toggle('flame-reskin-off', stored === 'false');

  ui.toggleBtn = el('button', {
    id: 'flame-reskin-toggle', type: 'button', text: 'Custom UI', title: 'Switch back to the reskinned portal',
  });
  ui.toggleBtn.addEventListener('click', () => setReskinOff(false));
  document.body.appendChild(ui.toggleBtn);
}
