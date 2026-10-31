"""REST surface (ARCHITECTURE §API surface). Routers grow phase by phase."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from app.alerts import AlertsService

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
