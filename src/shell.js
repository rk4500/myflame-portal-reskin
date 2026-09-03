// ---------------------------------------------------------------------
// 8. Shell + tab switching
// ---------------------------------------------------------------------

import { auraState, waitFor } from './aura.js';
import { paintAutoBookBanner, runAutoBook, startAutoBookLoop } from './autobook.js';
import { addDays, sameDay, startOfToday } from './dates.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import { ui } from './state.js';
import { attachHomeLongPress, buildStockToggle } from './toggle.js';

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'bookings', label: 'My Bookings', icon: 'bookings' },
  { id: 'book-slot', label: 'Book Slot', icon: 'book' },
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

export function renderEmpty(iconName, title, text, extraClass) {
  const box = el('div', { class: extraClass ? `fr-empty ${extraClass}` : 'fr-empty' });
  box.appendChild(icon(iconName, 'fr-empty-icon'));
  box.appendChild(el('p', { class: 'fr-empty-title', text: title }));
  if (text) box.appendChild(el('p', { class: 'fr-empty-text', text }));
  return box;
}

// Filled by main.js. Deliberately not `{ home: renderHome, ... }` here:
// naming the tab modules from the shell would make the dependency circular
// (every tab imports switchTab/renderEmpty back out of this file), and a
// cycle whose modules read each other's values at import time is exactly
// the kind that breaks on a bundler setting nobody remembers changing.
export const RENDERERS = {};

export function registerRenderers(map) {
  Object.assign(RENDERERS, map);
}

// Guards against a slower response landing after a faster one: if the
// user switches tabs again before the first tab's data has finished
// loading, only the render whose token still matches is allowed to touch
// ui.contentEl. Each render function checks `token === ui.activeToken` right
// before its final ui.contentEl.replaceChildren(...) call.
let currentTab = null;

export async function switchTab(id) {
  currentTab = id;
  const token = ++ui.activeToken;
  ui.root.querySelectorAll('.fr-nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === id));
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
  }, 200);
});

export function buildShell() {
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

  ui.contentEl = el('main', { class: 'fr-content' });
  // Outside ui.contentEl on purpose: every tab render calls
  // ui.contentEl.replaceChildren(), which would take the banner with it.
  ui.bannerHost = el('div', { class: 'fr-banner-host' });

  ui.root.append(nav, ui.bannerHost, ui.contentEl);
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
// A labelled on/off switch. Returns the row plus a `checked` getter, the
// same minimal surface buildPicker exposes — callers only ever ask it one
// question.
export function buildSwitch({ label, hint, checked = false }) {
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
  });
  row.append(text, btn);
  return { el: row, get checked() { return on; } };
}

export function buildDayNav({ label, onPrev, onNext, onToday, prevDisabled }) {
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
export function buildDateStrip({ weekStart, selected, hasEvents, onSelect, onPrevWeek, onNextWeek }) {
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
export function buildPicker({ ariaLabel, onChange }) {
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
