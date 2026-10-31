# PLAN — SachetSathi

> Master orchestration doc. Read this first. Deadline: **Oct 31, 8:00 PM IST** (MLH submission) — feature freeze at ~7:15 PM, reserve the last 45 min for pitch artifacts only.

## Doc index

| Doc | Purpose |
|---|---|
| PRD.md | What we build, who for, features, scope cuts |
| ARCHITECTURE.md | App flow, folder structure, stack |
| RULES.md | Approved libraries, error handling, AI boundaries |
| PHASES.md | Development phases with acceptance criteria |
| DESIGN.md | Palette, fonts, typography |
| MEMORY.md | Living log — update after every task |

## The pitch (one sentence)

A field assistant for the active Odisha cyclone: live official alerts (NDMA SACHET / GDACS / IMD) + Telegram in/out reporting + Gemma (open weights) triage into structured incident cards + PWA that works offline and queues reports.

## Timeline (anchored to a ~10:30 AM IST start; compress pro-rata if later)

| Clock | Phase | Must be true after phase |
|---|---|---|
| 0:00–0:30 | P0 Scaffold | Repo public, license, .gitignore, secrets ignored, FastAPI stub runs |
| 0:30–1:30 | P1 Alerts pipeline | Live IMD/GDACS fetch renders in raw JSON endpoint |
| 1:30–2:15 | P2 Telegram in/out | Photo sent to bot → DB row; digest job sends to channel ✓ |
| 2:15–3:00 | P3 Gemma triage | Photo+text → strict JSON card stored, shown in UI |
| 3:00–3:45 | P4 PWA offline | App opens offline; offline report queues; "send now" flushes |
| 3:45–4:15 | P5 Deploy | Live on DigitalOcean App Platform URL |
| 4:15–5:00 | P6 Pitch freeze | README, diagram, backup video, MLH submit + enter categories |

**Hard rules from the hack-day playbook**
- Feature freeze at T-60 min. No new features after that, under any deadline panic.
- Push to GitHub every ~30 min.
- Backup screen recording made BEFORE we depend on venue Wi-Fi / hotspot.
- Demo runs on one pre-tested script (fixed report photo, fixed feed snapshot fallback).

## Submission checklist (endgame)
- [ ] Public repo with MIT license, clean commit history, no secrets
- [ ] Live demo URL (DigitalOcean)
- [ ] README: what/why/how + architecture diagram + honest AI disclosure + limitations
- [ ] 2-min backup demo video recorded locally
- [ ] MLH: project submitted to event, entered in **Best Open-Source AI Project** (DigitalOcean) — and double-enter into **Best Use of Gemma 4** (same build qualifies)
- [ ] Screenshots: feed view, Telegram digest, triage card, offline queue

## Risk register

| Risk | Mitigation |
|---|---|
| CAP/SACHET XML parsing rabbit hole | Snapshot a working feed response in `fixtures/` first; parse that; live fetch is a wrapper around it |
| Venue network dies during demo | Everything cached: fixture mode flag `DEMO_MODE=1` replays stored data |
| Gemma response JSON drift | Hard JSON schema validation + one retry with stricter instruction, then fallback to rule-based severity |
| Telegram webhook complexity | Use **long polling** (`getUpdates`), not webhooks — no public URL needed до deploy |
| We stall mid-build | Scope ladder below — at T-60 we cut to the ship-able rung, never patch |

## Scope ladder (cut order at T-60, top to bottom)

1. Keep: alerts feed + Telegram bot + triage + offline queue + deploy
2. Cut: Odia translations (ship English-only strings)
3. Cut: ReliefWeb, IMD scrape (keep one feed: GDACS)
4. Cut: auto digest broadcast (manual "Send digest" button)
5. Never cut: offline queue flush + triage card — those are the demo
