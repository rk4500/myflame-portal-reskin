# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Tampermonkey userscript (vanilla JS/CSS injected into the live page), `@match https://my.flame.edu.in/*`. No build step, no framework — single `.user.js` file. Decided prior to this record, not asked during init.

## Users

Single user: a FLAME University student, own account only. Built for personal daily use, not distributed to other students.

## Product Purpose

Full visual replacement of the college's stock Salesforce Experience Cloud ("Siteforce") portal UI at `my.flame.edu.in`. The stock portal is slow, cluttered, and visually dated. This script hides the original chrome entirely and renders a custom dashboard driven by the same backend data (via direct Aura RPC calls), for a faster, cleaner personal daily-use tool. Success = checking today's schedule, bookings, and facility availability faster and with less visual noise than the stock portal.

## Positioning

Not a product for others — a personal reskin. The mechanism (calling the portal's own Aura endpoint directly, bypassing its rendered DOM) is what makes a from-scratch UI possible without reverse-engineering a public API.

## Operating Context

Used daily, likely multiple times a day, in short sessions (checking today's classes, checking/making a facility booking). Runs inside the student's own logged-in browser session — inherits cookies, no separate auth. Data source is Salesforce Apex controllers called through Aura, exposed via `callAura()`:
- `StudentPortalCalendarCtrl.getAllScheduledEvents` — class schedule (course, faculty, room, time)
- `CustomBookingController.getReservations` — user's own facility bookings
- `CustomBookingController.getResources` / `getResourceAvailability` — browsing facilities (gym, library rooms, classrooms, etc.) and their open slots by date
- Booking *submission* (writing a new reservation) is not yet wired — read-only for now (see HANDOFF.md)

## Capabilities and Constraints

- Current tabs: Calendar, My Bookings, Book Slot (availability lookup only, no submit yet), Resources.
- No native styling exists yet — current implementation is unstyled `<ul>`/`<li>`/`<button>` markup, zero CSS. This design pass is the first real visual layer.
- Must coexist with the host page's own scripts (Aura framework) without conflicting — script hides original DOM via CSS, doesn't remove it from the document.
- Single file, `@grant none`, no external CDN/build tooling (Tampermonkey userscript constraints) — any generated CSS/JS ships inline in `portal-reskin.user.js`.
- No accessibility requirement was specified by the user; standard reasonable a11y (contrast, focus states, keyboard nav) should still hold since it's a real daily-use tool for one person, not a throwaway script.

## Evidence on Hand

Real sample data already captured via HAR + Aura RPC calls, see `aura_map.md`/`aura_map.json`. Shapes are known and confirmed against live responses (see conversation history — response envelope is `{returnValue: {returnValue: <data>, cacheable}}`, some payloads are double-JSON-encoded strings).

## Product Principles

- Speed and clarity over completeness — this replaces a bloated portal, so it should never feel heavier than what it replaces.
- Single-user, opinionated — no need for generic configurability, empty-org states, or multi-tenant concerns.
- Read real data shapes, don't invent placeholder content — schedule items, bookings, and resources already have confirmed real-world shapes to design against.
- Resilient to the host page's own reflows (Aura SPA re-renders) without visual glitches or flashes of the original portal.

## Accessibility & Inclusion

No specific standard required; keep it reasonably accessible (contrast, focus-visible, keyboard-operable tabs) as general good practice for a tool used daily.
