// ---------------------------------------------------------------------
// 6. Icons (authored inline SVG, not emoji/unicode)
// ---------------------------------------------------------------------

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  bookings: '<svg viewBox="0 0 24 24"><path d="M6 4h12v16l-6-4-6 4V4z"/></svg>',
  book: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 3h6"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z"/></svg>',
  flame: '<svg viewBox="0 0 24 24"><path d="M12 3c-.8 2.6-3.2 3.7-3.2 6.8a3.2 3.2 0 0 0 6.4 0c0-1-.6-1.6-.9-2.4 1.4.9 2.7 2.6 2.7 4.7a5 5 0 0 1-10 0C7 8.3 9.6 5.6 12 3z"/></svg>',
};

export function icon(name, extraClass) {
  const span = document.createElement('span');
  span.className = extraClass ? `icon ${extraClass}` : 'icon';
  span.innerHTML = ICONS[name] || '';
  return span;
}
