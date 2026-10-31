# ARCHITECTURE — SachetSathi

## App flow

```
 OFFICIAL FEEDS                       FIELD REPORTERS                 COMMUNITY
┌───────────────────┐              ┌──────────────────┐          ┌────────────────┐
│ GDACS RSS / IMD   │              │ Telegram bot     │          │ Telegram       │
│ (SACHET CAP dev)  │              │ photo + text     │          │ channel        │
└─────────┬─────────┘              └────────┬─────────┘          └───────▲────────┘
          │ poller (cron/60s)               │ long-poll ingest           │ digest send
          ▼                                 ▼                            │
┌──────────────────────────────────────────────────────────────────────────────────┐
│ FastAPI core (DigitalOcean App Platform, Docker)                                  │
│  ├─ alerts.py    parse feeds → alerts table (fixture fallback)                    │
│  ├─ ingest.py    telegram updates → pending photos/text → incidents table         │
│  ├─ triage.py    Gemini (Gemma 4, open weights) → strict-JSON incident card       │
│  ├─ api.py       /api/alerts /api/incidents /api/report /api/safetypack           │
│  └─ digest.py    top incidents + freshest alert → sendMessage/sendPhoto           │
└──────────────────────────────┬───────────────────────────────────────────────────┘
                               │ REST/JSON                      ^ offline flush
                               ▼                                │ ("send now")
┌──────────────────────────────────────────────────────────────────────────────────┐
│ PWA dashboard: React-free vanilla JS + service worker                             │
│  app shell precached · safety pack in IndexedDB · offline report queue            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## Data model (single `data/` SQLite by default; swap file→Postgres via env var)

```
alerts      id, source(gdacs|imd|sachet), severity, area, headline, body, observed_at
incidents   id, reporter_tg_id, photo_path, caption, triage(severity, category,
            odia_summary, next_action, priority), status(pending|triaged|sent), timestamps
reporters   tg_id, first_name, first_seen, report_count
outbox      id, chat_id, kind(digest|ack|alert), payload_json, sent_at
```

## API surface
| Route | Method | Purpose |
|---|---|---|
| `/api/alerts` | GET | Latest alerts (source-sourced; `?demo=1` replays fixtures) |
| `/api/incidents` | GET | Sorted triaged incidents (`?severity=&category=`) |
| `/api/report` | POST | JSON report from PWA (offline queue flush target) |
| `/api/safetypack` | GET | Static pack (numbers, shelters, do/don'ts, Odia+EN) |
| `/api/health` | GET | Build health / version (demo script uses it) |

## Folder & file structure
```
sachet-sathi/
├── PLAN.md PRD.md ARCHITECTURE.md RULES.md PHASES.md DESIGN.md MEMORY.md
├── app/
│   ├── main.py            FastAPI app factory + routes registration
│   ├── config.py          env-driven settings (SECRETS via .env only)
│   ├── models.py          sqlite tables + insert/update helpers
│   ├── alerts.py          feed fetch + parsers + fixture fallback
│   ├── ingest.py          telegram poller (getUpdates), photo download, ack
│   ├── triage.py          Gemini call (Gemma model id), schema validation, retry
│   ├── digest.py          digest build + send to channel
│   └── api.py             REST routes listed above
├── web/
│   ├── index.html         PWA shell (alerts + incidents + offline report form)
│   ├── app.js             fetch, render, queue, flush logic
│   ├── sw.js              precache + versioned safety pack sync
│   └── safety-pack.json   contacts, shelters, do/don'ts (Odia + EN)
├── fixtures/
│   ├── gdacs-sample.json  snapshot feeds (DEMO_MODE + tests)
│   └── incident-sample/   one real-ish photo + caption for tests/demo
├── tests/test_triage.py test_alerts.py test_api.py
├── Dockerfile docker-compose.yml .env.example LICENSE .gitignore README.md
└── scripts/seed_safetypack.py
```

## Tech stack
| Layer | Choice | Why |
|---|---|---|
| Backend | **FastAPI + uvicorn** | Agent-friendly, typed, tiny; async fits Telegram polling |
| DB | **SQLite** (SQLAlchemy core OR raw sqlite3) | Zero setup; env swapping to Postgres documented |
| Telegram | **python-telegram-bot** (long polling) | Matches the working pattern in `telegram-send-demo` |
| AI | **Gemma 4 via Google Gemini API** (`google-genai` SDK) | Open-weights brief both categories; free tier |
| Frontend | Vanilla JS + service worker (no build step) | No bundler = no build failure = the 69% statistic |
| Deploy | **DigitalOcean App Platform** via Dockerfile | Sponsor-aligned, one-command from repo |
| Validation | **Pydantic models** for every LLM/external shape | Strict contract; see RULES.md |

## Key decisions
- **No webhooks** — long polling avoids needing a public URL during local dev.
- **Fixture-first feeds** — build parsers against snapshots; live fetch wraps them.
- **SQLite file by default** — deploy simplicity; the `DATABASE_URL` env decides.
- **No login** — Telegram user id is identity (PRD §6).
