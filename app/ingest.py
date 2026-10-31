"""Telegram ingest: long-poll `getUpdates` → incident row → ack.

No webhooks (ARCHITECTURE key decisions): long polling needs no public URL,
which is the difference between working at 11:30 and debugging TLS at 14:00.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings
from app.models import Database
from app.telegram import TelegramClient, deliver, flush_outbox

logger = logging.getLogger("sachet.ingest")

WELCOME = (
    "<b>SachetSathi</b> — cyclone field reports.\n\n"
    "Send a <b>photo</b> with an optional caption (what you see, where).\n"
    "Example: <i>“NH-16 flooded near Barang, water up to knee”</i>\n\n"
    "You get an incident number back. Coordinators see the triaged card."
)
HINT = "Send a photo (with an optional caption) or a short text report."
NO_PHOTO_MODE = "photo_missing"

# Callback data → the status line written back into the digest.
CALLBACK_LABELS = {
    "digest_ack": "Acknowledged",
    "digest_escalate": "Escalated",
}
CALLBACK_ICONS = {"digest_ack": "✅", "digest_escalate": "⏰"}
STATUS_SEPARATOR = "\n\n— "


@dataclass
class IngestOutcome:
    incident_id: int | None = None
    report_id: str | None = None
    replied: bool = False
    note: str = ""


def _report_id(chat_id: int | str, message_id: int) -> str:
    """Natural key: one Telegram message = one report, even if replayed."""
    return f"tg:{chat_id}:{message_id}"


async def _store_photo(client: TelegramClient, settings: Settings, photo: dict[str, Any]) -> str | None:
    unique_id = photo.get("file_unique_id") or photo.get("file_id")
    if not unique_id:
        return None
    target = settings.photos_dir / f"{unique_id}.jpg"
    if target.exists():  # replayed update — don't download twice
        return str(target)
    try:
        data = await client.download_file(photo["file_id"])
    except Exception as exc:  # noqa: BLE001 - a report without its photo still matters
        logger.warning("photo download failed for %s: %s", unique_id, exc)
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return str(target)


async def handle_update(
    update: dict[str, Any],
    *,
    db: Database,
    client: TelegramClient,
    settings: Settings,
) -> IngestOutcome:
    """One Telegram update → one incident (or one digest decision)."""
    if update.get("callback_query"):
        return await handle_callback(
            update["callback_query"], db=db, client=client, settings=settings
        )

    message = update.get("message")
    if not message:
        return IngestOutcome(note="ignored: not a message")

    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    message_id = message.get("message_id")
    sender = message.get("from") or {}
    text = (message.get("caption") or message.get("text") or "").strip()
    photos = message.get("photo") or []

    if chat_id is None or message_id is None:
        return IngestOutcome(note="ignored: no chat/message id")

    if text.startswith("/start") or text.startswith("/help"):
        replied = await deliver(db, client, chat_id=chat_id, kind="ack", text=WELCOME)
        return IngestOutcome(replied=replied, note="welcome")

    if not photos and not text:
        replied = await deliver(db, client, chat_id=chat_id, kind="ack", text=HINT)
        return IngestOutcome(replied=replied, note="hint: nothing usable")

    photo_path = None
    if photos:
        # Telegram sends several sizes; the last one is the largest.
        largest = max(photos, key=lambda p: p.get("file_size") or p.get("width") or 0)
        photo_path = await _store_photo(client, settings, largest)

    report_id = _report_id(chat_id, message_id)
    incident_id = db.create_incident(
        report_id=report_id,
        reporter_tg_id=sender.get("id"),
        photo_path=photo_path,
        caption=text,
    )
    if sender.get("id") is not None:
        db.upsert_reporter(int(sender["id"]), str(sender.get("first_name") or ""))

    ack = (
        f"✅ Report <b>#{incident_id}</b> received"
        f"{'' if photo_path else ' (text only)'}.\n"
        "It is queued for triage; coordinators see it on the dashboard."
    )
    replied = await deliver(db, client, chat_id=chat_id, kind="ack", text=ack)
    logger.info(
        "ingest report=%s incident=%s photo=%s replied=%s",
        report_id,
        incident_id,
        bool(photo_path),
        replied,
    )
    return IngestOutcome(
        incident_id=incident_id,
        report_id=report_id,
        replied=replied,
        note="stored",
    )


async def handle_callback(
    query: dict[str, Any],
    *,
    db: Database,
    client: TelegramClient,
    settings: Settings,
) -> IngestOutcome:
    """Digest button tap: acknowledge it, edit the post, drop the keyboard.

    Mirrors telegram-send-demo `replaceNotificationStatus`: a tap that is never
    answered leaves the coordinator's client spinning for ~30 s, and a keyboard
    left in place invites a second, contradictory tap.
    """
    callback_id = query.get("id")
    data = query.get("data") or ""
    actor = (query.get("from") or {}).get("first_name") or "a coordinator"

    if callback_id:
        # Always answer, even for data we don't recognise.
        try:
            await client.answer_callback_query(
                callback_id, CALLBACK_LABELS.get(data, "Noted")
            )
        except Exception as exc:  # noqa: BLE001 - never let a tap kill the poller
            logger.warning("answerCallbackQuery failed: %s", exc)

    if data not in CALLBACK_LABELS:
        logger.info("ignoring unknown callback data %r", data)
        return IngestOutcome(note="callback: unknown")

    message = query.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    message_id = message.get("message_id")
    original = message.get("text") or ""
    if chat_id is None or message_id is None or not original:
        logger.warning("callback %r has no editable message; skipping edit", data)
        return IngestOutcome(note="callback: not editable")

    # Strip a status left by an earlier tap before appending the new one.
    base = original.split(STATUS_SEPARATOR)[0]
    status = f"{CALLBACK_LABELS[data]} by {actor} {CALLBACK_ICONS[data]}"
    try:
        await client.edit_message_text(
            chat_id,
            message_id,
            f"{base}{STATUS_SEPARATOR}{status}",
            reply_markup={"inline_keyboard": []},
        )
    except Exception as exc:  # noqa: BLE001 - "message is not modified" is harmless
        logger.debug("could not edit digest message: %s", exc)

    db.set_state(f"digest_decision:{message_id}", f"{data}:{actor}")
    logger.info("digest %s %s by %s", message_id, CALLBACK_LABELS[data].lower(), actor)
    return IngestOutcome(note=f"callback: {CALLBACK_LABELS[data].lower()}")


async def poll_forever(
    *,
    db: Database,
    client: TelegramClient,
    settings: Settings,
    stop: asyncio.Event,
) -> None:
    """The bot loop. One bad update must never end it (RULES §3)."""
    stored_offset = db.get_state("telegram_offset")
    offset = int(stored_offset) + 1 if stored_offset else None
    logger.info("telegram poller started (offset=%s)", offset)

    while not stop.is_set():
        try:
            updates = await client.get_updates(offset)
        except Exception as exc:  # noqa: BLE001 - network, 401, 409: retry, never die
            logger.warning("getUpdates failed: %s — retrying in 3s", exc)
            await asyncio.sleep(3)
            continue

        for update in updates:
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                offset = update_id + 1
            try:
                await handle_update(update, db=db, client=client, settings=settings)
            except Exception:  # noqa: BLE001
                logger.exception("update %s failed; continuing", update_id)
            if isinstance(update_id, int):
                db.set_state("telegram_offset", str(update_id))

        try:
            await flush_outbox(db, client)
        except Exception:  # noqa: BLE001
            logger.exception("outbox flush failed; will retry next cycle")

        if not updates:
            # Long polling normally blocks; this keeps a misbehaving API from
            # turning the loop into a hot spin.
            await asyncio.sleep(0.2)

    logger.info("telegram poller stopped")
