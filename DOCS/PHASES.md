# PHASES — SachetSathi

> Each phase ends with an acceptance check. If a phase overruns its time budget by >20%, cut its stretch items and move on — the ladder in PLAN.md is law. Times assume ~10:30 AM IST start, prorated if later.

## Phase 0 — Scaffold (0:00–0:30)
- Init repo (`git init`), MIT LICENSE, `.gitignore` (`.env`, `__pycache__`, `data/`, `fixtures/photo-sample`!), `.env.example`
- FastAPI app factory stub (`/api/health`), docker-compose stub, seed `fixtures/gdacs-sample.json` (snapshot one real GDACS RSS item offline)
- Push first commit to a public GitHub repo
**Accept:** `docker compose up` → `GET /api/health` OK; repo public.

## Phase 1 — Alerts pipeline (0:30–1:30)
- `alerts.py`: fetch + parse GDACS RSS (and IMD bulletin text scrape if quick) → `alerts` table
- Fixture fallback path: on fetch error serve last snapshot; `/api/alerts` returns them
- Demo snapshot flag `?demo=1`
**Accept:** Live alerts visible as JSON with real timestamps + a fixture-fallback test passing.

## Phase 2 — Telegram in/out (1:30–2:15)
- `ingest.py`: long-poll `getUpdates` → photo download → `incidents` row (status=pending) → ack message
- `digest.py`: build digest (freshest alert + top triaged incidents) → send to channel; manual trigger first, cron later
**Accept:** Send a photo to bot → row appears in DB; digest lands in the channel. *(Reuse your `telegram-send-demo` token/plumbing.)*

## Phase 3 — Gemma triage (2:15–3:00)
- `triage.py`: photo+caption → Gemini API (Gemma model) → strict JSON card validated by Pydantic
- Retry-once-stricter → rule-based fallback (see RULES §3) with `triage="fallback"`
- Dashboard lists triaged cards with severity color; status=sent after digest
**Accept:** End-to-end photo-in → structured card visible → card included in digest.

## Phase 4 — PWA offline (3:00–3:45)
- `manifest.json` + `sw.js`: precache app shell; fetch `safety-pack` into IndexedDB when online
- Offline queue in IndexedDB; `navigator.onLine` + manual **"send now"** button flushes to `/api/report`
- Odia + EN text for safety pack
**Accept:** DevTools-network-offline → page opens; report queued; toggle online → flush → card lands.

## Phase 5 — Deploy to Cloud (Render / DigitalOcean) (3:45–4:15)
- Dockerfile final; deploy on Render (or DO App Platform); set env vars (API keys, bot token, channel id)
- Verify `/api/health`, `/api/alerts`, PWA reachable from phone data
**Accept:** Live public URL working; record it for submission.

## Phase 6 — Pitch freeze (4:15–5:00) — **feature freeze before this phase**
- README: what/why/how, architecture diagram, honest AI disclosure, limitations, runbook
- Demo rehearsal ×2 with the fixed script (PLAN.md checklist)
- Background screen recording of full demo (backup); screenshots captured
- MLH submit + enter both prize categories (DigitalOcean open-source AI, Gemma 4)
**Accept:** Submitted; README complete; backup video exists.

## Phase 7+ — Post-event growth (backlog, not scheduled)
- SACHET CAP XML real ingest → per-district filters
- Background Sync API instead of manual flush
- Odia full translation; Image-mark-up overlay
- Feedback loop: incident resolution tracking for coordinators
