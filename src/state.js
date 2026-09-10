// Shared mutable state.
//
// This is the one thing the single-file version got for free: every
// `let bookingsCache = null` sat in one closure, so any function could
// reassign it. ES module bindings are read-only for importers, so the
// handful of values that genuinely are written from more than one module
// live here as fields on an object instead — the assignment goes through
// the object, which every importer shares.
//
// Anything only ever written by its own module stays a plain `let` there.
// Keep this file small; it is a list of exceptions, not a store.

// The shell's live DOM, built once by buildShell().
export const ui = {
  root: null,          // #flame-reskin-root
  viewportEl: null,    // .fr-content-viewport — stable; hosts one or two .fr-content panes during a tab transition
  contentEl: null,     // .fr-content — the *current* pane; every tab render replaces it wholesale, and a tab-to-tab transition reassigns this pointer to a freshly rendered pane before sliding it in
  bannerHost: null,    // sits outside contentEl so a tab render can't take it
  toggleBtn: null,     // #flame-reskin-toggle, outside root so it survives "off"
  // Bumped by every switchTab(); a render compares its own token against
  // this before touching the DOM, so a slow tab that resolves after you
  // have already navigated away paints nothing.
  activeToken: 0,
};

// Fetched once per page load, invalidated only by a mutation that really
// changes them (a booking or a cancellation).
export const cache = {
  events: null,        // class schedule — doesn't change mid-session
  bookings: null,
};
