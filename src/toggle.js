// ---------------------------------------------------------------------
// 5. Stock-UI toggle
// ---------------------------------------------------------------------

import { el } from './dom.js';
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

// Mobile has no spare chrome for a Stock-UI control: the bottom tab bar
// is full, and every fixed/floating overlay tried so far ended up
// sitting on top of some tab's own content sooner or later. A long-press
// on the Home tab needs none — it's the one tab guaranteed present in
// every layout, and long-press-for-a-secondary-action is an established
// mobile convention (app icons, list rows) rather than an invented one.
// Only fires below the mobile breakpoint; on desktop this is a no-op and
// the explicit top-bar button (above) is the real control.
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
  // after a long-press release (harmless once off — the root is hidden
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
export function buildToggleButton() {
  const stored = localStorage.getItem('flame-reskin-enabled');
  document.body.classList.toggle('flame-reskin-off', stored === 'false');

  ui.toggleBtn = el('button', {
    id: 'flame-reskin-toggle', type: 'button', text: 'Custom UI', title: 'Switch back to the reskinned portal',
  });
  ui.toggleBtn.addEventListener('click', () => setReskinOff(false));
  document.body.appendChild(ui.toggleBtn);
}
