// ---------------------------------------------------------------------
// 10. Calendar tab — real day/week grid, no date picker
// ---------------------------------------------------------------------

// Which day, and day-vs-week. Module-scope so the tab's own nav can
// re-render against it without a refetch.

import { callAura, resolveUserId } from '../aura.js';
import { addDays, dayLabel, sameDay, shortDate, startOfToday, startOfWeekMonday } from '../dates.js';
import { el } from '../dom.js';
import { buildDateStrip, buildDayNav } from '../shell.js';
import { cache, ui } from '../state.js';

const calState = { date: startOfToday(), mode: 'day' };

const CAL_START_HOUR = 9;
const CAL_END_HOUR = 19;
const CAL_HOUR_HEIGHT = 78;

// Greedy interval-graph lane packing so overlapping events sit side by
// side instead of stacking on top of each other.
function assignLanes(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const laneEnds = [];
  const placed = [];
  for (const it of sorted) {
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else {
      laneEnds[lane] = it.end;
    }
    placed.push({ ...it, lane });
  }
  const totalLanes = laneEnds.length || 1;
  return placed.map((p) => ({ ...p, totalLanes }));
}

function buildCalDayColumn(dayDate, events, isToday) {
  const col = el('div', { class: 'fr-cal-day-col' });
  const totalHours = CAL_END_HOUR - CAL_START_HOUR;
  const body = el('div', { class: 'fr-cal-body', style: `height: ${totalHours * CAL_HOUR_HEIGHT}px;` });
  for (let h = 0; h < totalHours; h++) body.appendChild(el('div', { class: 'fr-cal-hour-row' }));

  const dayEvents = events
    .filter((e) => sameDay(new Date(e.startDateTime), dayDate))
    .map((e) => ({ start: new Date(e.startDateTime), end: new Date(e.endDateTime), raw: e }));
  const laned = assignLanes(dayEvents);

  for (const item of laned) {
    const startFrac = item.start.getHours() + item.start.getMinutes() / 60 - CAL_START_HOUR;
    const endFrac = item.end.getHours() + item.end.getMinutes() / 60 - CAL_START_HOUR;
    const top = Math.max(0, startFrac) * CAL_HOUR_HEIGHT;
    const height = Math.max(20, (endFrac - Math.max(0, startFrac)) * CAL_HOUR_HEIGHT);
    const widthPct = 100 / item.totalLanes;
    const block = el('div', {
      class: 'fr-cal-event',
      style: `top:${top}px; height:${height}px; left:calc(${item.lane * widthPct}% + 3px); width:calc(${widthPct}% - 6px);`,
    });
    // Time is redundant with the block's own vertical position in the
    // grid — drop it and lead with venue instead. Every line clips
    // rather than wrapping: the block's height is the class's duration,
    // so a wrapped line is an overlap with the block below it. The full
    // untruncated text goes on the block's own title attribute.
    const courseName = item.raw.courseName || item.raw.title;
    const prof = item.raw.faculty ? `${item.raw.facultySalutation || ''} ${item.raw.faculty}`.trim() : '';
    block.title = [item.raw.room, courseName, prof].filter(Boolean).join(' · ');
    if (item.raw.room) block.appendChild(el('div', { class: 'fr-cal-event-venue', text: item.raw.room }));
    block.appendChild(el('div', { class: 'fr-cal-event-title', text: courseName }));
    if (prof) block.appendChild(el('div', { class: 'fr-cal-event-meta', text: prof }));
    body.appendChild(block);
  }

  if (isToday) {
    const now = new Date();
    const frac = now.getHours() + now.getMinutes() / 60 - CAL_START_HOUR;
    if (frac >= 0 && frac <= totalHours) {
      body.appendChild(el('div', { class: 'fr-cal-now-line', style: `top:${frac * CAL_HOUR_HEIGHT}px;` }));
    }
  }

  col.append(body);
  return col;
}

