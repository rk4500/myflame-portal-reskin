# Portal Reskin — Handoff

Custom frontend for the college portal (`my.flame.edu.in`), own account, personal use. Two fronts: a Tampermonkey/Violentmonkey userscript on desktop, and the Android app with the same script injected into its WebView by an embedded Frida gadget. Both ship the same `portal-reskin.user.js`.

This file is organised by subject, not by date — dates are kept on individual findings. It records root causes, things tried and rejected, and the state of anything unverified. It is not a changelog; the releases carry that.

## Current state

- `master` ships everything described here. Latest release is `v1.0.0` (from `9c33f78`), the first off the old dated tag scheme.
- The APK on the phone (`/sdcard/Download/MyFLAME-reskin.apk`, and `MyFLAME-reskin-working.apk` at the repo root) is that build, confirmed working on-device by the user.
- Live-verified: the whole Android injection path, the reskin rendering, Gyan's thread creation, booking and cancellation.
- Not live-verified: the autobooking 24h model (see its section), and the login page, which the script deliberately never touches.
- Branches kept on purpose, not to be deleted without asking: `rail` (rejected design, below), `build-split`, `skeleton-loaders`, `gyan-updates`.

## Working rules

- **Never `git commit` or `git push` unless told to in that message.** Editing, staging, building and installing are fine unasked. Also in `CLAUDE.md`.
- **Verification depth scales with the change.** A minor change gets built, installed and handed over — no scenario sweep, no `force-stop` and relaunch, no logcat grep, no confirmation screenshot. The pipeline is known-good and the phone is in the user's hand. The deep checks below are for troubleshooting.
- **Instrument before the second attempt, not the fourth.** Three Android builds shipped as guesses because every `catch` around `evaluateJavascript` was empty. One build with a real callback found the fault.
- **A script that edits several places is verified by its effects, not by its own success message.** One edit script aborted partway and reported success; a set of changes believed applied had never been written.

## Platform: Salesforce Experience Cloud ("Siteforce")

All traffic is one RPC endpoint. There is no REST API on this domain — `/services/data/…` is absent, so don't go looking for an OAuth route.

- `POST /s/sfsites/aura?r=N&aura.ApexAction.execute=1` (`r=` is a request counter, ignore).
- Params are exactly `message`, `aura.context`, `aura.pageURI`, `aura.token`. `callingDescriptor` is literally `"UNKNOWN"`.
- `message` is URL-encoded JSON: `{"actions":[{"id":"…","descriptor":"apex://Controller/ACTION$method","params":{…}}]}`. **A no-arg method omits `params` entirely** — sending `{}` risks an Apex deserialization error.
- Response is plain JSON (no `while(1);` prefix): `{"actions":[{"id":"…","state":"SUCCESS","returnValue":{…}}]}`, matched by `id`. The real payload is **`returnValue.returnValue`** — missing that unwrap silently broke every tab once. Some payloads are **double-JSON-encoded** (the returnValue is itself a JSON string).
- Auth is `aura.context` + `aura.token`. `callAura()` does **not** parse the page bootstrap: it hooks `fetch` and `XHR.send` and sniffs the page's own outgoing requests, which self-heals across token rotation. Both are cached in `localStorage['flame-aura-auth']` and tried immediately on the next launch, with one silent retry against a freshly sniffed token if the stored one is dead (two separately captured HAR sessions shared a token, so it survives page loads).
- **What the reskin needs from Aura, settled 2026-09-04**: `aura.context` *is* in the bootstrap HTML; the **token is not** — searched all 399KB, it is a 334-char `{"nonce":…}` blob that exists only because Aura's own JS fetches it. So Aura must run; we just never look at its UI. A HAR puts the first tokened request at **+0.297s** after document load.
- The token expires; a rotation or an `INVALID_TOKEN` reply is recovered by re-sniffing. Chrome-hiding is structural, not by class name — `.siteforceLayoutDiv` and friends never appear in the HTML at all, since the page is a pure Aura SPA shell (`<body class="null loading">`) with no app markup until client-side render. So: `body > *:not(#flame-reskin-root) { display: none }`, with a `MutationObserver` re-hiding across the SPA's re-renders and re-appending root if Aura wipes `<body>`. The original page is hidden, never removed — which is what keeps the stock-UI toggle honest.

### Descriptors in use

- `StudentPortalCalendarCtrl.getAllScheduledEvents({userId})` — class schedule.
- `CustomBookingController.getResources()` — facility list, double-encoded.
- `CustomBookingController.getResourceAvailability({resourceId, bookingDate})` — slots, double-encoded.
- `CustomBookingController.getReservations({userId})` — the user's bookings.
- `CustomBookingController.createReservation({dateSelected, startTime, endTime, resource, bookingPurpose, coAttendee, userId})` and `cancelReservation({userId, bookingId})`.
- Mapped but unused: `PortalEventController.getAllEvents`, `PortalAllFeedsCtrl.getAllEvents`, `PortalCreateServiceAndSupportTicketCntrl.getCases`, `NavigationMenuItemsController.getNavigationMenuItems`, `ResourceController.getCategoriesWithResources`. Full shapes in `aura_map.json` / `aura_map.md` (29 calls).

**`userId` gotcha**: these methods want a Salesforce **User** id (`005…`). `PortalAllFeedsCtrl.getCurrentUserContactId` looks like the obvious call and returns a **Contact** id (`003…`), which is not interchangeable. `resolveUserId()` instead regexes `"The Salesforce user record Id is 005…"` out of `AiAssistantFlameCommunityWrapper.getAssistantContext()` (cacheable, no params).

**Booking replies are prose, and a refusal is still `state: SUCCESS`** — e.g. `"More than 1 bookings are not allowed for selected resource."` arrives with no exception, so a try/catch never sees it. Success is detected by a real booking id (`/\bR-\d+\b/`); anything else renders in `.fr-error-panel` rather than `.fr-success-panel`, and re-enables the submit button (it used to stick on "Booking…" forever, since an awaited call succeeding was taken to mean the booking had). `startTime`/`endTime` are passed through verbatim from availability, in that format (`"6:00 AM"`). `bookingPurpose`/`coAttendee` were empty in the capture — treated as optional, sent as `""`.

### Gyan's protocol

Gyan is the portal's own assistant. Its calls use `namespace: "vnai"` (`callAura()`'s optional 5th param).

- Setup: `AiAssistantWindowController.getAssistant({assistantName:"Gyan"})` → `assistantId` + welcome text; then a thread; `getAssistantContext()` supplies `threadContext` + `additionalKnowledgeFileIds` (shared with `resolveUserId()`, one cached fetch).
- **`getUserThread`'s `createIfNotExists` flag is a lie** — it never creates anything, returning `{}` either way. Real creation is a separate method, `createNewThread({assistantId, assistantName, actorId})`, whose response is the **new threadId as a bare string**, not `{threadId: …}`. `acquireGyanThread()` looks up first and creates only on a genuine miss. This was root-caused from a HAR of the stock UI's own "Start chat" click, after two wrong theories (re-running setup each turn — kept, but insufficient; replaying a two-call `getUserThread` sequence — simply wrong).
- **`deleteThread` is genuinely destructive**, confirmed by the same HAR's "End chat". It is wired only to the explicit **New chat** button, never to a generic error handler. An earlier auto-delete-on-error very likely destroyed the user's original thread.
- Per message: `runModeration({message})` (fire-and-forget gate; no rejection shape was ever observed, so failures are swallowed) then `runAssistant({runRequest:{…}})`.
- **`runGyanTurn()` is a tool-calling relay loop, not a round-trip.** The server runs its own tools and hands back the computed result in `requiredActions[].functionResponse`; the client echoes each straight back as a `toolResponses` entry (`{name, arguments, callId, response}`) in the next `runAssistant` call, until a response carries real `text`. A `transfer_to_*` action (agent handoff) also carries a `userQuery` in its `functionArgs`, which becomes the *next* call's top-level `message` instead of the usual empty string — "book me a gym slot" bounced through two transfers before any tool ran. Capped at 8 steps.
- `ensureGyanReady()` runs at the top of `runGyanTurn()` itself, not just on tab mount — trusting the caller is how a send went out with `threadId: null` and got `"List index out of bounds: 0"`.
- State updates land unconditionally; only the DOM repaint is gated on `token === activeToken`, so switching tabs mid-reply and coming back shows the finished exchange instead of a stuck "thinking". Worth copying for any other slow async tab.

