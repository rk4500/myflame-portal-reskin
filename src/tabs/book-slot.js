// ---------------------------------------------------------------------
// 13. Book Slot tab — facility rail + auto-checked availability + submit
// ---------------------------------------------------------------------

import { callAura, resolveUserId } from '../aura.js';
import { BOOKING_WINDOW_MS, buildScheduledList, conflictingIntent, existingBookingFor, futureDailyIntents, knownSlotTimes, loadIntents, parseClockMinutes, relativeFuture, rememberSlotTimes, removeIntent, scheduleIntent, showNotice, slotStartDate, slotTimeKey } from '../autobook.js';
import { addDays, cleanResourceName, compactTimeRange, dayLabel, formatBookingWhen, isoDateLocal, sameDay, startOfToday } from '../dates.js';
import { clearPersistedBookings, readPersistedResources, sameData, writePersistedResources } from '../persist.js';
import { el, skel } from '../dom.js';
import { buildDayNav, buildPicker, buildSwitch, renderEmpty } from '../shell.js';
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

// A resource's day is spent when its slot times are known and every one of
// them has already started. That is knowable locally — knownSlotTimes reads
// the operating window out of the resource's own name — so it is an answer,
// not a guess, and the grid never has to ask the server for it.
//
// An unparseable time makes every() false rather than true: not knowing is
// not the same as knowing it is over, and the request is the right move then.
function windowSpent(resource, isoDate, nowMs) {
  const known = knownSlotTimes(resource);
  if (!known.length) return false;
  return known.every((sl) => {
    const start = slotStartDate(isoDate, sl.startTime);
    return !!start && start.getTime() <= nowMs;
  });
}

// Default to a window the user can actually act on. The resource list is
// sorted by start time, so resources[0] is the *earliest* window — which
// after 1 pm is the one gym option guaranteed to be over. Picking the first
// live one instead is what keeps the common case ("book the gym") from
// opening on a dead end.
function firstLiveResource(facility, isoDate, nowMs) {
  if (!facility || !facility.resources.length) return null;
  return facility.resources.find((r) => !windowSpent(r, isoDate, nowMs)) || facility.resources[0];
}

// The confirm panel is appended below the slot grid, usually past the fold,
// and it is the last thing on the page — so selecting a slot scrolls the
// whole page to the bottom, which is what the panel opening should feel
// like. scrollIntoView could not do this: `block: 'end'` aligns the button
// with the bottom of the scrollport, which on mobile is exactly where the
// fixed nav bar sits, so the button landed underneath it. Going to the
// bottom is safe because .fr-content's own bottom padding (96px + the nav
// bar inset on mobile) is more than the bar's height, so the end of the
// content parks above it rather than behind it — and confirmScrollDelta
// verifies exactly that rather than trusting the arithmetic.
const CONFIRM_SCROLL_GAP = 12;
const CONFIRM_SCROLL_SETTLE_MS = 400;

// How far the scroller has to move for `target` to sit fully inside the
// part of it nothing is covering. Positive scrolls down. 0 means it is
// already there, which is also the answer once a scroll has landed.
function confirmScrollDelta(scroller, target) {
  const nav = document.querySelector('.fr-nav');
  // Only a fixed nav bar overlaps the scroller — the desktop bar is in
  // normal flow above it and takes nothing away from the view.
  const covered = nav && getComputedStyle(nav).position === 'fixed'
    ? nav.getBoundingClientRect().height
    : 0;
  const view = scroller.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const topEdge = view.top + CONFIRM_SCROLL_GAP;
  const bottomEdge = view.bottom - covered - CONFIRM_SCROLL_GAP;

  let delta = 0;
  if (box.bottom > bottomEdge) delta = box.bottom - bottomEdge;
  else if (box.top < topEdge) delta = box.top - topEdge;
  // A panel taller than the view can't fit whole; keep its top on screen
  // rather than scrolling the header off to chase the bottom.
  if (delta > 0 && box.top - delta < topEdge) delta = box.top - topEdge;
  return Math.abs(delta) < 1 ? 0 : delta;
}

