"""Digest: freshest official alert + top triaged field reports → Telegram channel.

Manual trigger first (PLAN scope ladder rung 4); cron is a stretch item.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from app.alerts import AlertsService
from app.models import Database
from app.telegram import TelegramClient, deliver

logger = logging.getLogger("sachet.digest")

IST = timezone(timedelta(hours=5, minutes=30))
SEVERITY_ICON = {"severe": "🔴", "moderate": "🟠", "low": "🟢"}
CATEGORY_LABEL = {
    "flood": "FLOOD",
    "damage": "DAMAGE",
    "supply": "SUPPLY",
    "medical": "MEDICAL",
    "other": "REPORT",
}

# Inline keyboard from the telegram-send-demo pattern (AGENT.md §4.2):
# the tap is acknowledged, the message is edited in place, keyboard removed.
DIGEST_KEYBOARD = {
    "inline_keyboard": [
        [
            {"text": "Acknowledge ✅", "callback_data": "digest_ack"},
            {"text": "Escalate ⏰", "callback_data": "digest_escalate"},
        ]
    ]
}


def _clip(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


@dataclass
class Digest:
    text: str
    incident_ids: list[int] = field(default_factory=list)
    alert_id: str | None = None
    demo: bool = False
    stale: bool = False


def build_digest(
    db: Database,
    alerts_service: AlertsService,
    *,
    limit_incidents: int = 3,
    demo: bool | None = None,
) -> Digest:
    feed = alerts_service.feed(demo=demo, relevant_only=True, limit=1)
    alert = feed.alerts[0] if feed.alerts else None

    incidents = [
        i for i in db.list_incidents(status="triaged", limit=limit_incidents) if i["severity"]
    ]

    now = datetime.now(IST)
    lines = [f"<b>🌀 SACHETSATHI DIGEST</b> — {now:%d %b %Y, %H:%M} IST", ""]

    if alert:
        icon = SEVERITY_ICON.get(alert.severity, "⚪")
        where = f" — {alert.area}" if alert.area else ""
        lines += [
            f"{icon} <b>OFFICIAL: {_clip(alert.event_name or alert.event_type, 40)}{where}</b>",
            _clip(alert.headline, 220),
        ]
        provenance = "GDACS"
        if feed.demo:
            provenance += " · fixture replay (not live)"
        elif feed.stale:
            provenance += " · cached, stale"
        lines.append(f"<i>{provenance}</i>")
    else:
        lines.append("⚪ <b>OFFICIAL:</b> no current alert for this area.")

    lines += ["", f"<b>FIELD REPORTS</b> ({len(incidents)})"]
    if not incidents:
        lines.append("No triaged reports yet.")
    for index, incident in enumerate(incidents, start=1):
        icon = SEVERITY_ICON.get(incident["severity"] or "low", "⚪")
        category = CATEGORY_LABEL.get(incident["category"] or "other", "REPORT")
        summary = _clip(incident["caption"] or "no caption", 110)
        lines.append(f"{index}. {icon} <b>{category}</b> — {summary}")
        if incident.get("next_action"):
            lines.append(f"   → {_clip(incident['next_action'], 130)} <i>(AI-assisted)</i>")
        if incident.get("photo_path"):
            lines.append("   📷 photo on dashboard")

    lines += [
        "",
        "<i>Triage text is AI-assisted (Gemma) and reviewed by a human before action.</i>",
        "<i>Official alerts are quoted from the source feed.</i>",
    ]

    return Digest(
        text="\n".join(lines),
        incident_ids=[int(i["id"]) for i in incidents],
        alert_id=alert.id if alert else None,
        demo=feed.demo,
        stale=feed.stale,
    )


async def send_digest(
    db: Database,
    client: TelegramClient,
    alerts_service: AlertsService,
    *,
    chat_id: str | None,
    limit_incidents: int = 3,
    demo: bool | None = None,
) -> dict[str, Any]:
    """Build and post. Incidents are only marked `sent` once the post lands."""
    if not chat_id:
        raise ValueError("TELEGRAM_CHANNEL_ID is not set")

    digest = build_digest(db, alerts_service, limit_incidents=limit_incidents, demo=demo)
    delivered = await deliver(
        db,
        client,
        chat_id=chat_id,
        kind="digest",
        text=digest.text,
        reply_markup=DIGEST_KEYBOARD,
    )

    if delivered:
        db.mark_incidents_sent(digest.incident_ids)
    else:
        logger.warning("digest parked in outbox; incidents stay triaged until it lands")

    return {
        "sent": delivered,
        "queued": not delivered,
        "chat_id": chat_id,
        "incidents": len(digest.incident_ids),
        "alert_id": digest.alert_id,
        "demo": digest.demo,
        "stale": digest.stale,
        "text": digest.text,
    }