## The reskin

`@match https://my.flame.edu.in/*`, `@grant none` — runs in the page's own context and inherits the session. Five tabs: Home, Calendar, My Bookings, Book Slot, Gyan.

### Shell

- Desktop is a horizontal top bar (was a left sidebar); mobile keeps the bottom tab bar. Bar padding matches `.fr-content`'s own 48px so their edges line up. The old "FL" initials square read as an account switcher; an authored flame glyph + "FLAME" wordmark reads as a logo.
- **The Stock-UI toggle has no permanent mobile chrome.** A desktop top-bar button; on mobile, a 550ms long-press on the Home tab (`attachHomeLongPress`) with a background fill whose transition matches the hold delay, `navigator.vibrate(15)`, and the resulting tap suppressed via a capture-phase `stopImmediatePropagation`. An intermediate version put a fixed 52px `.fr-mobile-topbar` on every mobile tab to host the button; the user's verdict was *"thats disgusting bro."* — the structural argument (reserved space beats a floating overlay) was right about the collision and wrong about the cost.
- The toggle's state is `localStorage['flame-reskin-enabled']`, applied as a `body.flame-reskin-off` class. The off-state fallback pill (`#flame-reskin-toggle`) lives outside `#flame-reskin-root` and is `display:none` except under `body.flame-reskin-off` — it is the only way back *on* from the stock page, and since it only exists once root is hidden it cannot collide with anything of ours. An early version of the off-rule had **lower specificity** than the base hide rule, so the toggle relabelled itself and revealed nothing; caught by scripting a real click, not by reading the markup.
- Tab switching guards against a stale response arriving after the user has moved on (`activeToken` in `switchTab()`).

### Home

- **Week strip** (`buildDateStrip`, shared with Calendar's mobile day view; `buildDayNav` is the simpler prev/next control it replaced, still used by Calendar's week mode and Book Slot) replaced a vertical "next 6 days" column the user called "kinda stupid". Seven cells, prev/next paging, dots for days carrying classes, and deliberately **no Today button** — today's cell has its own treatment (`.is-today`, distinct from `.is-selected`) and re-opening the tab resets to today anyway. Selecting a day filters the already-fetched events client-side; no refetch, no tab jump.
- Class rows are fixed height. `.fr-row-title`/`.fr-row-meta` are single-line + ellipsis, `.fr-row-main` is `flex: 1; min-width: 0`, full text on `title`. `.fr-row-meta:empty::before { content: '\00a0' }` reserves the meta line so a class with no room/faculty doesn't sit shorter.
- **Upcoming bookings never disappears.** Empty, it is `.fr-nothing` — one `.fr-row` exactly (same 14px band, reusing `.fr-row-title`/`-meta`), inverted to hairline dashed with a `Book a slot` link so it can't be mistaken for a booking. It used to be omitted entirely, which made the page look like it had ended early; the first replacement was `renderEmpty`'s page-sized state (64px padding, 32px icon, three lines) dropped into a list slot, standing three rows tall and shoving the page ~130px when it resolved.
- Bookings read `shortDayLabel · start – end` (`Today · 8 AM – 9 AM`, via `formatBookingWhen()`). Previously two full `dd/mm/yyyy, h:mm AM` strings, stating the date twice for a single-day booking. `cleanResourceName()` strips the trailing operating-window parenthetical (`Gym ( 6:00 am to 2:00 pm slot )` → `Gym`), which is the facility's window, not the reservation.
  - `shortDayLabel` also fixed a bug inherited from `dayLabel`: it compared a *datetime* against midnight, so a 4 PM booking tomorrow displayed "Thu, Sep 3" while a 7 AM one displayed "Tomorrow". Both ends are floored to a date now.

### Calendar

