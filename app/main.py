"""FastAPI app factory.

Phase 0 scope: boot + `/api/health`. Routers land here as they are built
(alerts → ingest → triage → digest → api), keeping one obvious entrypoint.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.alerts import AlertsService
from app.api import WEB_DIR, router as api_router
from app.config import Settings, get_settings
from app.ingest import poll_forever
from app.models import Database
from app.telegram import TelegramClient
from app.triage import TriageService

logger = logging.getLogger("sachet")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
# httpx logs full request URLs at INFO — and the Bot API URL contains the token.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def create_app(
    settings: Settings | None = None,
    telegram_client: TelegramClient | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    settings.ensure_dirs()

    db = Database(settings.sqlite_path)
    db.init()
    client = telegram_client or TelegramClient(
        settings.telegram_bot_token, api_root=settings.telegram_api_root
    )
    triage = TriageService(settings, db)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logger.info(
            "boot env=%s demo_mode=%s data_dir=%s db=%s telegram=%s channel=%s ai=%s",
            settings.app_env,
            settings.demo_mode,
            settings.data_dir,
            settings.sqlite_path,
            "on" if settings.telegram_token_ready() else "off",
            "on" if settings.telegram_channel_ready() else "off",
            "on" if settings.ai_ready() else "off",
        )
        stop = asyncio.Event()
        poller: asyncio.Task[None] | None = None
        if settings.telegram_token_ready():
            poller = asyncio.create_task(
                poll_forever(db=db, client=client, settings=settings, stop=stop, triage=triage),
                name="telegram-poller",
            )
        else:
            logger.info("telegram poller idle (no bot token)")
        app.state.poller = poller
        if not settings.telegram_channel_ready():
            logger.warning("TELEGRAM_CHANNEL_ID is empty — digests cannot be posted yet")
        try:
            yield
        finally:
            stop.set()
            if poller is not None:
                poller.cancel()
                try:
                    await poller
                except asyncio.CancelledError:
                    pass
                except Exception:  # noqa: BLE001 - shutdown is best-effort
                    logger.exception("poller shutdown raised")
            await client.aclose()

    app = FastAPI(
        title="SachetSathi",
        version=__version__,
        description=(
            "Cyclone field assistant: official alerts + Telegram field reports + "
            "Gemma triage + offline-capable PWA."
        ),
        lifespan=lifespan,
    )

    app.state.settings = settings
    app.state.db = db
    app.state.alerts = AlertsService(settings, db)
    app.state.telegram = client
    app.state.triage = triage
    # Ship the shell compressed: the PWA budget (LCP < 2 s on slow 3G) assumes
    # gzipped assets, and App Platform/CDNs re-compress anyway. Stdlib only.
    app.add_middleware(GZipMiddleware, minimum_size=500)
    app.include_router(api_router)

    @app.get("/api/health")
    async def health() -> dict:
        """Liveness + capability probe. The demo script calls this first."""
        return {
            "status": "ok",
            "app": "SachetSathi",
            "version": __version__,
            "phase": "p2-telegram",
            "time": _now(),
            "demo_mode": settings.demo_mode,
            "capabilities": {
                "telegram": settings.telegram_token_ready(),
                "telegram_channel": settings.telegram_channel_ready(),
                "gemma": settings.ai_ready(),
            },
            "alerts_cached": db.count_alerts(),
        }

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        """RULES §3: a rejected body must say *what* to fix, not just 422."""
        fields = [
            {
                "field": ".".join(str(part) for part in error.get("loc", ()) if part != "body"),
                "problem": error.get("msg", "invalid"),
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": "invalid_request",
                "hint": "Fix the listed fields and retry. See /docs for the schema.",
                "fields": fields,
            },
        )

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        """RULES §3: never a bare 500 without a machine-readable body."""
        logger.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_error",
                "hint": "Check server logs; retry once. If it persists, the upstream "
                "dependency may be down.",
            },
        )

    # The PWA is served from the same origin (no CORS, no second deploy) and at
    # "/" so the service worker's scope covers the whole app. Mounted last so
    # /api/* and /docs win.
    if (WEB_DIR / "index.html").is_file():
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    else:

        @app.get("/")
        async def root() -> dict:
            return {
                "app": "SachetSathi",
                "version": __version__,
                "health": "/api/health",
                "docs": "/docs",
                "note": "web/ is missing from this build; the API still works.",
            }

    return app


app = create_app()
