# RULES — SachetSathi

> The contract for this repo. Actions that break a rule here are reverted, not debated. The agent (me/you) follows these without exceptions unless the user explicitly amends this file in-session.

## 1. What to use — approved set only
- **Backend:** Python 3.11, FastAPI, uvicorn, pydantic, python-telegram-bot, google-genai (Gemini/Gemma API), requests or httpx, apscheduler (simple cron).
- **Data:** sqlite3 (stdlib), fixture JSON files in `fixtures/`.
- **Frontend:** vanilla HTML/CSS/JS, native service worker, `manifest.json`. No framework, no bundler.
- **Testing:** pytest (small, focused — triage schema, alerts parser, API health).
- **Infra:** Dockerfile + docker-compose; Render / DigitalOcean App Platform for deploy.
- **Anything not on this list ⇒ ask the user first.** One yes-and-later beats a half-unknown dependency.

## 2. Preferred patterns
- Use `telegram-send-demo` (Gaurav5189) as the reference for the Telegram send/poll plumbing.
- Strict-JSON LLM calls: prompt demands JSON only → validate with a Pydantic model → on failure retry once with a stricter instruction → else fallback (below).
- Every external call has: a timeout (≤15 s), a retry (≤1), and a fallback path (fixture/cached/canned).
- Secrets only via `.env`; `.env.example` documented in README.
- No secrets in git, ever; check `git status` before push.

## 3. Error-handling guidelines (mandatory, not optional)
| Case | Required behavior |
|---|---|
| Feed fetch fails/timeouts | Log warning, fall back to last cached/fixture alerts, mark source `stale` in response |
| Gemma output invalid JSON / wrong enum | Retry once stricter → else rule-based fallback severity (keyword match) and set `triage="fallback"` flag |
| Telegram send fails | Queue in `outbox` table, retry next poll cycle; never raise into the request path |
| DB insert conflict | Upsert by natural key; never crash the poller |
| Unknown/unhandled route or upstream | JSON error with `error` + `hint`; HTTP status kept accurate |
| Frontend fetch fails | Show inline banner "cached data"; offline queue continues to work |

**Anti-patterns (auto-reject in reviews/diffs):** bare `except: pass`; swallowing exceptions in the bot loop; letting one bad photo message kill the poller; crashing the app because an external service is down.

## 4. AI boundaries / constraints
- The model **outputs data only** (strict JSON incident card). It does not send messages, mutate DB, choose UI behavior, or call tools.
- No model-generated content displayed as **official data**. Alerts must be traceable to a real source; AI text goes in `odia_summary`/`next_action` fields of cards, visually labeled `AI-assisted`.
- Prompt history and model calls are logged (model id, latency, token-less cost estimate) — demo honesty.
- The model must not be asked for factual data it can't have (coordinates of real shelters, live numbers).
- **Honest AI disclosure in README** (what AI did: triage structure + Odia phrasing; what humans/data did: feeds, messages, decisions).
- No auto-remediation: if triage is `fallback`, the card is visually marked and the human (coordinator) decides priority bump via UI filter.

## 5. What to avoid
| Avoid | Why |
|---|---|
| Unapproved libraries (LangChain, heavy monoliths, new ORMs mid-build) | Setup time + surprise deps; 3–4 h budget can't absorb it |
| Poor error handling (see §3 blockers) | Judges and the build loop both die on this |
| AI making decisions outside its scope | Emits JSON; never the sender of messages or the parser of official feeds |
| Framework/bundler changes mid-build | stability risk; vanilla JS ships at 100% |
| Fake "live data" presented as real | Fixture data only via `demo=1`/`DEMO_MODE` flags — stated honestly |
| Committing `.env`, tokens, keys | will revoke a bot token and the demo with it |
| Scope creep before P5 | See PLAN.md scope ladder |
