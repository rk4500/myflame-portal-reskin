// ---------------------------------------------------------------------
// 11. My Bookings tab
// ---------------------------------------------------------------------

import { callAura, resolveUserId } from '../aura.js';
import { buildPendingBookingRow, loadIntents, slotStartDate } from '../autobook.js';
import { cleanResourceName, formatBookingWhen, isoDateLocal, parseBookingDateTime, sameDay, startOfToday } from '../dates.js';
import { clearPersistedBookings } from '../persist.js';
import { el } from '../dom.js';
import { renderEmpty, switchTab } from '../shell.js';
import { cache, ui } from '../state.js';

export async function renderMyBookings(token) {
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
