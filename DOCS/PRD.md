# PRD — SachetSathi

## 1. Overview
A disaster field-ops assistant for the cyclone affecting coastal Odisha (event date: Oct 31, 2026). It makes official alert data consumable by ordinary people, and turns raw ground reports (photo + text) into structured, triaged incident cards using an open-weight model (Gemma, via Gemini API). Delivery is via Telegram (no install needed for receivers) and a PWA (works offline).

Built for **Hacktoberfest Hack Day Bhubaneswar x DatrixLabs**, entering:
- **Best Open-Source AI Project** (DigitalOcean) — open-weight AI load-bearing + DO deployment
- **Best Use of Gemma 4** — Gemma 4 via Gemini API as the triage engine

## 2. Problem
Official IMD bulletins are PDFs/web pages meant for officials. Ground conditions (flooded road, damaged shelter, downed tree) are reported as unstructured chat photos that rescue teams can't queue or search. During network loss, everything stops. Nothing joins official alerts → field situation → actionable cards.

## 3. Target users
- **Primary: field reporters** — any citizen, NCC/NSV volunteer, or local youth with a phone: files reports via the Telegram bot in <30 seconds.
- **Community channel members** — people following the district's Telegram channel during the cyclone; they read digests, no install.
- **Volunteer coordinators / ODRAF-facing** — the dashboard's structured card list is what a coordinator reviews and distributes.
- **Judge persona** — in 2 minutes must *see* real data, a real triage, and a real offline queue.

## 4. Features (MVP — must ship)
| # | Feature | Notes |
|---|---|---|
| F1 | **Live alerts feed** | Poll GDACS RSS + IMD bulletin text; render as alert cards with severity color, area, expiry |
| F2 | **Telegram ingest** | Reporters send photo (+optional text/hashtags) to bot; stored as pending incident |
| F3 | **Gemma triage** | Photo+text → strict-JSON card: `severity (low/moderate/severe)`, `category (flood/damage/supply/medical/other)`, `odia_summary`, `next_action`, `priority` |
| F4 | **Dashboard (PWA)** | Alert cards + incident cards, filter by severity/category, installable PWA |
| F5 | **Telegram digest out** | Server sends digest (top incidents + freshest official alert) to channel |
| F6 | **Offline queue** | PWA stores safety pack (contacts, do/don'ts in IndexedDB); offline reports queue and flush via "send now" when back online |

## 5. Stretch features (add only in feature-freeze gaps — never before P5)
- Odia translations of UI strings
- ReliefWeb "situational reports" feed
- Auto-digest cron (vs manual button)
- Report photo mark-up (severity badge overlay)

## 6. Out of scope (say no, visibly, in README)
- Local on-device model inference (network model inference only; documented as a trade-off)
- User accounts / login (Telegram bot user ID *is* identity)
- Push notifications (Telegram channel does the pushing)
- Also any destructive/moderation features — single friendly bot.

## 7. Success criteria (judging-aligned)
- Real, current official alerts visible at demo time (or fixture replay with flag)
- Full report→triage→digest round-trip <60 s on stage
- Offline report filed + flushed in <2 min demo segment
- Clean clone → `docker compose up` → working app (judges' "does it build?" bar)
- Honest AI disclosure + limitations section

## 8. Assumptions
- Gemini API free tier suffices for demo volumes (~tens of calls).
- OSDMA shelter/contacts data can be seeded as static JSON (no live API) — snapshot from public pages.
- Telegram demo token from `telegram-send-demo` is reused; fresh bot token is a 2-min fallback.