function scrollConfirmIntoView(target) {
  const scroller = target.closest('.fr-content');
  if (!scroller) {
    target.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    return;
  }

  const bottomOf = () => scroller.scrollHeight - scroller.clientHeight;

  // Issued synchronously, and deliberately not from inside
  // requestAnimationFrame: the panel is already in the document by the
  // time this is called, and reading layout flushes it anyway, so there is
  // nothing a frame would add — while rAF is not dependable here at all.
  // It goes unserviced whenever this WebView decides it has nothing to
  // paint (the same starvation that deadlocked the cold-launch cover; the
  // harness reproduces it, and the scroll simply never ran).
  scroller.scrollTo({ top: bottomOf(), behavior: 'smooth' });

  // Smooth scrolling is a request, not a guarantee: Android WebView drops
  // it some of the time (headless Chrome ignores it outright), and the
  // grid above can still reflow after the panel opens, moving the bottom
  // after the scroll was aimed at it — which together are why this landed
  // short from some slot rows before. So look at where it actually ended
  // up and finish the job without animation, unless the user has taken
  // over, in which case their scroll wins and we leave it alone.
  let taken = false;
  const takeOver = () => { taken = true; };
  const opts = { passive: true, once: true };
  scroller.addEventListener('touchstart', takeOver, opts);
  scroller.addEventListener('wheel', takeOver, opts);
  setTimeout(() => {
    scroller.removeEventListener('touchstart', takeOver);
    scroller.removeEventListener('wheel', takeOver);
    if (taken || !target.isConnected) return;
    const bottom = bottomOf();
    if (scroller.scrollTop < bottom - 1) scroller.scrollTop = bottom;
    // The bottom is the intent; the button being visible is the
    // requirement. If some future layout ever puts the two in conflict,
    // this is what keeps the button reachable.
    const left = confirmScrollDelta(scroller, target);
    if (left) scroller.scrollTop += left;
  }, CONFIRM_SCROLL_SETTLE_MS);
}

async function fetchFacilities() {
  const raw = await callAura('CustomBookingController', 'getResources', null, true);
  return JSON.parse(raw).map((f) => ({ ...f, resources: sortResources(f.resources || []) }));
}

