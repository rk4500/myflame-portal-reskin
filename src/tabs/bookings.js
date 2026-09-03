// ---------------------------------------------------------------------
// 11. My Bookings tab
// ---------------------------------------------------------------------

import { callAura, resolveUserId } from '../aura.js';
import { cleanResourceName, formatBookingWhen, parseBookingDateTime } from '../dates.js';
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

  const page = el('div', { class: 'fr-page' });
  page.appendChild(el('h1', { class: 'fr-page-title', text: 'My Bookings' }));

  if (!bookings.length) {
    page.appendChild(renderEmpty('bookings', 'No bookings yet', 'Reserve a facility from Book Slot.'));
    ui.contentEl.replaceChildren(page);
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

  ui.contentEl.replaceChildren(page);
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
