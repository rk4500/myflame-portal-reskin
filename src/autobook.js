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

import { auraState, callAura, resolveUserId } from './aura.js';
import { cleanResourceName, compactTimeRange, formatTime, isoDateLocal, parseBookingDateTime, shortDayLabel } from './dates.js';
import { clearPersistedBookings } from './persist.js';
import { el } from './dom.js';
import { cache, ui } from './state.js';

const AUTOBOOK_KEY = 'flame-auto-book';
const SLOT_MEMORY_KEY = 'flame-slot-times';
export const BOOKING_WINDOW_MS = 24 * 60 * 60 * 1000;
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

export const loadIntents = () => loadJson(AUTOBOOK_KEY, []);
const saveIntents = (list) => saveJson(AUTOBOOK_KEY, list);

// "7:00 AM" -> minutes since midnight. The portal's own slot strings.
export function parseClockMinutes(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(String(text).trim());
  if (!m) return null;
  const hour12 = Number(m[1]) % 12;
  const hour = m[3].toLowerCase() === 'p' ? hour12 + 12 : hour12;
  return hour * 60 + Number(m[2] || 0);
}

export function slotStartDate(isoDate, startTime) {
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

export function rememberSlotTimes(resourceId, slots) {
  if (!resourceId || !slots.length) return;
  const memory = loadJson(SLOT_MEMORY_KEY, {});
  memory[resourceId] = slots.map((s) => ({ startTime: s.startTime, endTime: s.endTime }));
  saveJson(SLOT_MEMORY_KEY, memory);
}

// The full day for a resource: derived from its operating window when the
// name carries one, otherwise whatever we last saw it offer.
export function knownSlotTimes(resource) {
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
export function conflictingIntent(resourceName, isoDate, list) {
  const key = resourceClassKey(resourceName);
  return (list || loadIntents()).find(
    (i) => i.state === 'waiting' && i.date === isoDate && resourceClassKey(i.resourceName) === key
  ) || null;
}

// Returns the new intent, or null if the day is already claimed for this
// resource class. Two intents for one class on one day can only ever
// produce one booking and one refusal, so the second is refused here,
// where it can still be explained, rather than at fire time.
export function scheduleIntent({ resource, facilityName, date, startTime, endTime }) {
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

export function removeIntent(id) {
  saveIntents(loadIntents().filter((i) => i.id !== id));
}

// One booking per resource class per calendar day — and "class" is the
// resource without its operating-window suffix, so the 6 AM gym and the
// 3 PM gym are the same thing as far as the rule is concerned. Checking
// first turns a guaranteed refusal into a clear message.
async function alreadyBookedThatDay(intent) {
  const userId = await resolveUserId();
  const bookings = cache.bookings || (cache.bookings = await callAura('CustomBookingController', 'getReservations', { userId }));
  const wanted = cleanResourceName(intent.resourceName).toLowerCase();
  return bookings.some((b) => {
    if (b.status !== 'Booked') return false;
    const when = parseBookingDateTime(b.startDateTime);
    return isoDateLocal(when) === intent.date && cleanResourceName(b.resourceName).toLowerCase() === wanted;
  });
}

// "in 3h 20m" / "in 12m" — a countdown reads better than a wall-clock
// time here, because what matters is how long the wait is, not when.
export function relativeFuture(ts) {
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
export function buildScheduledList(onChange) {
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

function buildBannerSlot(intent) {
  const slot = el('div', { class: 'fr-banner-slot' });
  slot.dataset.intent = intent.id;
  const clip = el('div', { class: 'fr-banner-clip' });
  const banner = el('div', { class: `fr-banner${intent.state === 'done' ? ' is-good' : ' is-bad'}` });
  banner.appendChild(el('div', { class: 'fr-banner-main' }, [
    el('p', {
      class: 'fr-banner-title',
      text: intent.state === 'done' ? `Booked ${intentSummary(intent)}` : `Couldn't book ${intentSummary(intent)}`,
    }),
    el('p', { class: 'fr-banner-note', text: intent.message || '' }),
  ]));
  const ok = el('button', { class: 'fr-btn fr-btn--ghost fr-btn--sm', type: 'button', text: 'Dismiss' });
  ok.addEventListener('click', () => {
    const all = loadIntents();
    const found = all.find((i) => i.id === intent.id);
    if (found) found.seen = true;
    saveIntents(all.filter((i) => i.state === 'waiting' || !i.seen));
    // Repaint decides what leaves; the animation lives in one place.
    paintAutoBookBanner();
  });
  banner.appendChild(ok);
  clip.appendChild(banner);
  slot.appendChild(clip);
  return slot;
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

export function paintAutoBookBanner() {
  if (!ui.bannerHost) return;
  const unseen = loadIntents().filter((i) => (i.state === 'done' || i.state === 'failed') && !i.seen);
  const wanted = new Set(unseen.map((i) => i.id));
  const slots = Array.from(ui.bannerHost.children);

  // Gone: animate out. Already-leaving slots are left alone.
  for (const slot of slots) {
    if (!wanted.has(slot.dataset.intent)) closeBannerSlot(slot);
  }

  // New: append and animate in. A slot on its way out does not count as
  // present, so a result that somehow returns gets a fresh entrance.
  const present = new Set(
    slots.filter((s) => s.dataset.leaving !== '1').map((s) => s.dataset.intent)
  );
  for (const intent of unseen) {
    if (present.has(intent.id)) continue;
    const slot = buildBannerSlot(intent);
    ui.bannerHost.appendChild(slot);
    openBannerSlot(slot);
  }
}

let autoBookRunning = false;
let lastAutoBookRun = 0;

// Returns true if anything changed, so callers can repaint.
export async function runAutoBook() {
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
          cache.bookings = null;
          clearPersistedBookings();
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
export function startAutoBookLoop() {
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
