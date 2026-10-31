# SachetSathi PWA — redesign notes

> What changed, why, and how each of the nine stated problems was fixed.
> Scope: `web/` only (IA, hierarchy, visuals, interaction). The stack, data model,
> API, offline queue and safety-pack content are unchanged.

Goal: a **< 3-second "am I at risk, what do I do now" read** on a phone, in Odia or
English, online or offline.

## Problem → fix

| # | Problem (before) | Fix | Where |
|---|---|---|---|
| 1 | Flat hierarchy — every card looked equally important | `StatusHero` owns the answer: one derived status (`SAFE`/`WATCH`/`DANGER`) with icon + word + colour, one action sentence, then *evidence* chips (nearest alert, nearby report count). Alerts are sorted by severity **then distance**; "Ongoing (older than 7 days)" is collapsed below current ones. | `app.js` `computeStatus()` / `heroHtml()` / `renderHome()`, `style.css` `.hero*` |
| 2 | Stale global alerts outranked local ones | Distance is computed for every alert/report; anything beyond `RADIUS_KM = 100` is demoted out of "Near you". A far-but-big alert only produces a region watch (`REGION_WATCH_KM = 500`) with an explicit "Monitoring … about N km away" note instead of a false local alarm. | `app.js` `RADIUS_KM`, `REGION_WATCH_KM`, `passesFilters()`, `hero.region_watch` |
| 3 | Two split feeds, no single story | One sticky `FilterBar` (severity / type / source) applies to **every** list *and* the map, so the home feed, the reports feed and the pins can never disagree. Sources are labelled inline (`Official GDACS`, `Community`, `Telegram`) on each card. | `app.js` `filterBarHtml()`, `renderReports()`, `renderMap()` |
| 4 | Filters scrolled away / reset unexpectedly | The bar is `position: sticky` under the topbar, keeps its state in memory across view switches, and the primary row is now a single 44 px row (severity + "More filters"); the type/source rows and "Clear filters" expand on demand. | `style.css` `.filterbar*`, `app.js` `toggle-filters` |
| 5 | Noise — test rows, URLs-only captions, duplicate country pins | Test rows are hidden behind an explicit "Show test items" toggle, caption-derived titles are cleaned (`#id`, `📍` location prefix, bare URLs → `Untitled report`), duplicate pins are clustered until `zoom ≥ 1.5`, and "Ongoing" items are collapsed. | `app.js` `cleanTitle()`, `toggle-tests`, clustering in `renderMap()` |
| 6 | Low contrast / unreadable in sunlight | Three token sets: **dark** (default), **light**, **Sunlight** (pure black-on-white, heavy rules, no greys). All three are contrast-audited; severity is never colour alone (dot + icon + word). The theme button cycles and persists. | `web/tokens.css`, `applyStaticI18n()` |
| 7 | Buried actions ("what do I do now" took too many taps) | Every severe/moderate card carries an action box (`what_to_do`) plus Share / Navigate / **Read aloud** / Official source; the hero carries the single most important instruction; the severe banner carries the destination action. | `app.js` `actionBox()`, `actionsRow()`, `speakItem()` |
| 8 | Unlabelled FAB, no map | The FAB is a labelled "Report" nav item (`Report` text + `nav.report`), the bottom nav has 5 labelled items with `aria-current`, and the map is a real view: hand-built inline **SVG of Odisha** with pins, clusters, distance rings, a legend, zoom/fit controls and tap-for-detail (no tiles, no network, no new deps). | `index.html` `#bottomnav`, `#view-map`, `web/map-data.js`, `renderMap()` |
| 9 | Unreadable footer / chrome | Footer text moved into the About sheet (rendered from `i18n.js` + `safety-pack.json`), the connection state is a tappable `ConnectionPill` ("Online · last synced 3 h ago"), and an offline strip states exactly how stale the data is. | `app.js` `renderChrome()`, `openAbout()` |

## Components (deliverable 2)

| Component | File / function | Notes |
|---|---|---|
| `StatusHero` | `heroHtml()` + `.hero` | status → icon → one-line action → evidence chips; `aria-live` mirror for screen readers |
| `AlertCard` (3 variants) | `cardHtml()` | `--severe`, `--moderate`, `--low`; severe cards get assertive announcement + Read aloud |
| `ReportCard` | `cardHtml()` (`kind: 'report'`) | community styling, vote (confirm / not accurate), photo, location-or-"not in report" |
| `FilterBar` | `filterBarHtml()` | sticky, shared by all views and the map; 1 row + expandable detail |
| `BottomNav` | `#bottomnav` | 5 labelled items, Report promoted, hidden ≥ 1200 px (replaced by appbar nav) |
| `ReportSheet` | `openReportSheet()` | type → text/photo/voice → location → send; offline queue status |
| `MapView` | `renderMap()` / `renderMapSheet()` | inline SVG, pins/clusters, legend, bottom-sheet detail |
| `ConnectionPill` | `renderChrome()` | online/offline + last-sync, doubles as refresh |
| `SafetyPackCard` | `safetyPromptHtml()` / `renderSafety()` | offline helplines, do/don't, "verify locally" notice |

