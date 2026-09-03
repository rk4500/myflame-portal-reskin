// Date and time formatting.
//
// All of it is local-time by construction: input[type=date].valueAsDate
// and toISOString() both work in UTC, which silently shows yesterday near
// midnight in IST. Nothing here touches either.

export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startOfWeekMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  return addDays(d, diffToMonday);
}

export function dayLabel(date) {
  const today = startOfToday();
  const diffDays = Math.round((date - today) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

// dayLabel's long weekday ("Wednesday, Sep 10") is right for a page
// heading but too wide for a booking row, where it shares one line with a
// time range, a status pill and a button — that overflow is what pushed
// the closing AM/PM onto a second line and made the box taller.
export function shortDayLabel(date) {
  // Compare date-to-date: a booking carries a time of day, and measuring
  // that against midnight rounded a 4 PM booking tomorrow to 2 days out
  // ("Thu, Sep 3") while a 7 AM one the same day landed on "Tomorrow".
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((day - startOfToday()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// "9:00 AM" + "10:00 AM" -> "9 AM \u2013 10 AM". Only the on-the-hour ":00"
// goes: a slot tile two-up on a 390px screen has ~130px of text width, and
// "10:00 AM \u2013 11:00 AM" needs more than that, so its trailing meridiem
// wrapped to a second line and made that one tile taller than every other
// tile in the grid (same in a booking row, where the range shares a line
// with a status pill and a button). Both meridiems always stay — dropping
// the leading one when the range didn't cross noon fit even better but read
// as too clipped, and made a range's two ends look unlike each other.
// A :15/:30 slot keeps its minutes; any format this doesn't recognise is
// left alone.
const ZERO_MINUTES_RE = /^(\d{1,2}):00(?=[\s\u00a0\u202f]*[AaPp]|$)/;
export function compactTimeRange(startStr, endStr) {
  const start = String(startStr).replace(ZERO_MINUTES_RE, '$1');
  const end = String(endStr).replace(ZERO_MINUTES_RE, '$1');
  return `${start} \u2013 ${end}`;
}

export function shortDate(date) {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTimeRange(startISO, endISO) {
  const fmt = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${fmt(new Date(startISO))} – ${fmt(new Date(endISO))}`;
}

export function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Bookings' dates come back as "31/08/2026, 9:00 AM" (dd/mm/yyyy) strings.
export function parseBookingDateTime(s) {
  const [datePart, timePart] = s.split(', ');
  const [d, m, y] = datePart.split('/').map(Number);
  return new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${timePart}`);
}

// A booking spans a single day, so the raw "start – end" strings (each a
// full date+time) repeat the date for no reason. State it once.
export function formatBookingWhen(booking) {
  const start = parseBookingDateTime(booking.startDateTime);
  const end = parseBookingDateTime(booking.endDateTime);
  return `${shortDayLabel(start)} · ${compactTimeRange(formatTime(start), formatTime(end))}`;
}

// resourceName carries the facility's whole operating window as a
// parenthetical suffix, e.g. "Gym ( 6:00 am to 2:00 pm slot )" — that's
// the facility's general open hours, not this reservation, and the actual
// booked time is already shown via formatBookingWhen. Drop the noise.
export function cleanResourceName(name) {
  return (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// input[type=date].valueAsDate reads/writes in UTC, not local time — near
// midnight in IST (UTC+5:30) that silently rolls the shown date back by
// one day. Build the "YYYY-MM-DD" string from local fields everywhere instead.
export function isoDateLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