- A real grid with day/week modes, 9 AM–7 PM at 78px/hour (the user's actual class hours). Blocks read **venue → title → professor**; the time is dropped, being redundant with vertical position. Overlaps get side-by-side lanes (`assignLanes()`, greedy interval packing).
- Mobile restructures `.fr-cal-header` via `grid-template-areas` (`"title toggle" / "nav nav"`), and day mode swaps the simple nav for the week strip — that part needs a JS branch (`matchMedia` at render time) plus a debounced `resize` re-render, since rotating across the 760px breakpoint changes the DOM, not just the layout.
- Week view on mobile scrolls horizontally: `min-width: ${days.length * 150}px` on `.fr-cal-days`, `overflow-x: auto` on `.fr-cal-wrap`, and the hour gutter `position: sticky; left: 0`.
- **Nothing in a block wraps.** Block height *is* the class's duration, so an extra line is an overlap into the block below, and `Chandragupta - Focus Room 201 W` is a real room name. Venue and professor are one line each, the title keeps a two-line clamp (measured to fit: box 72px / content 72px for a 55-minute class at 360, 390 and 1280px), `.fr-cal-event` takes `overflow: hidden`, full text on `title`.
- Two alignment bugs worth not re-deriving: a blanket `overflow:hidden` added to fix "9 AM overlaps the header" clipped the top half of *every* hour label — only the first one needs it (`.fr-cal-hour-label--first`). And day mode rendered the 40px `.fr-cal-gutter-header` spacer that only week mode's day-headers need, sitting every hour 40px low.
- The sticky gutter painted over the fixed bottom nav at equal `z-index`; `.fr-nav`'s mobile `z-index` is 5.

### My Bookings

**The cancel confirmation happens inside the row** (`attachCancelConfirm`, `.fr-row.is-confirming`): the title rewrites from `Gym` to `Cancel Gym?` and the one ghost button becomes `Yes` (danger) + `No` (ghost). The booking is named once, in the place already reading as its name. Measured 70px for every row, idle and confirming, at 360 and 390px.

Three earlier passes were rejected, all failing the same way — each *added* something to a row with no room, then bought that room from the booking's own text:
1. Question + two buttons swapped inline for the Cancel button → squeezed the title into a sliver.
2. The same as an absolute overlay → no shift, but it covered the booking being cancelled.
3. A drawer expanding downward → wasteful, and measurably uneven: a collapsed drawer still picked up mobile's `.fr-row { gap: 10px }`, so a cancellable row measured **80px against every other row's 70px** (`.fr-row--confirmable { gap: 0 }` lost to the later media-query rule at equal specificity). That is a real ordering bug that had already passed a visual review — which is why `?auto=measure` exists.

Details: `Yes` sits **left** of `No` on purpose, so `No` lands where the finger just was and a double-tap can't cancel a booking. Failure replaces the *time* line with `Couldn't cancel: <msg>` and turns `Yes` into `Retry`; the row still can't change size. One row asks at a time (`row.__frCloseConfirm`). Escape closes and returns focus to the trigger; focus only moves to `No` on keyboard activation (`click.detail === 0`). On mobile the status pill is dropped from any row with a live Cancel button (`.fr-row-actions:has(.fr-cancel-wrap) .fr-badge`) — the button already implies it, and it buys ~70px of text width.

### Book Slot

- Facility rail + resource picker + day nav on the left, results on the right. Availability **auto-loads** on any selection change; the old "Check availability" button is gone. The separate Resources tab was deleted — its data still feeds the rail.
- **`buildPicker` replaced the native `<select>`**, which Android WebView renders as a full-screen platform wheel with no styling ("really ugly"). A styled button + `role="listbox"` panel (`.fr-picker*`, reusing the existing tokens, plus a `chevronDown` icon that rotates 180° when open): click-outside and Escape to close, `aria-expanded`/`aria-selected`, exposing only `.value` and `.setOptions()` because that is all the tab used. Opening scrolls the selected row into view, which matters for Class Rooms' 13 resources against a 280px `max-height`.
  - The highlight is painted by `paintPanel()`, which the option-click handler never called — it set `value` and the label and closed, leaving the old row highlighted until something else repainted. Only visible on a *second* open, which is why `?auto=picker-reselect` reopens before asserting.
- **Resources are sorted** once in `renderBookSlot`, where the response lands, so the picker, the default selection and everything else agree. Two things a plain `.sort()` gets wrong: numeric collation (`Intl.Collator(undefined, {numeric:true})` puts `ARB002` before `ARB101`, and sequences Discussion Room A/B/C), and operating windows compared as **times** — `splitResourceWindow()` peels off the parenthetical so `Gym ( 6:00 am … )` sorts before `Gym ( 3:00 pm … )` rather than on the bare digit 3.
- **The grid shows the resource's whole day**, merging live availability with slots derived from its operating-window suffix, or from times remembered in `localStorage['flame-slot-times']` for resources without one. A slot the portal won't list yet is real and dated, drawn dashed with `Opens in 6h 17m`.
- Slots returned in `availabilitySlots` used to be tagged `kind: 'open'` unconditionally by `refreshAvailability`, which on dates more than 24h out opened the *manual* panel and defeated every blocked-tile check. `opensAt = start - BOOKING_WINDOW_MS` now decides: still in the future means `kind: 'later'`.
- `Opens now` is gone; a slot inside its window that the portal still isn't listing says **`Slots full`** — that is what an empty `getResourceAvailability` means for every known slot.
- **Confirm panel**: title `compactTimeRange(start, end)`, Purpose/Co-attendee only for room-type facilities (`facility_Name !== 'Sports Facilities'`) — a gym slot has nothing to put in either. `.fr-confirm-header` is a toolbar with the title left and the `Daily` toggle inline right; `.fr-confirm-inputs` is a 2-column grid collapsing on mobile; `.fr-confirm-warn` is a tinted callout (`color-mix(in srgb, var(--danger) 12%, var(--bg-elevated))`); the primary button is a full-width 42px anchor at the bottom. `text-wrap: pretty` on `.fr-confirm-note` and `.fr-confirm-warn` so a single word doesn't wrap alone.
- **It asks before acting**: on open, `existingBookingFor(resourceName, isoDate)` disables submit with `Already booked Gym Today · 8 AM – 9 AM — one booking a day.` rather than submitting and rendering the portal's refusal in red. A failed lookup does not block — the portal is still the authority.
- **Selecting a slot scrolls the button into view** (`scrollConfirmIntoView` + `confirmScrollDelta`, module scope, called from both panels). Three faults, all real:
  1. `scrollIntoView({block:'end'})` aligns to the bottom of the scrollport — exactly where the fixed nav bar sits. `block:'center'` clears it but overshoots from most rows and still can't account for `--flame-navbar-inset`.
  2. `scrollToConfirm` had been declared *inside* `openConfirm` while `openAutoConfirm` called it, so the autobook panel had been throwing `scrollToConfirm is not defined` and scrolling nowhere.
  3. `requestAnimationFrame` never fired — same starvation as the cold-launch cover. **rAF is not a dependable clock in this app.**

  What ships: go to the bottom (`scrollTo({top: scrollHeight - clientHeight})`), because the panel is the last thing on the page and landing at the end is what feels right — the first rewrite travelled the minimum distance, passed every check, and still felt wrong. `.fr-content`'s bottom padding (96px + inset) is larger than the bar, so the end of content parks ~47px clear of it. `confirmScrollDelta` still verifies: it subtracts the nav bar's height **only when its computed `position` is `fixed`**, and returns the distance needed to put the button inside what's left with a 12px gap. Issued synchronously. 400ms later anything short of the bottom is finished without animation — **unless a `touchstart` or `wheel` arrived first**, in which case the user has taken over.

### Autobooking

The rules came from the user; the HAR only ever captured one date. Booking opens **less than 24h** before a slot, only **one booking per resource *class* per calendar day** (class = the resource without its window suffix, so the 6 AM and 3 PM gym are one thing), and popular gym slots go within about five minutes of opening.

**No native work was needed.** The original plan was `AlarmManager.setExactAndAllowWhileIdle` at T-24h waking a headless WebView — a manifest edit the patch pipeline can't do, plus a session surviving a day idle. The user's own observation removed all of it: **the app is opened several times a day, so an intent in `localStorage` retried at every launch books anything uncontested with zero native code.** Works on desktop too. The known limit, stated rather than hidden: it loses a five-minute rush unless the app happens to be open.

- Intents in `localStorage['flame-auto-book']`: resource, ISO date, slot start/end, purpose/co-attendee, state, last message, `repeat`.
- `runAutoBook()` fires at boot (after the token lands) and every 2 min while open, tightening to **15s once an intent's opening moment is within 30 min** — that tight loop is the only way this version wins a contested slot. `AUTOBOOK_EARLY_MARGIN_MS` (30 min) starts attempts slightly early: the 24h rule is *our model*, not something the API states, so being early costs two cheap calls and being late costs the booking.
- Per intent: skip if not open; fail if the slot has started; **pre-check `getReservations`** for the same class that day (turns a guaranteed refusal into a clear message); then availability, and only on real capacity, `createReservation`. No capacity yet means the intent **stays waiting** — people cancel, and there is still time on the clock.
- **Autobook goes through a confirm panel** (`openAutoConfirm`), mirroring `openConfirm` because it ends in the same `createReservation`, just made later. Purpose/Co-attendee are stored on the intent and passed at fire time — autobook used to drop them. Copy is one line, deliberately: the first draft explained the window, the retry behaviour and the lack of a guarantee in a paragraph per case, and the verdict was *"no one is reading allat"*. The only distinction worth space is **tries** vs **reserves** — `Tries as soon as it opens. Not a reservation.` / `Full right now. Keeps checking and books it if it frees up.` "Repeat daily" carries no caption; the two words are the explanation.
- Results land as a banner above whatever tab is open (`.fr-banner-host` lives outside `contentEl`, which every render replaces), carrying the portal's own words and a Dismiss. Silent auto-booking is how you end up with a reservation you didn't know about.

**The one-per-day rule** is enforced at scheduling time as well as fire time. `resourceClassKey()` is `cleanResourceName()` lowercased; `conflictingIntent(resourceName, isoDate)` finds the waiting intent holding a class/day and `scheduleIntent` returns `null`. The grid says so rather than swallowing the tap: other tiles for that class go `.is-blocked` + `aria-disabled`, keep their normal status caption (`Opens in Xh`, `Slots full`, `Auto-booking ✓` — rendering an empty string left an awkward blank under the time), carry `blockedReason()` on `title`, and stay tappable to raise a self-dismissing `showNotice` banner. `blockedReason()` is one sentence: `A daily autobook already covers this day. Stop it below to book this day yourself.` for a series, `An autobook is already scheduled…` for a one-off. The redundant `.fr-book-results-title` line above the grid (`Gym · Today, Sep 4`) was removed so a single `.fr-slot-notice` sits cleanly at the top when a day is covered (`An autobook is already scheduled for this day. Stop it below to book this day yourself.`). `runAutoBook` keeps its own guard (`alreadyBookedThatDay`, filling a `claimed` set from both a successful `createReservation` and an existing-booking hit) regardless — for intents already in `localStorage` from before the rule, and because a booking made earlier in the same pass isn't in the cache snapshot.

**Manual booking on a claimed day warns rather than blocks** — the panel says `Stops your 6 AM – 7 AM autobook — one booking a day.` and really removes the intent on success. A second *autobook* on a claimed day is refused outright, since unlike a manual booking it could never succeed.

**Daily repeat** (`intent.repeat === 'daily'`) is not a rule that fires forever: each occurrence spawns the next only once it has settled, either way. So there is only ever one waiting intent per series (`… · daily`), Stop ends it outright, and a refusal doesn't kill it — tomorrow is a fresh day. A series **claims every day from its own date onward** (`Daily autobook` on those tiles), otherwise a daily gym set for tomorrow would still offer Sunday as free. Setting an earlier daily series **replaces** a later one for the same class (`futureDailyIntents`, warned about in the panel: `Replaces your daily autobook starting Sun, Sep 6 (8:00 AM – 9:00 AM).`).

Four rule bugs, found together (2026-09-04):
1. The one-per-day claim was computed as `sl.kind === 'later' ? conflictingIntent(…) : null`, so a claimed day still offered all its *open* slots. The claim is a property of the day, not of the tile's kind.
2. `spawnNextOccurrence` did `return` on an already-claimed next day, and since the next occurrence is only created on settle, nothing restarted it — a daily series ran until the first day you had booked by hand and then silently never again. It steps over claimed days now, up to `SERIES_LOOKAHEAD_DAYS` (7).
3. `scheduled` didn't compare dates, so a series reaching forward offered to cancel an intent belonging to a different day.
4. Caption precedence tested `blocked` before `bySeries`, showing a time from the wrong day.

Stopping a scheduled tile is **two taps**: the first arms `.is-confirming-cancel` with a danger tint and `Tap again to stop`, auto-resetting after 3s or on any outside tap; the second removes the intent (`removeIntent`) and refreshes availability.

**Not verified against the real portal**: the 24h model, whether `createReservation` accepts the exact `startTime` taken from availability (passed verbatim, as the real flow does), and whether "class" really is the cleaned resource name. First real contested use settles all three.

### Gyan tab

- `.fr-gyan-page` is a flex column filling `.fr-content` edge to edge — the first tab to do so; history lives in an in-memory `gyanState.messages`, cleared on a real reload like everything else session-scoped. `.fr-gyan-list` gets `margin-top: auto` so a short exchange hugs the composer (every chat convention does; the first version had it flush to the header with a dead gap below) and steps aside once it overflows. The welcome state gets `margin: auto 0` instead — an explanation, not a conversation.
- **Mount is non-blocking**: the layout paints synchronously and context initialises in the background. The composer stays enabled the whole time — while initialising and while a turn is running — and the **send button** carries the spinner and the disabled state. Waiting to be allowed to type was the worst part of the old spinner.
- **Time-of-day prompt chips** (`getSmartGyanChips`), always alongside `Next class` and `Sports slots`: before 11:00, breakfast + lunch; to 16:00, lunch + dinner; to 19:00, snacks + dinner; after that, dinner + tomorrow's breakfast.
- `parseGyanBold` + `escapeHtml` render `**bold**`/`*bold*` as `<strong>`. *Known limitation*: on devices whose system font lacks a 700 weight this may not look bold.
- The send button carries `.fr-spinner-svg`; `inputEl` is never disabled. **New chat** is disabled (`gyanState.sending`) while initialising or sending, so a turn can't be orphaned mid-flight.
- The stock welcome text references a "Start chat" button that doesn't exist here; the fallbacks are rewritten (`Ask about classes, facility bookings, campus info, or anything else Gyan can help with.`).

### Loading, caching and motion

**The rule a skeleton follows here**: it is the **real element** with its unknown text swapped for a shimmering block of the same metrics — never a lookalike assembled from bare divs. `.fr-skel` is an inline-block holding a non-breaking space, so its line box is exactly one line of whatever type its parent uses: same font, line-height and baseline. Width is the only thing a caller passes, in `ch`, and it is a guess about content length that nothing in the layout depends on. Shimmer is a `background-position` gradient sweep, 1400ms linear, off under `prefers-reduced-motion`.

- **Home** paints its title, date strip and headings from the first frame — none need data. Three class rows and one booking row shimmer; three because that is a normal day, and a skeleton that guesses high leaves a hole when the data lands short. The strip's has-events dots are the one thing that appears late, since which days carry classes is exactly what isn't known.
- **Home's first paint comes off the last launch's data**, kept in `localStorage['flame-data-cache']` (`src/persist.js`). Home is the boot tab and the only one that needs it — by the time Calendar or My Bookings is opened, Home's own revalidation has filled the in-memory cache they read.
- **The stale-repaint jitter is gone.** The cache paints, the request still goes out, and the answer is compared against what is on screen (`sameData`, `src/persist.js`) and **dropped when identical**. The timetable is semester-static, so the common case was tearing down the whole page to rebuild the same page a second after the tab opened.
- **Book Slot** used to wait on `getResources` before painting a pixel, and everything above the grid is drawn from that list. It is cached on its own clock — `flame-resources-cache`, 7-day TTL, separate from Home's blob because they expire for different reasons: a day-old class list is nearly right, a week-old resource list is simply correct.
- The grid's times are not a guess: `knownSlotTimes(resource)` derives them from the operating window (`Gym ( 6:00 am to 2:00 pm slot )` is eight hourly slots), falling back to what that resource last offered. Real labels, real card count; only the capacity line shimmers. `createSlotShell` builds the box and the answer **fills the same nodes** by `dataset.start` — nothing moves. A card is created late only if the skeleton couldn't predict it, and anything predicted that the day didn't have is dropped.
- **Past times are not predicted.** A slot that has already started can't be booked and the portal doesn't list it, so a skeleton built from the full window drew cards that vanished — open the tab in the afternoon and half the grid disappeared. The predicted list uses the same `start > now` predicate the fill already used. Late enough that nothing is left, there is nothing truthful to draw and it falls back to the spinner, then to "No open slots".
- The claim note and the scheduled-autobook list are in the first paint too — both come from `localStorage`, so holding them back only pushed the grid down a line at the worst moment.
- The spinner survives in the one honest case: a resource with no window in its name and nothing remembered.
- One defect from that pass, worth remembering: skeleton cards inherited `.fr-slot:disabled { opacity: 0.4 }` — the *blocked* look — which also dimmed the card's time, the one thing already true.
- **`morphHeight` (`src/dom.js`)** animates the bookings section between heights (280ms) for the case geometry can't remove: the skeleton stands one booking tall and the day holds three. Removing the jump comes first — a 130px shift can't be animated into something pleasant. **No `requestAnimationFrame` in it**: the second height is written synchronously after an `offsetHeight` read flushes layout. `transitionend` is the fast cleanup path and a timer does it regardless, so a dropped transition leaves a correctly sized element rather than one frozen at a stale height. `.fr-morphing` carries the transition so reduced-motion can take it away.
- In-memory `cache.events` / `cache.bookings` / `bookState.facilities` are populated once per load and invalidated only by a real mutation. Nav clicks used to call `switchTab()` — a full spinner and a fresh round-trip just to change the date — and now re-render against the cache; only Book Slot's results wrap refetches.

### Layout rules that were hard-won

- **`compactTimeRange(start, end)`** drops an on-the-hour `:00`: `"10:00 AM" + "11:00 AM"` → `"10 AM – 11 AM"`; `:15`/`:30` keep their minutes; an unrecognised format is left alone. This is what actually made the numbers fit — a two-up tile at 390px has ~130px of text width. It also dropped the *leading* meridiem when a range didn't cross noon (`"10 – 11 AM"`), which fit even better and was rejected as "a little too minimal"; both meridiems are kept. The regex tolerates the narrow no-break space newer ICU puts before the meridiem.
- Everything that shouldn't wrap is one line + ellipsis: `.fr-cal-day-header`, `.fr-slot-cap`, `.fr-sched-name`/`-note`, `.fr-banner-title` (its note wraps on purpose), `.fr-facility-item`, `.fr-book-field-label`, `.fr-book-results-title`, `.fr-confirm-panel-title`, `.fr-group-heading`, `.fr-datestrip-weekday`/`-daynum`, plus `white-space: nowrap` on `.fr-btn` and `.fr-badge` — a button label that wraps is always a bug.
- **`white-space: nowrap` converts a wrap into an overflow**, so a clean wrap report proves nothing on its own. That is why `?auto=wrapcheck` also flags any element wider than its box whose computed `overflow-x` is `visible`. It caught the one real regression these fixes introduced: `.fr-book-layout`'s `1fr` tracks default to a `min-content` minimum, so a single unbreakable facility name widened its column past the viewport and took the page sideways (531px of content in a 450px box at 360px). Both tracks are `minmax(0, 1fr)` now.
- Mobile's `.fr-row { justify-content: flex-start }` (fixing a dead gap between time and title on Home, caused by `space-between` with only two flex children) was too broad and broke My Bookings' right-pinned pill and Cancel button. Scoped with `:has()`: `.fr-row:has(.fr-row-time)` — `.fr-row-time` exists only on class rows.
- `.fr-input` had no `::placeholder` rule, so placeholders fell back to near-black on a dark field — invisible. `(optional)` was later dropped from the Purpose/Co-attendee placeholders.
- Slot grid floor is 146px (still two columns at 360px).
- In `styles.css` the `\00a0` escape is single-escaped. It was `\\00a0` only while the CSS lived in a template literal, where a bare `\0` followed by a digit is an illegal octal escape — a hard `SyntaxError`, caught by `node --check`.
- `dateInput.valueAsDate` reads and writes in **UTC**, silently showing yesterday near midnight IST. There is no native date input anywhere in the app now.
- `el.hidden = true` is defeated by an element's own `display:flex` class rule — author CSS beats the UA `[hidden]` rule at equal specificity.

### Still open: long class titles truncate on Home

Measured in the reskin's own font and sizes, worth not re-deriving:

| Course | one line | lines @234px (today) | lines @322px (full width) | px to fit one line @234 |
|---|---|---|---|---|
| Applied Formal Methods | 187px | 1 | 1 | 20.1px |
| Principles of Machine Learning | 237px | 2 | 1 | 15.8px |
| Design and Analysis of Algorithms | 264px | 2 | 1 | 14.2px |
| Entrepreneurial Failure and Sustenance | 302px | 2 | 1 | 12.4px |
| Business Plan Development and Entrepreneurial Finance | 435px | 2 | 2 | **8.6px** |

- **Shrink-to-fit is ruled out** — the longest real name needs 8.6px, half the row above it. Asked and answered; don't revisit.
- The left time column costs 88px (78px min-width + gap) and is the whole problem: at full width 5 of 6 real course names fit on one line, and all 4 `room · faculty` strings fit (3 of 4 don't at 234px).
- Candidates: **(A)** clamp the title to two lines with height reserved, so rows stay equal — still truncates faculty; **(B)** move the time to a small line above the title so text gets full width, reserving two title lines to keep cards equal.

## Source layout and build

```bash
npm install     # once
npm run build   # src/ -> portal-reskin.user.js -> .patch-tools/hook.js
npm run watch   # same, on every save
```

**Edit `src/`, never `portal-reskin.user.js`.** That file stays tracked — it is what gets pasted into Tampermonkey, what `preview.html` loads and what a release ships — but it is generated. `npm run build` is ~210ms; a watch rebuild is 50–110ms, of which the hook fuse is ~1.4ms, which is why watch does it too: skipping it bought nothing and left `hook.js` stale for exactly as long as you were iterating.

One command produces both artifacts on purpose. `hook.js` carries the whole userscript as a string constant, and an APK built from a stale constant runs the *old* UI while every other check still passes — a failure this project hit more than once while the two were regenerated by hand.

Modules: `aura.js`, `chrome-hide.js`, `styles.js` + `styles.css`, `toggle.js`, `icons.js`, `dom.js`, `dates.js`, `shell.js`, `autobook.js`, `persist.js`, `state.js`, `tabs/{home,calendar,bookings,book-slot,gyan}.js`, `main.js`.

Two things the single-file version got for free:

- **Shared mutable state.** `let x = null` in one closure could be reassigned from anywhere; an ES module binding is read-only for importers. `src/state.js` holds the values genuinely written from more than one module (`ui.root`, `ui.contentEl`, `ui.bannerHost`, `ui.toggleBtn`, `ui.activeToken`, `cache.events`, `cache.bookings`) as fields on two objects, so assignment goes through a shared object. Anything written only by its owner stayed a plain `let`.
- **A dependency cycle.** The shell named the five renderers while every tab imported `switchTab`/`renderEmpty` back out of it. `shell.js` exports an empty `RENDERERS` plus `registerRenderers()`, which `main.js` calls at boot. Tabs → shell, never back.

**Rollup, not esbuild.** esbuild builds in 7ms and **discards ordinary comments** — it dropped ~400 comment lines, which in this repo is most of the recorded reasoning. Rollup keeps the source's shape: same IIFE, comments intact.

Two bugs the split produced, both caught by the harness rather than by reading:
1. The import inference blanked template literals before scanning for free identifiers, so `` `${shortDate(days[0])} …` `` looked like it referenced nothing — Calendar's week view silently did nothing, `shortDate` being an undefined global. Caught because `?auto=wrapcheck` reported 49 text runs where the pre-split run reported 102.
2. `build.mjs` filled the wrong `__USERSCRIPT__`: `hook.src.js`'s header comment explains the placeholder and therefore contains the token, and an unanchored `replace()` took that first occurrence — a 130KB comment and a hook that injected nothing, with no error anywhere. The placeholder is now matched **with its surrounding quotes**, asserted to appear exactly once, and the fused output is checked for `flame-reskin-root` before being written.

`.patch-tools/regen-hook-script.py` was deleted when `build.mjs` took over its job — two things able to write `hook.js` is how they drift.

## Local QA harness

`preview.html` loads the unmodified built script and feeds it real captured data through a `window.__FLAME_RESKIN_PREVIEW__` stub that `callAura()` short-circuits to (inert on the real site). No portal session needed. Screenshots via system `chromium --headless=new` (Playwright's own download is blocked in this environment); output in `.review/`, gitignored.

```bash
chromium --headless=new --window-size=390,844 \
  --screenshot=shot.png "file://$PWD/preview.html?tab=home"
```

- `?tab=<id>` picks the boot tab. `?auto=<scenario>` runs scripted clicks for states a screenshot can't reach alone — including real `dispatchEvent(new PointerEvent('pointerdown'))` gestures, with Chromium's `--virtual-time-budget` carrying timers such as the 550ms long-press.
- **`?auto=wrapcheck`** (+ `-week`, `-cancel`, `-confirm`, `-sched`) walks every element rendering text directly and counts the lines it actually occupies, from the client rects of a `Range` over its own text nodes — what the renderer did, not what the CSS claims, the CSS being the thing under test. Plus the overflow half described above. `WRAP_OK` is the registry of text *meant* to wrap (chat bubbles, empty states, success/error panels, the autobook banner's note — a truncated refusal reason is worse than a two-line banner); add to it deliberately, with a reason, never to quiet a finding. It reports the number of runs scanned, so "0 unplanned" can be told from "the page never rendered".
- **`?long=1`** swaps every portal-supplied string for a much longer one. Pair it with wrapcheck; screenshots stay on real data.
- **`?auto=measure` / `cancel-measure`** dump every `.fr-row`/`.fr-slot`/`.fr-datestrip-cell`'s computed height. "Are these the same height" is a question for numbers, not for a PNG — this is what caught the 80px-vs-70px drawer after it passed a visual review.
- **`?auto=calfit`** — calendar block content height against box height.
- **`?auto=confirm-scroll` / `-auto`** — nav height, view band, button band and `scrollTop` against the scroller's maximum, reporting both "at bottom" and whether the button is clear. PASS at 390x780, 360x640, 360x500, 1280x900, with and without `?long=1`. The autobook variant is the one that catches a panel calling a function it can't see.
- **`?auto=picker-reselect`** — picks another option, **reopens**, asserts exactly one `.is-selected` and one `aria-selected`.
- **`?auto=sched-rule` / `-cross`**, `?seed=twin` + `?auto=seed-result`, `?auto=series-covers`, `?seed=series-clash` — the one-per-day and daily-series rules, asserted.
- **`?seed=due`** plants an already-open intent so the runner fires on load and its banner can be screenshotted — otherwise only observable by waiting a day. Both seeds search the gym's own window across today and tomorrow for the first hour still ahead and inside 24h, so they work at any clock time; they used to hardcode "1 PM today" and silently produced a failure banner after 1 PM.
- **`?auto=coldpaint`** with `?slow=<ms>` and `?seed=persisted` — proves the stale paint *and* the repaint (in-flight shows `STALE …`, settled shows the real name). `?bookings=<n>` sets how many upcoming reservations exist: `0` is the only way to reach the empty row, and >1 makes the section resolve taller than the skeleton stood.
- Others: `book-confirm`, `book-confirm-room`, `book-confirm-fail`, `resource-picker-*`, `cal-next`, `book-slot-next`, `gyan-chat`, `schedule`, `schedule-twice`, `autopanel`, `confirm-warn`, `shiftcheck`, `banner-anim`, `authstate`.
- **Runtime errors are a reported failure.** A thrown `ReferenceError` renders as an empty or half-built tab, which in a screenshot reads as a styling problem — that is how the `shortDate` bug survived its first look. `preview.html` traps `window.onerror`, `unhandledrejection` and `console.error` into `<pre id="errors">` (or `no errors`) for `--dump-dom`, on every scenario.
- Scenarios that need a bookable or schedulable tile **hunt for a day that has one** (`findDayWith()`); hardcoding an offset made them pass or fail by the hour. The availability stub models the 24h window and serves the real captured 6 AM–2 PM gym day, so two-digit hours and the noon crossing are always on screen. The confirming row's colour transition is frozen for screenshot determinism — the virtual clock kept catching it half-tinted, which looked like a real bug.

Last full sweep: 39 scenarios at 390 and 1280, zero runtime errors.

## Android

### What the app is

`com.myflame` is a **React Native app wrapping `react-native-webview`** pointed at `https://my.flame.edu.in/s/` — not Salesforce Mobile Publisher. Evidence: `libhermes.so`, `libreactnative.so`, `libfbjni.so`, `librnscreens.so`; logcat shows `RNCWebViewManager`/`RNCWebViewClient`; `assets/index.android.bundle` is precompiled **Hermes bytecode** (magic `C6 1F BC 03`), not patchable JS. It is a **split-APK install** (base + `arm64_v8a`/`en`/`xxhdpi`), and the arch split carries the whole RN runtime — any repackage must merge all four, via `APKEditor.jar` (`apkeditor m -i <dir> -o merged.apk`).

It is still a real `android.webkit.WebView` underneath, so the Frida-gadget approach applies; RN only means the hooked class is discovered at runtime rather than assumed.

**iOS**: a resigned IPA via AltStore/Sideloadly would work for a config/JS patch, but real runtime hooking without a jailbreak isn't viable. Not attempted, not worth it.

**Device**: Xiaomi 23127PN0CG (`houji`), Android 16 / SDK 36, wireless debugging via `adb connect`.

### The build pipeline

```bash
npm run build                       # writes .patch-tools/hook.js
cd .patch-tools && source venv/bin/activate
export PATH="$PWD/build-tools/android-14:$PWD/venv/bin:$PATH"
export JAVA_TOOL_OPTIONS="-Xmx6g"
../node_modules/.bin/frida-compile hook.js -o hook.compiled.js -T none
objection patchapk -s flame-merged.apk -a arm64-v8a \
    -c gadget-config.json -l hook.compiled.js -j 1
adb install -r flame-merged.objection.apk
```

- `hook.js` must start with `import Java from 'frida-java-bridge';` — a CJS `require()`'s interop breaks the bundle's default export.
- `frida-compile` and `frida-java-bridge` are **repo-root** deps, declared in the root `package.json` and installed at `<repo>/node_modules`. (`.patch-tools/venv/bin/frida-compile` also exists — it ships with the python frida-tools and is a different program; the npm one is what this pipeline is built on. Earlier sessions found these at `/home/archer/node_modules`, because npm walked up to the nearest `package.json`.)
- Patch the **merged** APK with the **compiled** script, never raw `hook.js`.
- **`adb install -r`, never uninstall first.** objection reuses the same debug keystore across builds, so this upgrades in place and preserves the logged-in session; `adb uninstall` wipes app data and forces a full Google re-login. Only uninstall when switching to a differently-signed build (e.g. back to Play Store stock). A side effect worth knowing: a self-signed build has `installerPackageName=null` and so never receives Play Store updates — reverting is `adb uninstall com.myflame` plus a Play Store install, after which the whole pipeline has to be re-run against the new base APK.
- Verify by checking that `lib/arm64-v8a/libfrida-gadget.script.so` inside the output APK byte-matches `hook.compiled.js`, and that the build log contains no `OutOfMemoryError` — the two "may have failed" lines objection prints are its standard boilerplate; grep for the OOM string, not for those.
- `gadget-config.json` is `{"interaction": {"type": "script", "path": "libfrida-gadget.script.so"}}` — autostart mode, per objection's documented convention.
- `objection patchapk -l <script>` **refuses to run without `-c <config>`** (`A script source was specified but no gadget configuration was set.`). For a plain listen-mode diagnostic build — no embedded script, external `frida -U -n … -l script.js` attach instead — omit `-l` entirely rather than pairing it with a listen-type config.

**Rebuilding the toolchain from nothing**: `jdk-openjdk` + `android-apktool` from pacman/AUR (needs sudo, run by hand); `.patch-tools/venv/` is a Python venv with `pip install objection frida-tools`, which keeps the Python side out of sudo; `.patch-tools/build-tools/` is an extracted `build-tools_r34-linux.zip` (direct download — no `sdkmanager` or license flow) purely for the classic `aapt`, `apksigner` and `zipalign` binaries; `.patch-tools/APKEditor.jar` is a REAndroid/APKEditor release download.
- Tracked in `.patch-tools/`: `hook.src.js`, `gadget-config.json`, `probe.js`. Everything else there (venv, build-tools, decompiled smali, APKs, screenshots — ~1GB across 32,736 files) is ignored and regenerable. **Keep the screenshots ignored regardless: they show the portal with a real name and roll number on screen.**

### Bugs and traps, all confirmed against real behaviour

1. **`-a arm64` vs `-a arm64-v8a`.** The short form makes objection name the folder `lib/arm64/` instead of the real ABI name, so the linker never finds the gadget (`UnsatisfiedLinkError: … library "libfrida-gadget.so" not found`) even though the file is in the APK. Always pass exactly what `adb shell getprop ro.product.cpu.abi` returns.
2. **`OutOfMemoryError` during apktool's smali rebuild.** The default heap is too small for this app's multidex/RN tree, and one rebuild thread dies silently while the process still reports success and goes on to sign a **corrupted APK**. `JAVA_TOOL_OPTIONS=-Xmx6g` plus `-j 1`. Dangerous precisely because objection doesn't hard-fail.
   - The env var works **through objection** (it prints its own "Picked up JAVA_TOOL_OPTIONS" line) but is **silently ignored when calling apktool directly**: `/usr/bin/apktool`'s launcher hardcodes `javaOpts="-Xmx256M"` on the `java` command line, and an explicit later flag beats an env-injected one. Builds have nonetheless succeeded at the default 256M on this app and machine, so the OOM may be specific to a parallel (`-j` > 1) build. If one recurs while calling apktool directly, the real override is its own `-J` passthrough (`apktool -JXmx6g b …`).
3. **`Java.use('android.webkit.WebView')` crashes Frida's Java bridge if called too early** (`access violation accessing 0x0` inside `/frida/bridges/java.js`): the real implementation lives in the WebView provider's own classloader, which may not be in the process yet, and Frida's search picks up an incomplete stub. Wrap in try/catch + `setTimeout(retry, 1000)`.
4. **Frida spawn mode needs root.** On a jailed device `frida -U -f <pkg>` gives `Failed to spawn: need Gadget to attach on jailed Android`; only `-n <process>` attach works, which inherently races `setWebViewClient`. Fine for the autostart config (the gadget runs from `System.loadLibrary` time), but it means live attach cannot test the "catch the first `setWebViewClient`" behaviour — only the real autostart timing can.
5. **The WebView doesn't exist until after sign-in.** The app shows a native RN login screen first, so `Java.choose('android.webkit.WebView', …)` finds zero instances at startup. Poll. This does **not** mean the hook has to wait: `WebView.setWebViewClient.implementation` is a class-level intercept that waits indefinitely, and was confirmed installing while the native login screen was still up and firing correctly minutes later, after real sign-in. The real client class is `com.reactnativecommunity.webview.RNCWebViewClient`.
6. **WebView is main-thread-affine.** Calling `evaluateJavascript` from Frida's own thread throws `"A WebView method was called on thread 'Thread-7'…"`. Use `Java.scheduleOnMainThread`. This never affected the production hook — `onPageFinished` is delivered on the main thread already.
7. **A hook's method argument is only a valid wrapper for the synchronous duration of the hook call.** Using the `view` passed into `onPageFinished` inside a later `scheduleOnMainThread` callback throws `Wrapper is disposed; perhaps it was borrowed from a hook…`. `var retained = Java.retain(view)` synchronously first. (`Java.cast()` produces an independent wrapper, so paths using it never hit this.)
8. **`evaluateJavascript(js, null)` reports neither success nor failure.** Register a real `ValueCallback` returning a status string — readyState, URL, body child count, computed background. Both failure paths log now.
9. **Frida's `setTimeout` does not reliably fire when called from inside a Java callback.** A 150ms grace scheduled from within `ValueCallback.onReceiveValue` (Android's main thread, not Frida's JS thread) never ran.
10. **`requestAnimationFrame` will not fire under an opaque native cover** — Android can skip drawing a fully obscured WebView, so no frames are produced. Two nested rAFs is the textbook way to wait for a paint and it deadlocks here. Use existence checks plus a bounded give-up. This renderer starves rAF in other situations too (see the confirm-button scroll).
11. **`apktool -J` must come before the subcommand** — `apktool -JXmx6g b <dir> -o <out>`. The wrapper only strips `-J` args from the very front.
12. **`apktool b` can silently reuse a stale build** — editing `apktool.yml` alone prints `AndroidManifest.xml and resources have not changed`. Always `-f`, then verify with `aapt dump badging`.
13. `objection patchapk` needs the classic **`aapt`** specifically (not `aapt2`) for `aapt dump badging`; that is what `build-tools/` is there for, independent of apktool, which bundles its own `aapt2` and doesn't need a system one (its `--skip-resources` flag only skips its own decompilation step, and is unrelated to objection's check).
14. Two environment nuisances that look like build failures and aren't: **USB drops** (`lsusb` empty, `adb devices` empty) — reseat the cable before suspecting the tooling; and **HyperOS's on-phone install confirmation**, which appears intermittently even with USB debugging long since approved — `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user` means look at the phone screen, tap through, and re-run the same command.

