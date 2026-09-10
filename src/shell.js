// ---------------------------------------------------------------------
// 8. Shell + tab switching
// ---------------------------------------------------------------------

import { auraState, waitFor } from './aura.js';
import { paintAutoBookBanner, runAutoBook, startAutoBookLoop } from './autobook.js';
import { addDays, sameDay, startOfToday } from './dates.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import { settings } from './settings.js';
import { ui } from './state.js';
import { attachHomeLongPress, buildStockToggle } from './toggle.js';

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

export function renderEmpty(iconName, title, text, extraClass, action) {
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
export async function switchTab(id) {
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
export function transitionToTab(nextId) {
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
