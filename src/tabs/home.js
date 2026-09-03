// ---------------------------------------------------------------------
// 9. Home tab — today's classes, upcoming-days glance, upcoming bookings
// ---------------------------------------------------------------------

// Home keeps its own small nav state: which week the strip is paged to,
// and which single day within it is selected. Resets to today/this-week
// on every fresh visit to the tab (a glance view, not meant to remember
// where you left off).

import { callAura, resolveUserId } from '../aura.js';
import { addDays, cleanResourceName, dayLabel, formatBookingWhen, formatTime, parseBookingDateTime, sameDay, startOfToday, startOfWeekMonday } from '../dates.js';
import { el } from '../dom.js';
import { readPersisted, writePersisted } from '../persist.js';
import { buildDateStrip, renderEmpty, switchTab } from '../shell.js';
import { cache, ui } from '../state.js';

const homeState = { weekStart: startOfWeekMonday(startOfToday()), selected: startOfToday() };

// Home is the boot tab, so it is the one place where the wait is the
// first thing you see. It paints last launch's data immediately when
// there is any, then repaints with the real answer — the requests still
// go out every time, this only decides what is on screen while they fly.
//
// Calendar and My Bookings deliberately don't do this: by the time either
// is opened, Home's own revalidation has already filled the in-memory
// cache they read, so they are fast for free and a second stale-paint
// path would be complexity with nothing to buy.
export async function renderHome(token) {
  homeState.weekStart = startOfWeekMonday(startOfToday());
  homeState.selected = startOfToday();

  const stale = (!cache.events || !cache.bookings) ? readPersisted() : null;
  if (stale && stale.events && stale.bookings && token === ui.activeToken) {
    ui.contentEl.replaceChildren(buildHomePage(stale.events, stale.bookings));
  }

  const userId = await resolveUserId();
  const [events, bookings] = await Promise.all([
    cache.events ? Promise.resolve(cache.events) : callAura('StudentPortalCalendarCtrl', 'getAllScheduledEvents', { userId }),
    cache.bookings ? Promise.resolve(cache.bookings) : callAura('CustomBookingController', 'getReservations', { userId }),
  ]);
  cache.events = events;
  cache.bookings = bookings;
  writePersisted({ events, bookings });
  if (token !== ui.activeToken) return;

  // homeState is deliberately not reset here: if a day was tapped on the
  // strip while the fetch was in flight, the repaint keeps that choice
  // rather than yanking the view back to today under the finger.
  ui.contentEl.replaceChildren(buildHomePage(events, bookings));
}

function buildHomePage(events, bookings) {
  const page = el('div', { class: 'fr-page' });
  const title = el('h1', { class: 'fr-page-title', text: dayLabel(homeState.selected) });
  const stripWrap = el('div', {});
  const classesHeading = el('h2', { class: 'fr-group-heading', text: 'Classes' });
  const classesList = el('div', {});
  page.append(title, stripWrap, classesHeading, classesList);

  // The date strip is repainted on paging (prev/next week); the classes
  // list is repainted on selecting a day — both are pure client-side
  // filters over the already-fetched `events`, no refetch on click.
  function paintStrip() {
    stripWrap.replaceChildren(
      buildDateStrip({
        weekStart: homeState.weekStart,
        selected: homeState.selected,
        hasEvents: (day) => events.some((e) => sameDay(new Date(e.startDateTime), day)),
        onSelect: selectDate,
        onPrevWeek: () => {
          homeState.weekStart = addDays(homeState.weekStart, -7);
          paintStrip();
        },
        onNextWeek: () => {
          homeState.weekStart = addDays(homeState.weekStart, 7);
          paintStrip();
        },
      })
    );
  }

  function paintClasses() {
    title.textContent = dayLabel(homeState.selected);
    const dayEvents = events
      .filter((e) => sameDay(new Date(e.startDateTime), homeState.selected))
      .sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
    if (!dayEvents.length) {
      classesList.replaceChildren(renderEmpty('calendar', 'No classes', 'Nothing scheduled this day.', 'fr-empty--inline'));
      return;
    }
    const list = el('div', { class: 'fr-list' });
    for (const ev of dayEvents) {
      const row = el('div', { class: 'fr-row' });
      row.appendChild(el('span', { class: 'fr-row-time', text: formatTime(new Date(ev.startDateTime)) }));
      const main = el('div', { class: 'fr-row-main' });
      const courseTitle = ev.courseName || ev.title;
      main.appendChild(el('p', { class: 'fr-row-title', text: courseTitle, title: courseTitle }));
      const meta = [ev.room, ev.faculty ? `${ev.facultySalutation || ''} ${ev.faculty}`.trim() : null].filter(Boolean).join(' · ');
      // Appended even when empty: the meta line's height is what keeps
      // every row in the list the same height (see .fr-row-meta:empty).
      main.appendChild(el('p', { class: 'fr-row-meta', text: meta, title: meta }));
      row.appendChild(main);
      list.appendChild(row);
    }
    classesList.replaceChildren(list);
  }

  // Reused by buildDateStrip's cells and the prev/next buttons.
  function selectDate(day) {
    homeState.selected = day;
    paintStrip();
    paintClasses();
  }

  paintStrip();
  paintClasses();

  // Upcoming bookings — only shown when something is actually upcoming.
  const now = new Date();
  const upcomingBookings = bookings
    .filter((b) => b.status === 'Booked' && parseBookingDateTime(b.startDateTime) >= now)
    .sort((a, b) => parseBookingDateTime(a.startDateTime) - parseBookingDateTime(b.startDateTime))
    .slice(0, 5);
  if (upcomingBookings.length) {
    const bookingsSection = el('div', { style: 'margin-top: 32px;' });
    const headingRow = el('div', { class: 'fr-group-heading-row' });
    headingRow.appendChild(el('h2', { class: 'fr-group-heading', text: 'Upcoming bookings', style: 'margin: 0;' }));
    const seeAll = el('button', { class: 'fr-link-btn', type: 'button', text: 'See all' });
    seeAll.addEventListener('click', () => switchTab('bookings'));
    headingRow.appendChild(seeAll);
    bookingsSection.appendChild(headingRow);
    const list = el('div', { class: 'fr-list' });
    for (const b of upcomingBookings) {
      list.appendChild(
        el('div', { class: 'fr-row' }, [
          el('div', { class: 'fr-row-main' }, [
            el('p', { class: 'fr-row-title', text: cleanResourceName(b.resourceName), title: cleanResourceName(b.resourceName) }),
            el('p', { class: 'fr-row-meta', text: formatBookingWhen(b), title: formatBookingWhen(b) }),
          ]),
        ])
      );
    }
    bookingsSection.appendChild(list);
    page.appendChild(bookingsSection);
  }

  return page;
}
