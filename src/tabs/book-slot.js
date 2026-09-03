// ---------------------------------------------------------------------
// 13. Book Slot tab — facility rail + auto-checked availability + submit
// ---------------------------------------------------------------------

import { callAura, resolveUserId } from '../aura.js';
import { BOOKING_WINDOW_MS, buildScheduledList, conflictingIntent, knownSlotTimes, loadIntents, parseClockMinutes, relativeFuture, rememberSlotTimes, removeIntent, scheduleIntent, slotStartDate } from '../autobook.js';
import { addDays, cleanResourceName, compactTimeRange, dayLabel, isoDateLocal, sameDay, startOfToday } from '../dates.js';
import { clearPersistedBookings } from '../persist.js';
import { el } from '../dom.js';
import { buildDayNav, buildPicker, renderEmpty } from '../shell.js';
import { cache, ui } from '../state.js';

const bookState = { facilities: null, categoryIdx: 0, resourceId: null, date: startOfToday() };

// getResources returns each facility's rooms in whatever order the query
// produced — ARB001, ARB004, ARB002, ARB101 — which reads as no order at
// all in the picker. Sorted once here, at the point the data lands, so the
// picker, the default selection and anything else reading bookState all
// agree.
//
// Numeric collation is what makes ARB002 come before ARB101 (a plain
// string sort puts "101" before "2"), and it puts Discussion Room A/B/C in
// sequence. The one case it gets wrong on its own is a name carrying an
// operating window — "Gym ( 3:00 pm to 11:00 pm slot )" would sort before
// "Gym ( 6:00 am to 2:00 pm slot )" on the bare digit 3 — so a window is
// split off and compared as a real time, listing the morning gym first.
const RESOURCE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const RESOURCE_WINDOW_RE = /^(.*?)\s*\(\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i;

function splitResourceWindow(name) {
  const m = RESOURCE_WINDOW_RE.exec(name || '');
  if (!m) return { label: (name || '').trim(), startMinutes: 0 };
  const hour12 = Number(m[2]) % 12;
  const hour = m[4].toLowerCase() === 'p' ? hour12 + 12 : hour12;
  return { label: m[1].trim(), startMinutes: hour * 60 + Number(m[3] || 0) };
}

function sortResources(resources) {
  return resources.slice().sort((a, b) => {
    const left = splitResourceWindow(a.name);
    const right = splitResourceWindow(b.name);
    return RESOURCE_COLLATOR.compare(left.label, right.label) || left.startMinutes - right.startMinutes;
  });
}

export async function renderBookSlot(token) {
  if (!bookState.facilities) {
    const raw = await callAura('CustomBookingController', 'getResources', null, true);
    bookState.facilities = JSON.parse(raw).map((f) => ({ ...f, resources: sortResources(f.resources || []) }));
  }
  const facilities = bookState.facilities;
  if (token !== ui.activeToken) return;
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
  const resourcePicker = buildPicker({ ariaLabel: 'Resource', onChange: () => refreshAvailability() });
  resourceField.appendChild(resourcePicker.el);

  const dayField = el('div', { class: 'fr-book-field' });

  // Right: results
  const rightCol = el('div', {});
  const resultsTitle = el('p', { class: 'fr-book-results-title' });
  const resultsWrap = el('div', {});
  const confirmWrap = el('div', {});
  rightCol.append(resultsTitle, resultsWrap, confirmWrap);

  function currentResource() {
    const facility = facilities[bookState.categoryIdx];
    return (facility && facility.resources.find((r) => r.resourceId === resourcePicker.value)) || null;
  }

  function currentResourceName() {
    const facility = facilities[bookState.categoryIdx];
    const r = facility && facility.resources.find((r) => r.resourceId === resourcePicker.value);
    return r ? r.name : '';
  }

  async function refreshAvailability() {
    resultsTitle.textContent = `${currentResourceName()} · ${dayLabel(bookState.date)}`;
    resultsWrap.replaceChildren(el('div', { class: 'fr-loading', style: 'padding: 40px 0;' }, [el('div', { class: 'fr-spinner' })]));
    confirmWrap.replaceChildren();
    const resource = currentResource();
    const isoDate = isoDateLocal(bookState.date);
    let slots = [];
    let serverMessage = '';
    try {
      const raw2 = await callAura('CustomBookingController', 'getResourceAvailability', {
        resourceId: resourcePicker.value,
        bookingDate: isoDate,
      });
      let parsed = null;
      try {
        parsed = JSON.parse(raw2);
      } catch (e) {
        // raw2 is a plain message like "Booking date cannot be in the past."
      }
      if (parsed) {
        slots = parsed.availabilitySlots || [];
        rememberSlotTimes(resourcePicker.value, slots);
      } else {
        serverMessage = raw2;
      }
    } catch (e) {
      resultsWrap.replaceChildren(el('p', { class: 'fr-rail-meta fr-error-text', text: `Error: ${e.message}` }));
      return;
    }

    // A slot the portal won't list yet is not the same as a slot that
    // doesn't exist: bookings open 24h ahead, so the rest of the day is
    // real, just not open. Those are rendered too, as schedulable.
    const now = Date.now();
    const bookable = new Map(slots.map((sl) => [sl.startTime, sl]));
    const timeline = [];
    for (const sl of slots) timeline.push({ ...sl, kind: 'open' });
    for (const known of knownSlotTimes(resource)) {
      if (bookable.has(known.startTime)) continue;
      const start = slotStartDate(isoDate, known.startTime);
      if (!start || start.getTime() <= now) continue; // already gone today
      timeline.push({ ...known, kind: 'later', opensAt: start.getTime() - BOOKING_WINDOW_MS });
    }
    timeline.sort((a, b) => (parseClockMinutes(a.startTime) || 0) - (parseClockMinutes(b.startTime) || 0));

    if (!timeline.length) {
      resultsWrap.replaceChildren(
        serverMessage
          ? el('p', { class: 'fr-rail-meta', text: serverMessage })
          : renderEmpty('book', 'No open slots', 'Try a different date.', 'fr-empty--inline')
      );
      return;
    }

    const grid = el('div', { class: 'fr-slot-grid' });
    for (const sl of timeline) {
      const slotBtn = el('button', { class: `fr-slot${sl.kind === 'later' ? ' fr-slot--later' : ''}`, type: 'button' });
      // One auto-booking per resource class per day: if any waiting
      // intent already claims this class on this date, only the tile it
      // belongs to stays interactive. The rest say why they are inert
      // instead of accepting a tap that could never become a booking.
      const claimedBy = sl.kind === 'later' ? conflictingIntent(resource.name, isoDate) : null;
      const scheduled = !!claimedBy && claimedBy.resourceId === resource.resourceId && claimedBy.startTime === sl.startTime;
      const blocked = !!claimedBy && !scheduled;
      slotBtn.append(el('span', { class: 'fr-slot-time', text: compactTimeRange(sl.startTime, sl.endTime) }));
      if (sl.kind === 'open') {
        slotBtn.appendChild(el('span', { class: 'fr-slot-cap', text: `${sl.availableCapacity} left` }));
        if (sl.availableCapacity <= 0) slotBtn.disabled = true;
        slotBtn.addEventListener('click', () => {
          grid.querySelectorAll('.fr-slot').forEach((b) => b.classList.remove('is-selected'));
          slotBtn.classList.add('is-selected');
          openConfirm(sl);
        });
      } else {
        slotBtn.appendChild(el('span', {
          class: 'fr-slot-cap',
          text: scheduled ? 'Auto-booking ✓'
            : blocked ? `${compactTimeRange(claimedBy.startTime, claimedBy.endTime || claimedBy.startTime)} scheduled`
            : `Opens ${relativeFuture(sl.opensAt)}`,
        }));
        slotBtn.classList.toggle('is-scheduled', scheduled);
        if (blocked) {
          slotBtn.disabled = true;
          slotBtn.title = `Only one ${cleanResourceName(resource.name)} booking a day — stop the scheduled one first.`;
        }
        slotBtn.addEventListener('click', () => {
          if (scheduled) {
            const mine = loadIntents().find(
              (i) => i.state === 'waiting' && i.resourceId === resource.resourceId && i.date === isoDate && i.startTime === sl.startTime
            );
            if (mine) removeIntent(mine.id);
          } else {
            scheduleIntent({
              resource,
              facilityName: facilities[bookState.categoryIdx].facility_Name,
              date: bookState.date,
              startTime: sl.startTime,
              endTime: sl.endTime,
            });
          }
          refreshAvailability();
        });
      }
      grid.appendChild(slotBtn);
    }
    resultsWrap.replaceChildren(grid, buildScheduledList(refreshAvailability));
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
          resource: resourcePicker.value,
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
          cache.bookings = null; // invalidate so My Bookings refetches
          clearPersistedBookings();
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
        el('p', { class: 'fr-confirm-panel-title', text: compactTimeRange(slot.startTime, slot.endTime) }),
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
      resourcePicker.setOptions(facility.resources.map((r) => ({ value: r.resourceId, text: r.name })));
      resourcePicker.value = bookState.resourceId;
      refreshAvailability();
    });
    facilityList.appendChild(btn);
  });

  resourcePicker.setOptions(facilities[bookState.categoryIdx].resources.map((r) => ({ value: r.resourceId, text: r.name })));
  resourcePicker.value = bookState.resourceId;

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
  ui.contentEl.replaceChildren(page);

  refreshAvailability();
}