### How autostart injection was finally made to work (2026-09-01)

Live `frida -U -n` attach worked early and repeatedly; **autostart (`type:"script"`) mode showed nothing at all** — no reskin, and not one log line, not even the first statement of the file. The gadget `.so` loaded cleanly every time (`nativeloader: … ok`) and all three libs were present at full size in the app's extracted lib dir, so it was never a packaging problem. The chain, each layer real and only findable in order:

1. **The gadget's script mode has no ambient `Java` global and no module resolution.** The interactive `frida` CLI auto-bundles and polyfills `Java` as a convenience — which is exactly what masked this through every earlier "it works!" live-attach test. A file handed to `objection patchapk -l` is raw text dropped into the gadget's script slot and gets none of it.
2. **Diagnosed with a logger that does not depend on the Java bridge**: `liblog.so`'s `__android_log_print` called directly via `NativeFunction`, tag `FlameInjectNative`, with checkpoint **A** as the file's first statement and **B** as the first statement inside the `Java.perform` callback. This is the technique to reuse for any future script-mode problem — **the moment your diagnostic goes through `console.log` or `android.util.Log`, a broken Java bridge silences the diagnostic along with the thing it is diagnosing.** (Interpreting it: A absent means the script never runs at all — stop editing its contents; A present and B absent means the Java VM never becomes ready in that context, so poll `Java.available` + `Java.performNow` instead of a blocking `Java.perform` at load time.)
3. `require('frida-java-bridge')` as a bare CJS call **silently killed the whole script** — not even checkpoint A printed. Nothing resolves `require` in the raw gadget engine.
4. Running it through **`frida-compile`** got `Java` to resolve as a real object, but `typeof Java.perform` was still `undefined`: the default bundle format is ESM, and CJS `require()`'s interop shim hands back the wrapper rather than the bundled module's default export.
5. **The fix is ES syntax**: `import Java from 'frida-java-bridge';` as the very first line, matching frida-compile's ESM output. Logcat then reads `typeof Java.perform=function, Java.available=true` and the hook fires end to end.