## Design tokens (deliverable 3)

`web/tokens.css`: `:root` (dark) + `[data-theme="light"]` + `[data-theme="sunlight"]`.
Type scale 12 / 14 / 16 / 20 / 28; 8 px spacing grid; 16 px card radius; 44 px
minimum tap target (`--tap`); motion ≤ 200 ms and disabled under
`prefers-reduced-motion`; Inter + Noto Sans Oriya (Odia line-height 1.6 via
`[lang="or"]` and `:root[lang="or"]`).

## Responsive (deliverable 3)

| Width | Layout |
|---|---|
| ≤ 420 px | single column; bottom nav; compact language toggle in the appbar; conn pill drops the "last synced" tail |
| 360 px | verified 0 px horizontal overflow, all tap targets ≥ 44 px |
| 768 px | two columns: content + sticky map; bottom nav still present |
| ≥ 1200 px | three columns: home/reports · map · safety pack; bottom nav hidden; appbar gains **Home / Reports** and a **Report** button |

**Pinned columns are jump targets, not views.** At ≥ 768 px the map is its own
column, and at ≥ 1200 px so is the safety pack. Calling `setView('map'|'safety')`
at those widths would hide the primary column and leave a blank pane, so
`railIdForView()` detects the pinned column and `revealRail()` scrolls it into
view and flashes it instead (`#view-safety` also gets `scroll-margin-top` for
the sticky topbar). A `matchMedia` listener calls `normalizeView()` when the
window crosses a breakpoint, so a view that becomes pinned (e.g. pressing
**Safety** on a phone, then rotating to desktop) falls back to **Home** rather
than blanking the left pane.

## Accessibility

- Landmarks: `header` / `main` / `nav` / `section[aria-labelledby]`; skip link first in tab order.
- Live regions: feeds `aria-live="polite"`, severe banner and hero status `assertive`.
- Every icon is `aria-hidden`; severity always carries a text label; dialect-aware `lang` attributes.
- Dialogs are native `<dialog>` (focus trap + Escape for free); focus returns to the trigger on close.
- All copy lives in `web/i18n.js` — 260 keys × `en`/`or`, 0 missing, 0 placeholder mismatches; no hard-coded strings in `app.js`/`index.html`.
- TTS "Read aloud" on severe cards (and reports) via `speechSynthesis`, `or-IN` / `en-IN`, cleaned punctuation.

## Offline & performance

- Service worker `v4` precaches the shell (`index.html`, CSS, JS, manifest, icons, safety pack) and keeps the last good API payloads; reports queue in IndexedDB and flush on reconnect or "Send now".
- No web fonts, no third-party scripts, no tiles: the shell is ~49 KB gzipped total (JS ≈ 39 KB gz — budget 150 KB).
- Lists are windowed (`CHUNK = 8` + "Load more"), images lazy (`loading="lazy"`), icons inline SVG.
- Serving: added `GZipMiddleware` (FastAPI stdlib, no new deps) in `app/main.py` so the shell ships compressed — the budget assumes gzip, and App Platform/CDNs re-compress anyway.

## Verification (this session)

- `pytest tests/ -q` → 51 passed.
- Contrast audit in-browser: **0** AA failures on home, reports, safety, report/location/about sheets and the DANGER state, in dark, light **and** Sunlight.
- Tap targets at 360 px: **0** controls under 44 × 44 px.
- `document.documentElement.scrollWidth === 360` (no horizontal overflow) at 360 / 768 / 1200.
- Language toggle: `en ↔ or` verified both ways (html `lang`, hero copy, aria labels, Noto Sans Oriya + 1.6 line-height).
- Severe path: injected a severe cyclone via a stubbed `/api/alerts` in an isolated browser profile — hero flips to DANGER, assertive banner appears, Read aloud speaks headline + body + action in `en-IN`.
- Sticky filter bar verified pinned under the topbar at 117 px (chrome = 23 % of a 780 px viewport when collapsed).
