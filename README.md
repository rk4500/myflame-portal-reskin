# MyFLAME portal reskin

A full frontend replacement for FLAME University's student portal (`my.flame.edu.in`), for my own account. The stock portal is a Salesforce Experience Cloud site: slow, cluttered, and awkward on a phone. This hides its UI entirely and renders a custom one against the same backend.

Personal project, single user. Not distributed, not configurable, not multi-tenant.

## How it works

The portal talks to exactly one endpoint — `POST /s/sfsites/aura` — for everything. There is no REST API on the domain.

1. The script hooks `fetch` and `XMLHttpRequest.send` and snoops the page's own outgoing requests to harvest a live `aura.context` and `aura.token`. Nothing is parsed out of the page bootstrap, which changes shape between Aura versions.
2. `callAura(controller, method, params)` then calls the same Apex controllers the real UI uses.
3. Injected CSS hides the original DOM, and a `MutationObserver` keeps it hidden across the SPA's re-renders. The original page is never removed, only hidden.

Tabs: Home (day schedule and upcoming bookings), Calendar (day/week grid), My Bookings, Book Slot (facility availability and booking), Gyan (the portal's own AI assistant).

## Install

**Desktop** — Tampermonkey or Violentmonkey, paste `portal-reskin.user.js`. `@grant none`, so it runs in the page's own context and inherits the session.

**Android** — install the APK from the latest [release](https://github.com/rk4500/myflame-portal-reskin/releases). It is the stock app with a Frida gadget embedded, which injects the same userscript into the WebView at page load. Install with `adb install -r`; do not uninstall first, or you lose the logged-in session and have to sign in through Google again.

Kiwi Browser plus Tampermonkey works as a no-patch fallback on Android.

## Files

| | |
|---|---|
| `portal-reskin.user.js` | the whole thing — one file, no build step, no dependencies |
| `preview.html` | local QA harness: loads the real script against captured data, no portal session needed |
| `aura_map.json` / `aura_map.md` | every mapped RPC call, with real request and response shapes |
| `parse_aura_har.py` | HAR to RPC map; merges into the existing map unless given `--fresh` |
| `HANDOFF.md` | working log — decisions, root causes, and what was tried and rejected |
| `PRODUCT.md` | product context |

`.patch-tools/` holds the Android patch toolchain and is gitignored: about a gigabyte of venv, build-tools, decompiled smali, and APKs, nearly all of it regenerable.

## Local QA

No portal session is needed to work on the UI. `preview.html` feeds the unmodified script real captured data through a stub that `callAura()` short-circuits to.

```bash
chromium --headless=new --window-size=390,844 \
  --screenshot=shot.png "file://$PWD/preview.html?tab=home"
```

`?tab=<id>` picks the boot tab. `?auto=<scenario>` runs scripted clicks for states a screenshot can't reach on its own — slot selection, cancel confirmation, the Gyan error path. `?auto=measure` and `?auto=cancel-measure` dump every row and tile's computed height for `--dump-dom` to read, which is how layout questions get answered with numbers instead of by eye.

## Rebuilding the APK

The exact command sequence, along with every bug found getting it to work, is in `HANDOFF.md`. In short: regenerate the script constant embedded in `hook.js`, bundle with `frida-compile`, then `objection patchapk` against the merged stock APK. The base APK is not in the repo.