export async function renderBookSlot(token) {
  if (!bookState.facilities) {
    // Everything above the slot grid — the facility rail, the resource
    // picker, the day nav — is drawn from this one list, and the list is
    // the same all semester. Waiting on a round trip to draw a rail whose
    // contents never change is the whole reason this tab used to open on
    // a blank page. So last week's copy paints now and the request still
    // goes out; only an answer that differs is allowed to touch the UI.
    const cached = readPersistedResources();
    if (cached) {
      bookState.facilities = cached;
      fetchFacilities()
        .then((fresh) => {
          if (!fresh || !fresh.length || sameData(fresh, bookState.facilities)) return;
          bookState.facilities = fresh;
          writePersistedResources(fresh);
          // Rare enough to be worth a plain repaint: a resource was added
          // or renamed, which changes the rail and the picker together.
          // Not a loop — facilities is set, so this returns straight past
          // the branch it is standing in.
          if (token === ui.activeToken) renderBookSlot(token);
        })
        .catch(() => {
          // A failed revalidation leaves the cached list on screen, which
          // is the same list the portal had a moment ago.
        });
    } else {
      bookState.facilities = await fetchFacilities();
      writePersistedResources(bookState.facilities);
    }
  }
  const facilities = bookState.facilities;
  if (token !== ui.activeToken) return;
  if (!bookState.resourceId && facilities[bookState.categoryIdx]) {
    const live = firstLiveResource(facilities[bookState.categoryIdx], isoDateLocal(bookState.date), Date.now());
    bookState.resourceId = live.resourceId;
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
  const resultsWrap = el('div', {});
  const confirmWrap = el('div', {});
  rightCol.append(resultsWrap, confirmWrap);

  function currentResource() {
    const facility = facilities[bookState.categoryIdx];
    return (facility && facility.resources.find((r) => r.resourceId === resourcePicker.value)) || null;
  }

  function currentResourceName() {
    const facility = facilities[bookState.categoryIdx];
    const r = facility && facility.resources.find((r) => r.resourceId === resourcePicker.value);
    return r ? r.name : '';
  }

  // A slot card as a box, before anything is known about it. The times
  // are not a guess: knownSlotTimes derives them from the resource's own
  // operating window ("Gym ( 6:00 am to 2:00 pm slot )" is eight hourly
  // slots), falling back to whatever that resource last offered. So the
  // grid can be drawn with real labels, in the real number of cards, and
  // only the capacity line — the one thing that genuinely needs the
  // server — is left shimmering.
  function createSlotShell(sl) {
    const btn = el('button', { class: 'fr-slot fr-slot--skeleton', type: 'button', disabled: '' });
    btn.dataset.start = slotTimeKey(sl.startTime);
    btn.append(
      el('span', { class: 'fr-slot-time', text: compactTimeRange(sl.startTime, sl.endTime) }),
      el('span', { class: 'fr-slot-cap' }, [skel(7)])
    );
    return btn;
  }

  // The window this resource covers, as the day nav writes it — "6 AM – 2 PM"
  // — built from the resource's own slot times rather than re-parsing its
  // name, so it matches the cards the grid would have drawn.
  function windowLabel(resource) {
    const known = knownSlotTimes(resource);
    if (!known.length) return cleanResourceName(resource.name);
    return compactTimeRange(known[0].startTime, known[known.length - 1].endTime);
  }

  // The same facility's other window for the same thing: the 3 PM gym when
  // the 6 AM gym is over. Matched on the resource *class* — the name without
  // its window suffix — so a spent gym never offers a squash court.
  function liveSiblingWindow(resource, isoDate, nowMs) {
    const facility = facilities[bookState.categoryIdx];
    if (!facility) return null;
    const klass = cleanResourceName(resource.name).toLowerCase();
    return facility.resources.find((r) => (
      r.resourceId !== resource.resourceId
      && cleanResourceName(r.name).toLowerCase() === klass
      && !windowSpent(r, isoDate, nowMs)
    )) || null;
  }

  // Every slot this resource has for this day is already behind us, and that
  // was knowable without asking. Drawn immediately: no skeleton (there is
  // nothing truthful to predict), no spinner, and no request whose only
  // possible answer is an empty list.
  function renderWindowSpent(resource, isoDate, nowMs) {
    const sibling = liveSiblingWindow(resource, isoDate, nowMs);
    const action = sibling
      ? {
        label: `Switch to ${windowLabel(sibling)}`,
        onClick: () => {
          bookState.resourceId = sibling.resourceId;
          resourcePicker.value = sibling.resourceId;
          refreshAvailability();
        },
      }
      : {
        label: 'Try tomorrow',
        onClick: () => {
          bookState.date = addDays(bookState.date, 1);
          renderDayNav();
          paintResourceOptions();
          refreshAvailability();
        },
      };
    resultsWrap.replaceChildren(
      renderEmpty(
        'clock',
        `${windowLabel(resource)} is bookable from tomorrow`,
        '',
        'fr-empty--inline',
        action
      ),
      buildScheduledList(refreshAvailability)
    );
  }

  async function refreshAvailability() {
    confirmWrap.replaceChildren();
    const resource = currentResource();
    const isoDate = isoDateLocal(bookState.date);

    if (resource && windowSpent(resource, isoDate, Date.now())) {
      renderWindowSpent(resource, isoDate, Date.now());
      return;
    }

    // The scheduled-autobook list below the grid is read out of
    // localStorage, so it is drawn now rather than after a request it
    // never needed. When the resource's slot times can't be predicted at
    // all, there is nothing truthful to draw and the spinner is still the
    // honest answer.
    // A slot whose start is already behind us cannot be booked, and the
    // portal does not list it, so predicting it means drawing cards that
    // vanish the moment the answer lands — half the grid disappearing on
    // an afternoon open. Same predicate the known-slot fill below uses.
    const nowMs = Date.now();
    const expected = resource
      ? knownSlotTimes(resource).filter((sl) => {
          const start = slotStartDate(isoDate, sl.startTime);
          return !start || start.getTime() > nowMs;
        })
      : [];
    let grid = null;
    if (expected.length) {
      grid = el('div', { class: 'fr-slot-grid', 'aria-busy': 'true' });
      for (const sl of expected) grid.appendChild(createSlotShell(sl));
      // The claim note is drawn now for the same reason the scheduled
      // list is: it comes from an intent in localStorage, not from the
      // request. Leaving it out until the answer lands would push the
      // whole grid down a line at exactly the wrong moment.
      resultsWrap.replaceChildren(
        ...(claimNoteFor(resource, isoDate) ? [claimNoteFor(resource, isoDate)] : []),
        grid,
        buildScheduledList(refreshAvailability)
      );
    } else {
      resultsWrap.replaceChildren(el('div', { class: 'fr-loading', style: 'padding: 40px 0;' }, [el('div', { class: 'fr-spinner' })]));
    }
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
    // Keyed on the minute, not on the text: a derived "6:00 am" and the
    // portal's "6:00 AM" are the same slot, and comparing the strings drew
    // both of them.
    const bookable = new Map(slots.map((sl) => [slotTimeKey(sl.startTime), sl]));
    const timeline = [];
    for (const sl of slots) {
      const start = slotStartDate(isoDate, sl.startTime);
      const opensAt = start ? start.getTime() - BOOKING_WINDOW_MS : 0;
      const isOpenWindow = opensAt <= now;
      timeline.push({ ...sl, kind: isOpenWindow ? 'open' : 'later', opensAt });
    }
    for (const known of knownSlotTimes(resource)) {
      if (bookable.has(slotTimeKey(known.startTime))) continue;
      const start = slotStartDate(isoDate, known.startTime);
      if (!start || start.getTime() <= now) continue; // already gone today
      timeline.push({ ...known, kind: 'later', opensAt: start.getTime() - BOOKING_WINDOW_MS });
    }
    timeline.sort((a, b) => (parseClockMinutes(a.startTime) || 0) - (parseClockMinutes(b.startTime) || 0));

    if (!timeline.length) {
      resultsWrap.replaceChildren(
        serverMessage
          ? renderEmpty('clock', 'Nothing to book here', serverMessage, 'fr-empty--inline')
          : renderEmpty('clock', 'No open slots', 'Every slot for this day is taken or past.', 'fr-empty--inline', {
            label: 'Try tomorrow',
            onClick: () => {
              bookState.date = addDays(bookState.date, 1);
              renderDayNav();
              paintResourceOptions();
              refreshAvailability();
            },
          }),
        buildScheduledList(refreshAvailability)
      );
      return;
    }

    // Fill the cards that are already on screen rather than building a
    // second grid and swapping it in: same nodes, same positions, so the
    // answer arriving changes the words inside the cards and nothing else.
    // A card is only created here when the skeleton could not predict it.
    const shells = new Map();
    if (grid) for (const node of grid.children) shells.set(node.dataset.start, node);
    const ordered = [];
    for (const sl of timeline) {
      const slotBtn = shells.get(slotTimeKey(sl.startTime)) || createSlotShell(sl);
      shells.delete(slotTimeKey(sl.startTime));
      ordered.push(slotBtn);
      slotBtn.classList.remove('fr-slot--skeleton');
      slotBtn.classList.toggle('fr-slot--later', sl.kind === 'later');
      slotBtn.disabled = false;
      const cap = slotBtn.querySelector('.fr-slot-cap');
      // One auto-booking per resource class per day: if any waiting
      // intent already claims this class on this date, only the tile it
      // belongs to stays interactive. The rest say why they are inert
      // instead of accepting a tap that could never become a booking.
      // The claim is a property of the day, not of the tile's kind. This
      // used to be computed only for 'later' tiles, so an open slot on a
      // day already claimed by an autobook looked perfectly bookable.
      const claimedBy = conflictingIntent(resource.name, isoDate);
      // "Scheduled" means this exact slot on this exact day. A daily
      // series reaching forward from an earlier day claims the day too,
      // but it is not this tile's intent and must not offer to cancel it.
      const scheduled = !!claimedBy && claimedBy.date === isoDate
        && claimedBy.resourceId === resource.resourceId && slotTimeKey(claimedBy.startTime) === slotTimeKey(sl.startTime);
      const bySeries = !!claimedBy && claimedBy.date !== isoDate;
      // Two different answers for the two kinds. A second *autobook* on a
      // claimed day can never succeed, so it is refused outright. A manual
      // booking still can — it just costs the day, so it warns and stops
      // the pending intent instead of being blocked.
      const blocked = !!claimedBy && !scheduled && sl.kind === 'later';
      const warnsClaim = !!claimedBy && !scheduled && sl.kind === 'open';
      // A 'later' tile exists because availability did not list the slot.
      // Usually that means its 24h window has not opened; but when the
      // portal returns nothing at all for a resource, slots inside the
      // window land here too, and "Opens now" is a nonsense caption for
      // them. They are simply not on offer, and all autobook can do is
      // keep checking.
      const windowOpen = sl.kind === 'later' && sl.opensAt <= Date.now();
      // Truthful even when memory was wrong about this resource's hours.
      slotBtn.querySelector('.fr-slot-time').textContent = compactTimeRange(sl.startTime, sl.endTime);
      if (sl.kind === 'open') {
        cap.replaceChildren();
        cap.textContent = `${sl.availableCapacity} left`;
        if (sl.availableCapacity <= 0) slotBtn.disabled = true;
        slotBtn.addEventListener('click', () => {
          grid.querySelectorAll('.fr-slot').forEach((b) => b.classList.remove('is-selected'));
          slotBtn.classList.add('is-selected');
          openConfirm(sl, warnsClaim ? claimedBy : null);
        });
      } else {
        cap.replaceChildren();
        // A blocked tile says nothing at all. The reason is identical on
        // every one of them, so printing it down a whole grid is noise;
        // it is stated once above the grid, and again on tap.
        cap.textContent = scheduled ? 'Auto-booking ✓'
          : windowOpen ? 'Slots full'
          : `Opens ${relativeFuture(sl.opensAt)}`;
        slotBtn.classList.toggle('is-scheduled', scheduled);
        if (blocked) {
          // Not `disabled`: a disabled button never fires a click, and
          // this one has something to say. Looks unavailable, is marked
          // up as unavailable, still answers when tapped.
          slotBtn.classList.add('is-blocked');
          slotBtn.setAttribute('aria-disabled', 'true');
          slotBtn.title = blockedReason(claimedBy, bySeries);
        }
        let cancelTimer = null;
        let confirmingCancel = false;

        function resetCancelState() {
          if (!confirmingCancel) return;
          confirmingCancel = false;
          if (cancelTimer) {
            clearTimeout(cancelTimer);
            cancelTimer = null;
          }
          slotBtn.classList.remove('is-confirming-cancel');
          const cap = slotBtn.querySelector('.fr-slot-cap');
          if (cap) cap.textContent = 'Auto-booking ✓';
          document.removeEventListener('click', handleOutsideClick);
        }

        function handleOutsideClick(e) {
          if (!slotBtn.contains(e.target)) {
            resetCancelState();
          }
        }

        slotBtn.addEventListener('click', () => {
          if (blocked) {
            showNotice({
              title: bySeries ? 'Covered by a daily autobook' : 'Already scheduled that day',
              note: blockedReason(claimedBy, bySeries),
            });
            return;
          }
          if (scheduled) {
            const mine = loadIntents().find(
              (i) => i.state === 'waiting' && i.resourceId === resource.resourceId && i.date === isoDate && slotTimeKey(i.startTime) === slotTimeKey(sl.startTime)
            );
            if (!mine) return;

            if (!confirmingCancel) {
              confirmingCancel = true;
              slotBtn.classList.add('is-confirming-cancel');
              const cap = slotBtn.querySelector('.fr-slot-cap');
              if (cap) cap.textContent = 'Tap again to stop';

              setTimeout(() => {
                if (confirmingCancel) document.addEventListener('click', handleOutsideClick);
              }, 0);

              cancelTimer = setTimeout(() => {
                resetCancelState();
              }, 3000);
              return;
            }

            resetCancelState();
            removeIntent(mine.id);
            refreshAvailability();
            return;
          }
          grid.querySelectorAll('.fr-slot').forEach((b) => b.classList.remove('is-selected'));
          slotBtn.classList.add('is-selected');
          openAutoConfirm(sl, windowOpen);
        });
      }
    }
    // Whatever the skeleton predicted and the day did not have simply
    // does not make it into `ordered`, so this drops it.
    if (grid) grid.replaceChildren(...ordered);
    else grid = el('div', { class: 'fr-slot-grid' }, ordered);
    grid.removeAttribute('aria-busy');
    const claimNote = claimNoteFor(resource, isoDate);
    resultsWrap.replaceChildren(
      ...(claimNote ? [claimNote] : []),
      grid,
      buildScheduledList(refreshAvailability)
    );
  }

  // Said once, above the grid, so the greying is not a mystery until
  // something is tapped. Known without asking the portal anything — the
  // claim is an intent of ours, sitting in localStorage.
  function claimNoteFor(resource, isoDate) {
    const dayClaim = resource ? conflictingIntent(resource.name, isoDate) : null;
    return dayClaim
      ? el('p', { class: 'fr-slot-notice', text: blockedReason(dayClaim, dayClaim.date !== isoDate) })
      : null;
  }

  // One wording, three places: the tooltip, the tap notice, and the line
  // above the grid. Concise explanation with no repeated date or slot details.
  function blockedReason(claim, bySeries) {
    return bySeries
      ? 'A daily autobook already covers this day. Stop it below to book this day yourself.'
      : 'An autobook is already scheduled for this day. Stop it below to book this day yourself.';
  }

  function openConfirm(slot, claimedBy) {
    // currentResource(), not `resource`: that binding is local to
    // refreshAvailability and this is a sibling of it, not a child.
    const resource = currentResource();
    // Purpose/co-attendee only make sense for a room booking (who's
    // meeting, why) — a gym or pool slot doesn't need either, so skip
    // the fields entirely for Sports Facilities rather than showing
    // inputs with nothing meaningful to fill in.
    const facility = facilities[bookState.categoryIdx];
    const needsDetails = facility.facility_Name !== 'Sports Facilities';
    const purposeInput = needsDetails
      ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Purpose' })
      : null;
    const attendeeInput = needsDetails
      ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Co-attendee' })
      : null;
    const submitBtn = el('button', { class: 'fr-btn fr-btn--primary fr-confirm-submit', type: 'button', text: 'Confirm booking' });

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
          // This booking just spent the day's one allowance, so a pending
          // autobook for the same resource that day can only fail now.
          // Clearing it here is the promise the warning above made.
          if (claimedBy) removeIntent(claimedBy.id);
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

    // Ask before acting. The portal refuses a second booking of the same
    // resource class on the same day, and that refusal used to arrive as a
    // red error panel after a request that was never going to work. The
    // answer is already in the bookings list, so read it there.
    const conflictSlot = el('div', { class: 'fr-confirm-note' });
    existingBookingFor(resource.name, isoDateLocal(bookState.date))
      .then((booked) => {
        if (!booked) return;
        submitBtn.disabled = true;
        conflictSlot.className = 'fr-confirm-warn';
        conflictSlot.textContent =
          `Already booked ${cleanResourceName(resource.name)} ${formatBookingWhen(booked)} — one booking a day.`;
      })
      .catch(() => {
        // A failed lookup must not block a booking that might be fine;
        // the portal is still the authority and will say no if it must.
      });

    const warning = claimedBy
      ? el('p', {
          class: 'fr-confirm-warn',
          text: `Stops your ${compactTimeRange(claimedBy.startTime, claimedBy.endTime || claimedBy.startTime)} autobook — one booking a day.`,
        })
      : null;

    const header = el('div', { class: 'fr-confirm-header' }, [
      el('p', { class: 'fr-confirm-panel-title', text: `Book ${compactTimeRange(slot.startTime, slot.endTime)}` }),
    ]);

    const inputsWrap = (purposeInput || attendeeInput)
      ? el('div', { class: 'fr-confirm-inputs' }, [
          ...(purposeInput ? [purposeInput] : []),
          ...(attendeeInput ? [attendeeInput] : []),
        ])
      : null;

    confirmWrap.replaceChildren(
      el('div', { class: 'fr-confirm-panel' }, [
        header,
        ...(inputsWrap ? [inputsWrap] : []),
        ...(warning ? [warning] : []),
        conflictSlot,
        submitBtn,
      ])
    );
    scrollConfirmIntoView(submitBtn);
  }

  // The autobook twin of openConfirm. Same panel, same fields, because it
  // ends in the same createReservation call — just made later, by the
  // runner, from what is captured here.
  function openAutoConfirm(slot, windowOpen) {
    const resource = currentResource();
    if (!resource) return;
    const facility = facilities[bookState.categoryIdx];
    const needsDetails = facility.facility_Name !== 'Sports Facilities';
    const purposeInput = needsDetails
      ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Purpose' })
      : null;
    const attendeeInput = needsDetails
      ? el('input', { class: 'fr-input', type: 'text', placeholder: 'Co-attendee' })
      : null;
    const isoDate = isoDateLocal(bookState.date);
    const futures = futureDailyIntents(resource.name, isoDate);
    const clashWarn = el('p', { class: 'fr-confirm-warn' });
    clashWarn.style.display = 'none';

    function updateClashWarn() {
      if (repeatSwitch.checked && futures.length > 0) {
        const first = futures[0];
        const parts = first.date.split('-').map(Number);
        const firstDate = new Date(parts[0], parts[1] - 1, parts[2]);
        clashWarn.textContent = `Replaces daily autobook from ${dayLabel(firstDate)} (${compactTimeRange(first.startTime, first.endTime)}).`;
        clashWarn.style.display = 'block';
      } else {
        clashWarn.style.display = 'none';
      }
    }

    const repeatSwitch = buildSwitch({ label: 'Daily', onChange: updateClashWarn });
    updateClashWarn();

    const submitBtn = el('button', { class: 'fr-btn fr-btn--primary fr-confirm-submit', type: 'button', text: 'Autobook' });

    const header = el('div', { class: 'fr-confirm-header' }, [
      el('p', { class: 'fr-confirm-panel-title', text: `Autobook ${compactTimeRange(slot.startTime, slot.endTime)}` }),
      repeatSwitch.el,
    ]);

    // What scheduling actually promises, said plainly. It watches and
    // retries; it does not reserve anything, and a full slot stays full
    // until somebody cancels.
    const note = el('p', {
      class: 'fr-confirm-note',
      text: windowOpen ? 'Currently full. Auto-checks for cancellations.'
                       : 'Attempts booking as soon as window opens.',
    });

    submitBtn.addEventListener('click', () => {
      const intent = scheduleIntent({
        resource,
        facilityName: facility.facility_Name,
        date: bookState.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        purpose: purposeInput ? purposeInput.value || '' : '',
        coAttendee: attendeeInput ? attendeeInput.value || '' : '',
        repeat: repeatSwitch.checked ? 'daily' : null,
      });
      confirmWrap.replaceChildren();
      if (!intent) {
        // scheduleIntent refuses a second one for the same resource class
        // and day; say so rather than silently doing nothing.
        confirmWrap.replaceChildren(
          el('div', {
            class: 'fr-error-panel',
            text: `You already have an autobook waiting for ${cleanResourceName(resource.name)} that day.`,
          })
        );
      }
      refreshAvailability();
    });

    const inputsWrap = (purposeInput || attendeeInput)
      ? el('div', { class: 'fr-confirm-inputs' }, [
          ...(purposeInput ? [purposeInput] : []),
          ...(attendeeInput ? [attendeeInput] : []),
        ])
      : null;

    confirmWrap.replaceChildren(
      el('div', { class: 'fr-confirm-panel' }, [
        header,
        ...(inputsWrap ? [inputsWrap] : []),
        note,
        clashWarn,
        submitBtn,
      ])
    );
    scrollConfirmIntoView(submitBtn);
  }

  facilities.forEach((facility, idx) => {
    const btn = el('button', { class: 'fr-facility-item', type: 'button', text: facility.facility_Name });
    btn.classList.toggle('is-active', idx === bookState.categoryIdx);
    btn.addEventListener('click', () => {
      bookState.categoryIdx = idx;
      const live = firstLiveResource(facility, isoDateLocal(bookState.date), Date.now());
      bookState.resourceId = live.resourceId;
      facilityList.querySelectorAll('.fr-facility-item').forEach((b, i) => b.classList.toggle('is-active', i === idx));
      paintResourceOptions();
      resourcePicker.value = bookState.resourceId;
      refreshAvailability();
    });
    facilityList.appendChild(btn);
  });

  // Repainted on a date step as well as a facility change: "over for today"
  // is true of a resource *on a date*, and stepping to tomorrow makes the
  // 6 am gym live again.
  function paintResourceOptions() {
    const facility = facilities[bookState.categoryIdx];
    const isoDate = isoDateLocal(bookState.date);
    const nowMs = Date.now();
    resourcePicker.setOptions(facility.resources.map((r) => ({
      value: r.resourceId,
      text: r.name,
      note: windowSpent(r, isoDate, nowMs) ? 'Bookable tomorrow' : '',
    })));
  }

  paintResourceOptions();
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
          paintResourceOptions();
          refreshAvailability();
        },
        onNext: () => {
          bookState.date = addDays(bookState.date, 1);
          renderDayNav();
          paintResourceOptions();
          refreshAvailability();
        },
        onToday: () => {
          bookState.date = startOfToday();
          renderDayNav();
          paintResourceOptions();
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
