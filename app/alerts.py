"""Alerts pipeline: GDACS RSS → validated alerts → sqlite, with fixture fallback.

Fixture-first (RULES §3): the parser is written against `fixtures/gdacs-sample.xml`
and the live fetch is a thin wrapper around it. If the network dies mid-demo,
`DEMO_MODE=1` replays the stored JSON and the response says so.
"""

from __future__ import annotations

import json
import logging
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from app.config import FIXTURES_DIR, Settings
from app.models import Database, utcnow

logger = logging.getLogger("sachet.alerts")

GDACS_NS = {"gdacs": "http://www.gdacs.org"}
GEO_NS = {"geo": "http://www.w3.org/2003/01/geo/wgs84_pos#"}
FIXTURE_JSON = FIXTURES_DIR / "gdacs-sample.json"

Severity = Literal["low", "moderate", "severe"]
SEVERITY_BY_LEVEL = {"red": "severe", "orange": "moderate", "green": "low"}
SEVERITY_RANK = {"severe": 0, "moderate": 1, "low": 2}
CACHE_TTL_SECONDS = 60.0

# Bay of Bengal + Arabian Sea approach to the Odisha coast.
SOUTH_ASIA_BOX = (5.0, 25.0, 60.0, 100.0)  # lat_min, lat_max, lon_min, lon_max
RELEVANT_EVENT_TYPES = {"TC", "FL", "DR"}


def is_relevant(area: str, event_type: str, lat: float | None, lon: float | None) -> bool:
    """Is this alert about *our* coast? GDACS is global; the demo is not.

    Deterministic and explainable — no model involved (RULES §4).
    """
    if "india" in (area or "").lower():
        return True
    if lat is None or lon is None or event_type not in RELEVANT_EVENT_TYPES:
        return False
    lat_min, lat_max, lon_min, lon_max = SOUTH_ASIA_BOX
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


class Alert(BaseModel):
    """One official alert. Every field is traceable to the feed — no invention."""

    id: str
    source: str = "gdacs"
    source_label: str = "GDACS"
    event_type: str = ""
    event_name: str = ""
    alert_level: str = ""
    severity: Severity
    area: str = ""
    headline: str = Field(min_length=1)
    body: str = ""
    url: str = ""
    glide: str = ""
    lat: float | None = None
    lon: float | None = None
    observed_at: str | None = None
    updated_at: str | None = None
    expires_at: str | None = None
    is_current: bool = True
    is_relevant: bool = False
    fetched_at: str = Field(default_factory=utcnow)
    stale: bool = False

    @field_validator("severity", mode="before")
    @classmethod
    def _normalise_severity(cls, value: Any) -> Any:
        if isinstance(value, str):
            lowered = value.strip().lower()
            return SEVERITY_BY_LEVEL.get(lowered, lowered)
        return value

    @model_validator(mode="after")
    def _derive_relevance(self) -> "Alert":
        # Always derived from source fields, never trusted from input.
        self.is_relevant = is_relevant(self.area, self.event_type, self.lat, self.lon)
        return self

    def to_row(self) -> dict[str, Any]:
        row = self.model_dump()
        row["is_current"] = 1 if self.is_current else 0
        row["stale"] = 1 if self.stale else 0
        return row


@dataclass
class AlertFeed:
    alerts: list[Alert]
    source: str = "gdacs"
    stale: bool = False
    demo: bool = False
    fetched_at: str = field(default_factory=utcnow)
    note: str = ""

    def to_payload(self) -> dict[str, Any]:
        return {
            "alerts": [a.model_dump() for a in self.alerts],
            "count": len(self.alerts),
            "source": self.source,
            "stale": self.stale,
            "demo": self.demo,
            "fetched_at": self.fetched_at,
            "note": self.note,
        }


def _text(node: ET.Element, tag: str, ns: dict[str, str] | None = None) -> str:
    found = node.find(tag, ns or {})
    return (found.text or "").strip() if found is not None and found.text else ""


def _iso(raw: str) -> str | None:
    """RFC-822 feed timestamp → ISO-8601 UTC. Bad input never breaks the poller."""
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw).astimezone(timezone.utc).isoformat()
    except (TypeError, ValueError):
        logger.warning("unparsable feed timestamp: %r", raw)
        return None


