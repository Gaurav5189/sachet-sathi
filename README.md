# SachetSathi

**A field assistant for the Odisha cyclone.** Live official alerts (GDACS / NDMA SACHET / IMD) + Telegram field reports + Gemma triage into structured incident cards + a PWA that works offline.

> 🚧 **Work in progress** — built during Hacktoberfest Hack Day Bhubaneswar × DatrixLabs, Oct 31 2026.
> This README is a scaffold; the full what/why/how, architecture diagram, AI disclosure and limitations land before submission.

## Status

| Phase | What | State |
|---|---|---|
| P0 | Scaffold, health endpoint, GDACS fixture, container | ✅ |
| P1 | Alerts pipeline (GDACS RSS → `alerts`) | ✅ |
| P2 | Telegram in/out (long polling + digest) | ⬜ |
| P3 | Gemma triage → strict JSON card | ⬜ |
| P4 | Offline-capable PWA | ⬜ |
| P5 | Deploy to DigitalOcean App Platform | ⬜ |
| P6 | Pitch freeze, submission | ⬜ |

## Run it

```bash
cp .env.example .env          # fill in tokens when you need Telegram / Gemma
podman compose up --build     # or: docker compose up --build
curl localhost:8000/api/health
```

Without a container:

```bash
uv venv .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload
```

## What's here

```
app/         FastAPI app (main.py, config.py, models.py, alerts.py, api.py)
fixtures/    Real GDACS feed snapshot (RSS + normalized JSON) for DEMO_MODE
scripts/     snapshot_gdacs.py — refresh the feed fixture
tests/       pytest
DOCS/        PRD, architecture, rules, phases, design
```

## Honest AI disclosure

Gemma (open weights, via the Gemini API) is used **only** to turn a reporter's photo + caption into a strict-JSON incident card: `severity`, `category`, `odia_summary`, `next_action`, `priority`. It does not fetch, parse or invent official data, and it never sends messages or makes decisions. Alert cards always name their real source. If the model returns invalid JSON twice, the card is marked `triage=fallback` (rule-based severity) and a human decides priority.

Fixture replay (`DEMO_MODE=1`) is labelled as such — never presented as live data.

## License

MIT — see [LICENSE](LICENSE).
