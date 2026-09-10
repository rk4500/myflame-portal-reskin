// ---------------------------------------------------------------------
// Settings — small, persisted, user-facing toggles. No settings screen
// yet; this is the stub a future one swaps into. `settings` is read
// directly wherever a toggle matters (same shared-mutable-object
// convention as `ui`/`cache` in state.js); `setSetting()` is the one
// write path, so anything that changes a setting also persists it.
// ---------------------------------------------------------------------

const STORAGE_KEY = 'flame-settings';

const defaults = {
  // Nav-pill slide, swipe drag-follow, tab crossfades — everything
  // `reduceMotion()` in shell.js gates. Off collapses all of it to an
  // instant cut, same as the OS-level prefers-reduced-motion already
  // does; this is a user override on top of that, not a replacement.
  motion: true,
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...defaults, ...saved } : { ...defaults };
  } catch (e) {
    return { ...defaults };
  }
}

export const settings = load();

export function setSetting(key, value) {
  settings[key] = value;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {}
}