export async function renderCalendar(token) {
  const userId = await resolveUserId();
  if (!cache.events) cache.events = await callAura('StudentPortalCalendarCtrl', 'getAllScheduledEvents', { userId });
  const events = cache.events;
  if (token !== ui.activeToken) return;

  const page = el('div', { class: 'fr-page' });

  const days = calState.mode === 'week'
    ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeekMonday(calState.date), i))
    : [calState.date];

  // Mobile day view swaps the simple prev/next/label nav for the same
  // week-strip date picker Home uses — more useful than a single-day
  // stepper when you're already looking at one specific day.
  const isMobile = window.matchMedia('(max-width: 760px)').matches;
  const useDateStrip = isMobile && calState.mode === 'day';

  const titleText = useDateStrip ? dayLabel(calState.date) : 'Calendar';
  const titleEl = el('h1', { class: 'fr-page-title fr-cal-header-title', text: titleText });

  // events is cached above (see cache.events) and nothing else on this tab
  // needs a network round-trip, so date/mode nav re-renders the tab in
  // place instead of going through switchTab's full-page spinner + refetch.
  const rerender = () => renderCalendar(token);

  let navEl;
  if (useDateStrip) {
    navEl = buildDateStrip({
      weekStart: startOfWeekMonday(calState.date),
      selected: calState.date,
      hasEvents: (day) => events.some((e) => sameDay(new Date(e.startDateTime), day)),
      onSelect: (day) => {
        calState.date = day;
        rerender();
      },
      onPrevWeek: () => {
        calState.date = addDays(calState.date, -7);
        rerender();
      },
      onNextWeek: () => {
        calState.date = addDays(calState.date, 7);
        rerender();
      },
    });
  } else {
    const label = calState.mode === 'week' ? `${shortDate(days[0])} – ${shortDate(days[6])}` : dayLabel(calState.date);
    navEl = buildDayNav({
      label,
      onPrev: () => {
        calState.date = addDays(calState.date, calState.mode === 'week' ? -7 : -1);
        rerender();
      },
      onNext: () => {
        calState.date = addDays(calState.date, calState.mode === 'week' ? 7 : 1);
        rerender();
      },
      onToday: () => {
        calState.date = startOfToday();
        rerender();
      },
    });
  }
  navEl.classList.add('fr-cal-header-nav');

  const viewToggle = el('div', { class: 'fr-view-toggle fr-cal-header-toggle' });
  const dayBtn = el('button', { type: 'button', text: 'Day' });
  const weekBtn = el('button', { type: 'button', text: 'Week' });
  dayBtn.classList.toggle('is-active', calState.mode === 'day');
  weekBtn.classList.toggle('is-active', calState.mode === 'week');
  dayBtn.addEventListener('click', () => {
    calState.mode = 'day';
    rerender();
  });
  weekBtn.addEventListener('click', () => {
    calState.mode = 'week';
    rerender();
  });
  viewToggle.append(dayBtn, weekBtn);

  const header = el('div', { class: 'fr-cal-header' });
  header.append(titleEl, navEl, viewToggle);
  page.appendChild(header);

  const calWrap = el('div', { class: 'fr-cal-wrap' });
  const calScroll = el('div', { class: 'fr-cal-scroll' });
  const gutter = el('div', { class: 'fr-cal-gutter', style: `--fr-hour-h: ${CAL_HOUR_HEIGHT}px;` });
  // Week mode's day columns each carry a 40px .fr-cal-day-header, so the
  // gutter needs a matching blank spacer to keep hours aligned with the
  // grid below it. Day mode has no such header on its column — adding
  // the spacer there instead pushes every hour label down with nothing
  // to align to, which is exactly the "hours don't line up" bug.
  if (calState.mode === 'week') gutter.appendChild(el('div', { class: 'fr-cal-gutter-header' }));
  for (let h = CAL_START_HOUR; h < CAL_END_HOUR; h++) {
    const label12 = new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
    const cls = h === CAL_START_HOUR ? 'fr-cal-hour-label fr-cal-hour-label--first' : 'fr-cal-hour-label';
    gutter.appendChild(el('div', { class: cls }, [el('span', { text: label12 })]));
  }

  // Week mode gets a min-width floor per column so narrow (mobile)
  // viewports scroll the grid horizontally instead of crushing 7 columns
  // down to unreadable widths; day mode has just one column and should
  // still fill the available width naturally. Wide enough that real venue
  // names (e.g. "APJ Abdul Kalam 102") sit on one line instead of wrapping
  // and blowing past the block's fixed height — the view already scrolls
  // horizontally on mobile, so there's no cost to the extra width.
  const daysMinWidth = calState.mode === 'week' ? `min-width: ${days.length * 150}px;` : '';
  const daysWrap = el('div', {
    class: 'fr-cal-days',
    style: `grid-template-columns: repeat(${days.length}, 1fr); --fr-hour-h: ${CAL_HOUR_HEIGHT}px; ${daysMinWidth}`,
  });
  for (const d of days) {
    const isToday = sameDay(d, startOfToday());
    if (calState.mode === 'week') {
      const header = el('div', { class: `fr-cal-day-header${isToday ? ' is-today' : ''}` });
      header.append(
        el('div', { text: d.toLocaleDateString(undefined, { weekday: 'short' }) }),
        el('div', { text: String(d.getDate()) })
      );
      const colWrap = el('div', {});
      colWrap.appendChild(header);
      colWrap.appendChild(buildCalDayColumn(d, events, isToday));
      daysWrap.appendChild(colWrap);
    } else {
      daysWrap.appendChild(buildCalDayColumn(d, events, isToday));
    }
  }

  calScroll.append(gutter, daysWrap);
  calWrap.appendChild(calScroll);
  page.appendChild(calWrap);
  ui.contentEl.replaceChildren(page);
}
