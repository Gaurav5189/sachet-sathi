"""REST surface (ARCHITECTURE §API surface). Routers grow phase by phase."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from app.alerts import AlertsService
from app.digest import build_digest, send_digest
from app.models import Database
from app.telegram import TelegramClient
from app.triage import TriageService

logger = logging.getLogger("sachet.api")

router = APIRouter(prefix="/api", tags=["sachet"])


@router.get("/alerts")
def get_alerts(
    request: Request,
    demo: bool | None = Query(None, description="Replay the stored fixture instead of fetching"),
    refresh: bool = Query(False, description="Bypass the 60 s cache and pull now"),
    severity: str | None = Query(None, pattern="^(low|moderate|severe)$"),
    source: str | None = None,
    relevant: bool = Query(False, description="Only alerts for the Odisha/Bay-of-Bengal area"),
    limit: int = Query(50, ge=1, le=200),
) -> JSONResponse:
    """Latest official alerts, severity-sorted. `stale`/`demo` tell the truth."""
    service: AlertsService = request.app.state.alerts
    try:
        feed = service.feed(
            demo=demo,
            force=refresh,
            severity=severity,
            source=source,
            relevant_only=relevant,
            limit=limit,
        )
    except FileNotFoundError as exc:
        logger.error("alert fixture missing: %s", exc)
        return JSONResponse(
            status_code=503,
            content={
                "error": "fixture_missing",
                "hint": "Run `python scripts/snapshot_gdacs.py` to create fixtures/gdacs-sample.json.",
            },
        )
    return JSONResponse(content=feed.to_payload())


@router.get("/incidents")
def get_incidents(
    request: Request,
    severity: str | None = Query(None, pattern="^(low|moderate|severe)$"),
    status: str | None = Query(None, pattern="^(pending|triaged|sent)$"),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    """Triaged (and pending) field reports, severity-sorted."""
    db: Database = request.app.state.db
    incidents = db.list_incidents(status=status, severity=severity, limit=limit)
    return {"incidents": incidents, "count": len(incidents)}


@router.post("/incidents/{incident_id}/triage")
async def post_triage(
    request: Request, incident_id: int, force: bool = False
) -> JSONResponse:
    """Run (or re-run) triage on one incident — the dashboard's 'retry' button."""
    triage: TriageService = request.app.state.triage
    if not triage.available:
        return JSONResponse(
            status_code=503,
            content={
                "error": "triage_not_configured",
                "hint": "Set GEMINI_API_KEY in .env to enable Gemma triage.",
            },
        )
    try:
        card = await triage.triage_incident(incident_id, force=force)
    except KeyError:
        return JSONResponse(
            status_code=404,
            content={
                "error": "incident_not_found",
                "hint": f"No incident #{incident_id}. List them at /api/incidents.",
            },
        )
    return JSONResponse(content=card)


@router.get("/telegram/bot")
async def telegram_bot(request: Request) -> JSONResponse:
    """Bot identity for the dashboard's "report via @bot" link (demo pattern)."""
    client: TelegramClient = request.app.state.telegram
    if not client.configured:
        return JSONResponse(
            status_code=503,
            content={
                "error": "telegram_not_configured",
                "hint": "Set TELEGRAM_BOT_TOKEN in .env (create the bot with @BotFather).",
            },
        )
    try:
        me = await client.get_me()
    except Exception as exc:  # noqa: BLE001 - upstream failure, accurate status
        return JSONResponse(
            status_code=503,
            content={
                "error": "telegram_unreachable",
                "hint": f"Bot API call failed ({exc}). Check outbound network to api.telegram.org.",
            },
        )
    username = me.get("username") or ""
    return JSONResponse(
        content={
            "username": username,
            "name": me.get("first_name") or "",
            "deep_link": f"https://t.me/{username}" if username else "",
        }
    )


@router.get("/digest/preview")
def digest_preview(
    request: Request,
    demo: bool | None = None,
    limit: int = Query(3, ge=1, le=10),
) -> dict[str, Any]:
    """The exact text the channel would receive — no send, no side effects."""
    digest = build_digest(
        request.app.state.db, request.app.state.alerts, limit_incidents=limit, demo=demo
    )
    return {
        "text": digest.text,
        "incidents": len(digest.incident_ids),
        "alert_id": digest.alert_id,
        "demo": digest.demo,
        "stale": digest.stale,
    }


@router.post("/digest")
async def post_digest(
    request: Request,
    demo: bool | None = None,
    limit: int = Query(3, ge=1, le=10),
) -> JSONResponse:
    """Post the digest to the channel. On send failure it is parked in `outbox`."""
    settings = request.app.state.settings
    if not settings.telegram_channel_id:
        return JSONResponse(
            status_code=409,
            content={
                "error": "channel_not_configured",
                "hint": "Set TELEGRAM_CHANNEL_ID (and TELEGRAM_BOT_TOKEN) in .env, then retry.",
            },
        )
    client: TelegramClient = request.app.state.telegram
    result = await send_digest(
        request.app.state.db,
        client,
        request.app.state.alerts,
        chat_id=settings.telegram_channel_id,
        limit_incidents=limit,
        demo=demo,
    )
    return JSONResponse(status_code=200 if result["sent"] else 202, content=result)
