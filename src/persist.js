// Last-known data, kept across page loads.
//
// The in-memory caches in state.js start empty on every launch, so the
// first thing you saw after the app booted was a spinner, for as long as
// two aura round-trips took — about a second on the device, on top of the
// portal's own boot. Everything Home shows is already known from last
// time, so it can be on screen immediately and corrected a moment later.
//
// This is a first-paint hint, never a substitute for fetching: the render
// path still issues the same requests every time and repaints with the
// answer. That is what keeps a cancelled booking from surviving here for
// longer than it takes one request to come back.

const KEY = 'flame-data-cache';

// Older than this and it is not worth showing at all — a stale-by-a-day
// class list is genuinely useful (the timetable is semester-static), a
// stale-by-a-week one is just noise while the real answer loads.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function readPersisted() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.savedAt || Date.now() - data.savedAt > MAX_AGE_MS) return null;
    return data;
  } catch (e) {
    // Private mode, disabled storage, or a shape from an older version:
    // fall back to the spinner, which is exactly the old behaviour.
    return null;
  }
}

export function writePersisted(patch) {
  try {
    const current = (() => {
      try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
    })();
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch, savedAt: Date.now() }));
  } catch (e) {
    // Storage full or unavailable — the app works, it just boots cold.
  }
}

// Called wherever the in-memory cache is invalidated by a mutation, so a
// booking you just cancelled cannot come back on the next launch and sit
// there until the refetch lands.
export function clearPersistedBookings() {
  const data = readPersisted();
  if (!data) return;
  delete data.bookings;
  writePersisted(data);
}

// The facility/resource list is its own cache with its own clock. Home's
// blob expires in a day because a day-old class list is nearly right and
// a week-old one is noise; the resource list is different in kind — the
// gym and the classrooms are the same all semester, so a week-old copy is
// still correct, and expiring it daily would put a round trip in front of
// the Book Slot tab for no reason. Separate key, because the two have
// nothing to do with each other beyond both being last-known data.
const RESOURCES_KEY = 'flame-resources-cache';
const RESOURCES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function readPersistedResources() {
  try {
    const data = JSON.parse(localStorage.getItem(RESOURCES_KEY));
    if (!data || !data.savedAt || Date.now() - data.savedAt > RESOURCES_MAX_AGE_MS) return null;
    return Array.isArray(data.facilities) && data.facilities.length ? data.facilities : null;
  } catch (e) {
    return null;
  }
}

export function writePersistedResources(facilities) {
  try {
    localStorage.setItem(RESOURCES_KEY, JSON.stringify({ facilities, savedAt: Date.now() }));
  } catch (e) {
    // Same as above: a cache that cannot be written costs a round trip,
    // nothing else.
  }
}

// Two aura payloads compared structurally. They are plain JSON from the
// same serializer, so key order is stable and stringifying is both
// correct and quicker than walking them. Used to answer "did anything
// actually change" before tearing down a page that is already right.
export function sameData(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) {
    return false;
  }
}