**Test protocol, if this is ever re-run**: actually sign in on the device during the capture window. `setWebViewClient` legitimately cannot fire before a WebView exists, so an app left sitting on the native login screen proves nothing about the later lines — only the absence of checkpoint A is signal on its own.

### Status bar, nav bar and the cold launch

**Status bar** — `window.setStatusBarColor()` (and `setNavigationBarColor`) is a documented **no-op** at `targetSdk=36` (confirmed via `adb shell dumpsys package com.myflame | grep targetSdk`): Android mandates edge-to-edge for SDK 35+ and ignoring the deprecated colour setters is a listed consequence, not a Frida problem. **Downgrading `targetSdkVersion` to 34 made it worse** (a double-height white strip, because the app's native code opts into edge-to-edge independently) — reverted immediately, **do not repeat**. The fix is to paint a real opaque `android.view.View` into the `DecorView`, anchored top, height from `WindowInsets.getInsets(statusBars()).top` with a `status_bar_height` resource fallback (the nav-bar side uses `navigation_bar_height` the same way) (`paintStatusBarOverlay()`, deduped via `findViewWithTag`). Not a system colour API, so not subject to the deprecation — this is what edge-to-edge-aware apps do themselves. `insetsController.setSystemBarsAppearance(0, 8)` still works and is kept for light icons.

**Nav bar** — `env(safe-area-inset-bottom)` isn't reliably populated by this WebView, so `pushNavBarInset()` measures `getInsets(navigationBars()).bottom` natively and pushes it in as `--flame-navbar-inset` (device px → CSS px via `devicePixelRatio`). The stylesheet declares it with an `env(safe-area-inset-bottom, 0px)` default (harmless 0 on desktop) and uses it in `.fr-nav`'s padding and height and `.fr-content`'s bottom padding, inside the mobile media query.

**The triple loading flash** (RN splash → white stock loader → reskin in *desktop* layout → another white loader → reskin) had two causes:
- `onPageFinished`'s URL match hit both the SSO `frontdoor.jsp` bounce and the real page, so the reskin was injected into a transient stub and thrown away. Narrowed to `my.flame.edu.in/s/`.
- Android WebView paints solid white until the page's own background loads. `this.setBackgroundColor(DARK_BG)` (`0xFF11131A`, matching `--bg`) in the `setWebViewClient` hook — the earliest available point, before any navigation.
- The desktop-layout flash specifically: `react-native-webview` defaults `useWideViewPort=true`, so a page with no `<meta name="viewport">` (which `frontdoor.jsp` is) is laid out against a fake ~980px viewport and `@media (max-width: 760px)` loses. `setUseWideViewPort(false)` as belt-and-braces. It does not pin a width or break responsiveness — it only removes the "guess 980px" fallback.

**The cold-launch cover (2026-09-04)** — a recording showed ~7.75s to content, of which ~1.75s was white Salesforce "Loading…" cards and ~1.1s our own spinner. What ships is an opaque `FrameLayout` tinted `--bg` with a centred indeterminate `ProgressBar` tinted `--accent` (`0xFF5B8CFF`), added to the `DecorView` in the `setWebViewClient` hook and removed once `#flame-reskin-root` exists, `setClickable(true)` so taps can't reach a portal nobody can see. On-device: cover up ~3.2s, removed 87ms after injection, no white at any point.

**Why CSS could not do this** — three attempts (a `<style>` hiding `body > *` at `onPageStarted`, then at `onPageCommitVisible`, then on a 100ms re-apply loop), each better, none working: **a style injected into a document is only as durable as that document**, and a cold launch has three — the SSO bounce, *the same page after it rewrites itself* to render Salesforce's loading card (this is the one that replaces `<head>`), and finally `/s/`. A re-apply loop can only shorten the flash to one tick; the wipe and the repair are always in that order. `setBackgroundColor` survives because it is native, so the fix belongs at that layer.

**Tried and rejected: injecting at `onPageStarted`.** It works and was reverted. Measured `onPageStarted` → `onPageFinished` on `/s/`: 1.383s, 1.508s, 1.644s — but the actual saving was **548ms** (3432ms → 2884ms of cover time), because the reskin only paints at `DOMContentLoaded`, 1.18s after injection. Behind a cover, ready at 2.9s or 3.4s looks identical, and the visible parts were already taken by the caches. It costs a second injection point, a delivery guard and double-boot semantics — and the guard can't live in the script: rollup hoists every module body into one IIFE, so `aura.js`'s `fetch`/`XHR` patching runs long before any flag check in `main.js`, and a second run wraps our own wrapper. The reasoning about why it doesn't pay is the part worth keeping.

**Logcat**: clear the buffer *before* launching if the `[flame-inject]` lines are wanted; it rolls past a launch quickly. A healthy sequence reads `hook installed` → `setWebViewClient` → `boot cover shown` → `onPageFinished /s/` → `injecting reskin` → `status bar overlay painted, height=134` → `navbar inset pushed: 48px device` → `boot cover removed (ready, 4650ms)`. Absent that, the UI rendering *is* the evidence the hook fired — nothing else injects the reskin.

### Could the APK build run in GitHub Actions? Yes, with two prerequisites

Investigated, not built.

- **Signing is not the problem**, contrary to first assumption: `objection.jks` ships inside the objection package (`site-packages/objection/utils/assets/objection.jks`) and is identical on every install of a version. Pin `objection==1.12.5` and CI emits an APK signed `CN=Unknown, OU=objection, O=SensePost` — the same cert as local builds, so `adb install -r` still preserves the session. Verify with `apksigner verify --print-certs`; current signer SHA-256 begins `f7697c66…f46ce0fb`.
- **Prerequisite 1 — the base APK.** `flame-merged.apk` (33MB) can't be committed sensibly: binaries don't delta-compress, so every re-pull adds another permanent 33MB to every clone. Put it in a private release asset and `gh release download` it.
- **Prerequisite 2 — the toolchain sources**, already done: `.gitignore` inverts `.patch-tools/*` with exceptions for the three real source files. `hook.js` and `hook.compiled.js` stay ignored because 90% of `hook.js` is the pasted userscript, which would put a second near-identical diff in every commit.
- Everything else is free: ubuntu-latest ships the JDK and Android SDK, 16GB covers `-Xmx6g`, objection fetches the gadget itself, and the local patch takes under two minutes. Trigger on `v*` tags and the release upload becomes automatic.

## Tried and rejected

- **The rail** (branch `rail`, `aaa8948`, local only) — hairline `.fr-rail` lists replacing filled `.fr-row` cards across Home and My Bookings, with unfilled slot tiles and date cells to match. Rejected on sight: "i don't like this rail thing at all". **Branch kept deliberately; don't delete it without asking.** `master` has no rail code.
- **A permanent mobile top strip** for the stock-UI toggle — see the Shell section.
- **Shrink-to-fit class titles** — see the measurement table.
- **A home-screen widget** (asked, analysed, dropped: "forget that"). The analysis is counterintuitive enough to keep: **the timetable is semester-static**, so a widget needs no live data, which removes the hard part entirely. Four paths, cheapest first: **(1) export to the phone's calendar as `.ics`** — not a widget and better than one, since the events already carry everything iCalendar needs (`startDateTime`, `endDateTime`, `courseName`, room, faculty), and every calendar widget then shows classes, with notifications, offline, outliving the session (caveat: a WebView download needs a `DownloadListener` the app may not have, so generate it on desktop or via a share intent); (2) Termux:Widget/KWGT with an exported cookie, re-exported when it expires; (3) a separate Kotlin companion app holding its own `CookieManager` session — the proper answer for a live widget, and it avoids smali entirely; (4) patching a widget into MyFLAME itself — new resource IDs inside an already-compiled `resources.arsc` is the fiddly part. Most work, least payoff over (3). Don't.
- **The native scheduled auto-booker** (`AlarmManager` + `BroadcastReceiver` + headless WebView) — superseded by the localStorage version, and it is still the only design that could win a five-minute rush, so it is the one to come back to if the shipped version proves too slow. Two risks would need settling first, both unverified: whether the Salesforce session survives 24h fully idle (if not, nothing can recover it — Google SSO can't be scripted), and HyperOS battery optimisation killing scheduled alarms unless the app is whitelisted.
- **Kiwi Browser + Tampermonkey** as the Android path — still a working no-patch fallback (it runs desktop Chrome extensions, and Chromium's "Add to Home Screen" gives a chromeless standalone window). Ruled out alongside it: Brave for Android has no extension support at all, and Firefox does support Violentmonkey but its Add to Home Screen always opens a normal tab with browser UI.

### UI references the user wanted to look through

Named while discussing a broader overhaul; the user is deciding for themselves. What each is worth stealing:

- **Things 3** — the strongest case that deleting boxes makes a list *prettier*. Type and whitespace only, one accent.
- **Structured** — a time rail done well; colour-coded dots carry category without decoration.
- **Cron / Notion Calendar** — dark, hairline, restrained; proof a dark schedule UI can feel expensive with almost no colour.
- **Linear** — low-chroma dark, 1px borders instead of filled surfaces, obsessive consistency.
- **Amie** — the counter-argument: big type, playful colour, still simple. Look here if it should feel less severe.
- **Fantastical** — dense day lists that stay legible; strong time-column typography.
- **Citymapper** — a vertical time rail with connectors, if a day should read as a journey.

A comparison board (Rail / Timeline / Quiet-slab against the real schedule) was published as an artifact during that discussion. Its one durable finding: **a timeline whose block height maps to duration is wasted on Home**, because every FLAME class is 55 minutes — height would encode only the gaps. Worth stealing for Calendar, not Home.

## Open items

1. **The login page is untouched.** The script bails via `isLoginPage()` — login is Google SSO and breaking it costs real access. If revisited: the same full-replace approach should be fine for the *portal's own* login chrome, since the OAuth handshake happens on Google's origin where this script never runs; the risk is blanking the button before it's clickable, not the auth flow. `isLoginPage()`'s path guess (`/login`, `/identity`, `/idp`) is **unconfirmed** — the HAR only covers post-login traffic. Verify the real path first.
2. **Long class titles on Home** — see the table above; two candidate fixes, neither chosen.
3. **Autobooking's 24h model, `startTime` passthrough and the "class" definition** are unverified against the real portal.
4. Gyan's bold rendering may not look bold on a device whose system font lacks a 700 weight.

## Releases

| Tag | Notes |
|---|---|
| `v1.0.0` | Current. Skeleton loaders, the repaint drop, past-slot prediction, the one-row empty state. First non-dated tag; numbering moves forward from here. |
| `v2026.09.04.1` | Confirm-button scroll + picker highlight. |
| `v2026.09.04` | Autobook confirm panel, daily repeat, the four rule bugs. |
| `v2026.09.03.2` | Predates the `src/` split, the cold-launch cover and the autobook UI work. |
| `v2026.09.03`, `v2026.09.03.1`, `v2026.09.01` | Earlier. |

Repo: https://github.com/rk4500/myflame-portal-reskin (private).

## Files

| | |
|---|---|
| `src/` | the source — one module per tab, plus `aura.js`, `shell.js`, `state.js`, `persist.js`, `autobook.js`, `styles.css` |
| `build.mjs` | the build; also fuses `.patch-tools/hook.src.js` with the built userscript |
| `portal-reskin.user.js` | build output: the whole reskin in one file, no runtime dependencies |
| `preview.html` | local QA harness |
| `aura_map.json` / `aura_map.md` | every mapped RPC call, with real request and response shapes |
| `parse_aura_har.py` | HAR → RPC map: `python3 parse_aura_har.py portal.har aura_map`. **Merges** into the existing map by default; `--fresh` overwrites. (It used to overwrite silently, which lost the first 24-call capture once.) |
| `*.har` (untracked) | the captures everything above was derived from — the original archive, book-and-cancel, the "more than 1 not allowed" refusal, and two Gyan sessions. Gitignored: they carry live session tokens and are huge. |
| `PRODUCT.md` | product context |
| `.patch-tools/` | Android toolchain; only `hook.src.js`, `gadget-config.json`, `probe.js` are tracked |