def parse_gdacs(xml_text: str | bytes) -> list[Alert]:
    """Parse a GDACS RSS document into alerts. Raises ValueError if it isn't RSS."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise ValueError(f"not a valid XML document: {exc}") from exc

    channel = root.find("channel")
    if channel is None:
        raise ValueError("RSS document has no <channel>")

    alerts: list[Alert] = []
    for item in channel.findall("item"):
        event_type = _text(item, "gdacs:eventtype", GDACS_NS)
        event_id = _text(item, "gdacs:eventid", GDACS_NS)
        headline = _text(item, "title")
        if not event_type or not event_id or not headline:
            logger.warning("skipping incomplete GDACS item (missing type/id/title)")
            continue

        lat = _text(item, ".//geo:lat", GEO_NS)
        lon = _text(item, ".//geo:long", GEO_NS)
        try:
            alert = Alert(
                id=f"gdacs:{event_type}{event_id}",
                event_type=event_type,
                event_name=_text(item, "gdacs:eventname", GDACS_NS),
                alert_level=_text(item, "gdacs:alertlevel", GDACS_NS).lower(),
                severity=_text(item, "gdacs:alertlevel", GDACS_NS).lower() or "green",
                area=_text(item, "gdacs:country", GDACS_NS),
                headline=headline,
                body=_text(item, "description"),
                url=_text(item, "link"),
                glide=_text(item, "gdacs:glide", GDACS_NS),
                lat=float(lat) if lat else None,
                lon=float(lon) if lon else None,
                observed_at=_iso(_text(item, "pubDate")),
                updated_at=_iso(_text(item, "gdacs:datemodified", GDACS_NS)),
                expires_at=_iso(_text(item, "gdacs:todate", GDACS_NS)),
                is_current=_text(item, "gdacs:iscurrent", GDACS_NS).lower() != "false",
            )
        except ValidationError as exc:
            logger.warning("dropping invalid GDACS item %s: %s", event_id, exc)
            continue
        alerts.append(alert)

    return alerts


class AlertsService:
    """Fetch → parse → store, with an in-memory cache and a fixture floor."""

    def __init__(self, settings: Settings, db: Database, ttl: float = CACHE_TTL_SECONDS) -> None:
        self.settings = settings
        self.db = db
        self.ttl = ttl
        self._cache: AlertFeed | None = None
        self._cached_at: float = 0.0

    # ---- public -----------------------------------------------------------
    def feed(
        self,
        *,
        demo: bool | None = None,
        force: bool = False,
        severity: str | None = None,
        source: str | None = None,
        relevant_only: bool = False,
        limit: int = 50,
    ) -> AlertFeed:
        demo = self.settings.demo_mode if demo is None else demo
        feed = self._resolve(demo=demo, force=force)
        alerts = feed.alerts
        if severity:
            alerts = [a for a in alerts if a.severity == severity]
        if source:
            alerts = [a for a in alerts if a.source == source]
        if relevant_only:
            alerts = [a for a in alerts if a.is_relevant]
        # Freshest first, then stable-sort by severity and local relevance.
        alerts = sorted(alerts, key=lambda a: a.observed_at or "", reverse=True)
        alerts = sorted(
            alerts, key=lambda a: (SEVERITY_RANK[a.severity], 0 if a.is_relevant else 1)
        )
        alerts = alerts[:limit]
        return AlertFeed(
            alerts=alerts,
            source=feed.source,
            stale=feed.stale,
            demo=feed.demo,
            fetched_at=feed.fetched_at,
            note=feed.note,
        )

    def refresh(self) -> AlertFeed:
        """Force a live pull — used by the poller and the demo 'refresh' button."""
        return self._resolve(demo=False, force=True)

    # ---- internals --------------------------------------------------------
    def _resolve(self, *, demo: bool, force: bool) -> AlertFeed:
        if demo:
            return self._from_fixture(note="DEMO_MODE: replaying a stored GDACS snapshot, not live data.")

        fresh = self._cache is not None and (time.monotonic() - self._cached_at) < self.ttl
        if fresh and not force and self._cache is not None:
            return self._cache

        try:
            feed = self._fetch_live()
        except Exception as exc:  # noqa: BLE001 - every upstream failure has a fallback (RULES §3)
            logger.warning("GDACS fetch failed (%s: %s) — falling back", type(exc).__name__, exc)
            feed = self._fallback(reason=f"{type(exc).__name__}: {exc}")

        self._cache, self._cached_at = feed, time.monotonic()
        return feed

    def _fetch_live(self) -> AlertFeed:
        response = httpx.get(
            self.settings.gdacs_rss_url,
            timeout=self.settings.feed_timeout_seconds,
            follow_redirects=True,
            headers={"User-Agent": "SachetSathi/0.1 (+https://github.com/Gaurav5189/sachet-sathi)"},
        )
        response.raise_for_status()
        alerts = parse_gdacs(response.content)
        if not alerts:
            raise ValueError("feed parsed but contained no usable items")

        now = utcnow()
        for alert in alerts:
            alert.fetched_at, alert.stale = now, False
        self.db.upsert_alerts(a.to_row() for a in alerts)
        logger.info("GDACS refresh ok: %d alerts", len(alerts))
        return AlertFeed(
            alerts=alerts,
            fetched_at=now,
            note="Live GDACS RSS.",
        )

    def _fallback(self, *, reason: str) -> AlertFeed:
        """Last known DB rows first, stored fixture second. Never an empty screen."""
        rows = self.db.list_alerts(limit=50)
        if rows:
            alerts = [Alert.model_validate({**row, "stale": True, "is_current": bool(row["is_current"])}) for row in rows]
            logger.info("serving %d cached alerts as stale", len(alerts))
            return AlertFeed(
                alerts=alerts,
                stale=True,
                fetched_at=alerts[0].fetched_at,
                note=f"Live fetch failed ({reason}); serving last cached alerts — treat as stale.",
            )
        return self._from_fixture(
            note=f"Live fetch failed ({reason}); serving the stored fixture — not live data.",
            stale=True,
        )

    def _from_fixture(self, *, note: str, stale: bool = False) -> AlertFeed:
        payload = json.loads(FIXTURE_JSON.read_text(encoding="utf-8"))
        alerts: list[Alert] = []
        for raw in payload.get("alerts", []):
            try:
                alerts.append(Alert.model_validate(raw))
            except ValidationError as exc:
                logger.warning("skipping invalid fixture alert %s: %s", raw.get("id"), exc)
        return AlertFeed(
            alerts=alerts,
            stale=stale,
            demo=True,
            fetched_at=payload.get("generated_at") or utcnow(),
            note=note,
        )
